"""Daily refresh of the tracked symbols (table ``tracked_symbols``).

Runs once a day on AWS Batch (see ``infra-batch/``), and locally against the
Docker Postgres::

    DATABASE_URL=postgresql://bncd_admin:localdev@127.0.0.1:5432/marketdata \\
        python -m marketdata.jobs.daily_refresh [--symbols RY.TO NVDA]

Each (symbol, step) is its own transaction: a failure is logged and
recorded in ``tracked_symbols.last_error`` without losing the other steps or
symbols. The exit code is 1 only when nothing succeeded at all (database or
network down), so AWS Batch retries the job only in that case.

Finnhub steps run only if ``FINNHUB_API_KEY`` is set.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import lru_cache

import psycopg
import yfinance as yf

from marketdata.db import connect
from marketdata.db import repositories as repo
from marketdata.http.rate_limiter import RateLimiter
from marketdata.providers.finnhub import (
    FinnhubClient,
    FinnhubEarningsFetcher,
    FinnhubNewsFetcher,
    FinnhubRecommendationFetcher,
)
from marketdata.providers.finnhub.client import API_KEY_ENV_VAR
from marketdata.providers.yahoo import (
    YahooClient,
    YahooMetricsFetcher,
    YahooPriceHistoryFetcher,
    YahooPriceTargetFetcher,
    YahooProfileFetcher,
    YahooRatingActionFetcher,
)
from marketdata.values import DateRange

log = logging.getLogger("marketdata.daily_refresh")

# Re-fetching a short overlap picks up late corrections and actions that
# Yahoo reports a few days after the fact; upserts make it idempotent.
LOOKBACK_DAYS = 7
EARNINGS_AHEAD_DAYS = 90
# Yahoo has no published quota; stay well below where it starts throttling.
YAHOO_CALLS_PER_MINUTE = 30

Step = Callable[[psycopg.Connection, str], None]


def yahoo_steps(client: YahooClient, today: date) -> list[tuple[str, Step]]:
    recent = DateRange.last_days(LOOKBACK_DAYS, today)
    profile = YahooProfileFetcher(client)
    metrics = YahooMetricsFetcher(client)
    target = YahooPriceTargetFetcher(client)
    prices = YahooPriceHistoryFetcher(client)
    ratings = YahooRatingActionFetcher(client)
    return [
        ("yahoo.profile", lambda c, s: repo.save_profile(c, profile.fetch(s))),
        ("yahoo.metrics", lambda c, s: repo.save_metrics(c, metrics.fetch(s))),
        ("yahoo.price_target", lambda c, s: repo.save_price_target(c, target.fetch(s))),
        ("yahoo.prices", lambda c, s: repo.save_price_bars(c, prices.fetch(s, recent))),
        ("yahoo.rating_actions", lambda c, s: repo.save_rating_actions(c, ratings.fetch(s, recent))),
    ]


def finnhub_steps(client: FinnhubClient, today: date) -> list[tuple[str, Step]]:
    recent = DateRange.last_days(LOOKBACK_DAYS, today)
    earnings_window = DateRange(recent.start, today + timedelta(days=EARNINGS_AHEAD_DAYS))
    news = FinnhubNewsFetcher(client)
    earnings = FinnhubEarningsFetcher(client)
    recommendations = FinnhubRecommendationFetcher(client)
    return [
        ("finnhub.news", lambda c, s: repo.save_news(c, news.fetch(s, recent))),
        ("finnhub.earnings", lambda c, s: repo.save_earnings(c, earnings.fetch(s, earnings_window))),
        ("finnhub.recommendations", lambda c, s: repo.save_recommendations(c, recommendations.fetch(s))),
    ]


def default_steps(today: date) -> list[tuple[str, Step]]:
    # One Ticker per symbol, reused across steps: yfinance caches `info` on
    # it, so profile, metrics and price target cost a single request.
    ticker_factory = lru_cache(maxsize=1)(yf.Ticker)
    yahoo = YahooClient(
        ticker_factory=ticker_factory,
        rate_limiter=RateLimiter(YAHOO_CALLS_PER_MINUTE, 60.0),
    )
    steps = yahoo_steps(yahoo, today)
    if os.environ.get(API_KEY_ENV_VAR):
        steps += finnhub_steps(FinnhubClient.from_env(), today)
    else:
        log.info("%s not set: skipping Finnhub steps", API_KEY_ENV_VAR)
    return steps


@dataclass
class RefreshReport:
    succeeded: int = 0
    failed: int = 0
    failures: dict[str, list[str]] = field(default_factory=dict)

    @property
    def nothing_succeeded(self) -> bool:
        return self.succeeded == 0 and self.failed > 0


def refresh(
    conn: psycopg.Connection, symbols: Sequence[str], steps: Sequence[tuple[str, Step]]
) -> RefreshReport:
    """Run every step for every symbol. ``conn`` must be in autocommit mode so
    that each ``conn.transaction()`` block commits on its own."""
    report = RefreshReport()
    for symbol in symbols:
        errors: list[str] = []
        for name, step in steps:
            try:
                with conn.transaction():
                    step(conn, symbol)
                report.succeeded += 1
            except Exception as exc:  # one bad step must not stop the batch
                report.failed += 1
                errors.append(f"{name}: {exc}")
                log.warning("%s %s failed: %s", symbol, name, exc)
        if errors:
            report.failures[symbol] = errors
        with conn.transaction():
            repo.mark_refreshed(conn, symbol, "; ".join(errors)[:2000] if errors else None)
        log.info("%s done (%d/%d steps ok)", symbol, len(steps) - len(errors), len(steps))
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refresh tracked symbols in the database.")
    parser.add_argument("--symbols", nargs="+", help="override the tracked_symbols table")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    with connect() as conn:
        conn.autocommit = True
        symbols = args.symbols or repo.active_symbols(conn)
        if not symbols:
            log.warning("no active tracked symbols: nothing to do")
            return 0
        log.info("refreshing %d symbols", len(symbols))
        report = refresh(conn, symbols, default_steps(date.today()))

    log.info("finished: %d steps ok, %d failed", report.succeeded, report.failed)
    return 1 if report.nothing_succeeded else 0


if __name__ == "__main__":
    sys.exit(main())
