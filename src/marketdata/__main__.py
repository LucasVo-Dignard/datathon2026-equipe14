"""Try the fetchers from the command line.

    python -m marketdata NVDA
    python -m marketdata RY.TO --days 10

Finnhub sections run only if FINNHUB_API_KEY is set.
"""

from __future__ import annotations

import argparse
import os
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from marketdata.errors import MarketDataError
from marketdata.providers.finnhub import (
    FinnhubClient,
    FinnhubEarningsFetcher,
    FinnhubMetricsFetcher,
    FinnhubNewsFetcher,
    FinnhubProfileFetcher,
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


def _show(title: str, call: Callable[[], Any], limit: int = 5) -> None:
    print(f"\n== {title}")
    try:
        result = call()
    except MarketDataError as exc:
        print(f"   error: {exc}")
        return
    items = result if isinstance(result, list) else [result]
    if not items:
        print("   (nothing)")
    for item in items[-limit:]:
        print(f"   {item}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("symbol")
    parser.add_argument("--days", type=int, default=30, help="history window (default 30)")
    args = parser.parse_args()
    period = DateRange.last_days(args.days)

    yahoo = YahooClient()
    _show("Yahoo profile", lambda: YahooProfileFetcher(yahoo).fetch(args.symbol))
    _show("Yahoo metrics", lambda: YahooMetricsFetcher(yahoo).fetch(args.symbol))
    _show("Yahoo prices (last 5)", lambda: YahooPriceHistoryFetcher(yahoo).fetch(args.symbol, period))
    _show("Yahoo price target", lambda: YahooPriceTargetFetcher(yahoo).fetch(args.symbol))
    _show(
        "Yahoo rating actions (last 5)",
        lambda: YahooRatingActionFetcher(yahoo).fetch(args.symbol, period),
    )

    if not os.environ.get(API_KEY_ENV_VAR):
        print(f"\n({API_KEY_ENV_VAR} not set: skipping Finnhub)")
        return
    finnhub = FinnhubClient.from_env()
    upcoming = DateRange(period.start, period.end + timedelta(days=90))
    _show("Finnhub profile", lambda: FinnhubProfileFetcher(finnhub).fetch(args.symbol))
    _show("Finnhub metrics", lambda: FinnhubMetricsFetcher(finnhub).fetch(args.symbol))
    _show("Finnhub recommendations", lambda: FinnhubRecommendationFetcher(finnhub).fetch(args.symbol), 3)
    _show("Finnhub news (5)", lambda: FinnhubNewsFetcher(finnhub).fetch(args.symbol, period))
    _show("Finnhub earnings", lambda: FinnhubEarningsFetcher(finnhub).fetch(args.symbol, upcoming))


if __name__ == "__main__":
    main()
