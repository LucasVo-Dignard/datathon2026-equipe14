"""Write ``marketdata`` models to the tables created in ``db/migrations``.

One function per model. Snapshot tables (``financial_metrics``,
``price_target_consensus``) get a new row on every save; the other tables are
upserted on their primary key, so re-running a refresh never duplicates rows.

Functions take an open connection and don't commit: the caller decides the
transaction boundary (the daily job commits once per symbol).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

import psycopg
from psycopg.types.json import Jsonb

from marketdata.models import (
    AnalystRatingAction,
    CompanyProfile,
    EarningsEvent,
    FinancialMetrics,
    NewsArticle,
    PriceBar,
    PriceTargetConsensus,
    RecommendationTrend,
)


def _jsonable(value: object) -> object:
    """yfinance's ``info`` can hold values json can't encode (NaN, dates)."""
    if isinstance(value, float) and value != value:  # NaN
        return None
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return str(value)


# --- Tracked symbols ---------------------------------------------------------


def active_symbols(conn: psycopg.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT symbol FROM tracked_symbols WHERE active ORDER BY symbol"
    ).fetchall()
    return [row[0] for row in rows]


def mark_refreshed(conn: psycopg.Connection, symbol: str, error: str | None = None) -> None:
    """Record the outcome of a refresh. ``last_refreshed_at`` moves only on
    success, so it always says how fresh the data really is."""
    conn.execute(
        """
        UPDATE tracked_symbols
           SET last_refreshed_at = CASE WHEN %(error)s::text IS NULL
                                        THEN %(now)s ELSE last_refreshed_at END,
               last_error = %(error)s
         WHERE symbol = %(symbol)s
        """,
        {"symbol": symbol, "error": error, "now": datetime.now(UTC)},
    )


# --- Market data ---------------------------------------------------------------


def save_profile(conn: psycopg.Connection, p: CompanyProfile) -> None:
    conn.execute(
        """
        INSERT INTO company_profiles (
            symbol, provider, name, exchange, currency, country, sector, industry,
            market_cap, shares_outstanding, website, logo_url, ipo_date,
            description, fetched_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (symbol, provider) DO UPDATE SET
            name = EXCLUDED.name, exchange = EXCLUDED.exchange,
            currency = EXCLUDED.currency, country = EXCLUDED.country,
            sector = EXCLUDED.sector, industry = EXCLUDED.industry,
            market_cap = EXCLUDED.market_cap,
            shares_outstanding = EXCLUDED.shares_outstanding,
            website = EXCLUDED.website, logo_url = EXCLUDED.logo_url,
            ipo_date = EXCLUDED.ipo_date, description = EXCLUDED.description,
            fetched_at = EXCLUDED.fetched_at
        """,
        (p.symbol, p.provider, p.name, p.exchange, p.currency, p.country, p.sector,
         p.industry, p.market_cap, p.shares_outstanding, p.website, p.logo_url,
         p.ipo_date, p.description, p.fetched_at),
    )


def save_price_bars(conn: psycopg.Connection, bars: Sequence[PriceBar]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO price_bars (
                symbol, provider, date, open, high, low, close, adj_close,
                volume, currency, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (symbol, provider, date) DO UPDATE SET
                open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                close = EXCLUDED.close, adj_close = EXCLUDED.adj_close,
                volume = EXCLUDED.volume, currency = EXCLUDED.currency,
                fetched_at = EXCLUDED.fetched_at
            """,
            [(b.symbol, b.provider, b.date, b.open, b.high, b.low, b.close,
              b.adj_close, b.volume, b.currency, b.fetched_at) for b in bars],
        )


def save_metrics(conn: psycopg.Connection, m: FinancialMetrics) -> None:
    conn.execute(
        """
        INSERT INTO financial_metrics (
            symbol, provider, market_cap, pe_ttm, forward_pe, price_to_book,
            eps_ttm, dividend_yield, beta, week52_high, week52_low, net_margin,
            return_on_equity, raw, fetched_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (m.symbol, m.provider, m.market_cap, m.pe_ttm, m.forward_pe, m.price_to_book,
         m.eps_ttm, m.dividend_yield, m.beta, m.week52_high, m.week52_low,
         m.net_margin, m.return_on_equity, Jsonb(_jsonable(dict(m.raw))), m.fetched_at),
    )


def save_price_target(conn: psycopg.Connection, t: PriceTargetConsensus) -> None:
    conn.execute(
        """
        INSERT INTO price_target_consensus (
            symbol, provider, currency, current_price, target_mean, target_median,
            target_high, target_low, analyst_count, recommendation_mean,
            recommendation_key, fetched_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (t.symbol, t.provider, t.currency, t.current_price, t.target_mean,
         t.target_median, t.target_high, t.target_low, t.analyst_count,
         t.recommendation_mean, t.recommendation_key, t.fetched_at),
    )


def save_rating_actions(conn: psycopg.Connection, actions: Sequence[AnalystRatingAction]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO analyst_rating_actions (
                symbol, provider, graded_at, firm, action, from_grade, to_grade,
                price_target_action, price_target, prior_price_target, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (symbol, provider, graded_at, firm) DO UPDATE SET
                action = EXCLUDED.action, from_grade = EXCLUDED.from_grade,
                to_grade = EXCLUDED.to_grade,
                price_target_action = EXCLUDED.price_target_action,
                price_target = EXCLUDED.price_target,
                prior_price_target = EXCLUDED.prior_price_target,
                fetched_at = EXCLUDED.fetched_at
            """,
            [(a.symbol, a.provider, a.graded_at, a.firm, a.action, a.from_grade,
              a.to_grade, a.price_target_action, a.price_target, a.prior_price_target,
              a.fetched_at) for a in actions],
        )


def save_news(conn: psycopg.Connection, articles: Sequence[NewsArticle]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO news_articles (
                provider, external_id, symbol, published_at, headline, url, summary,
                publisher, image_url, category, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (provider, external_id, symbol) DO NOTHING
            """,
            [(a.provider, a.external_id, a.symbol, a.published_at, a.headline, a.url,
              a.summary, a.publisher, a.image_url, a.category, a.fetched_at)
             for a in articles],
        )


def save_earnings(conn: psycopg.Connection, events: Sequence[EarningsEvent]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO earnings_events (
                symbol, provider, date, fiscal_year, fiscal_quarter, hour,
                eps_estimate, eps_actual, revenue_estimate, revenue_actual, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (symbol, provider, date) DO UPDATE SET
                fiscal_year = EXCLUDED.fiscal_year,
                fiscal_quarter = EXCLUDED.fiscal_quarter, hour = EXCLUDED.hour,
                eps_estimate = EXCLUDED.eps_estimate, eps_actual = EXCLUDED.eps_actual,
                revenue_estimate = EXCLUDED.revenue_estimate,
                revenue_actual = EXCLUDED.revenue_actual,
                fetched_at = EXCLUDED.fetched_at
            """,
            [(e.symbol, e.provider, e.date, e.fiscal_year, e.fiscal_quarter, e.hour,
              e.eps_estimate, e.eps_actual, e.revenue_estimate, e.revenue_actual,
              e.fetched_at) for e in events],
        )


def save_recommendations(conn: psycopg.Connection, trends: Sequence[RecommendationTrend]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO recommendation_trends (
                symbol, provider, period, strong_buy, buy, hold, sell, strong_sell,
                fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (symbol, provider, period) DO UPDATE SET
                strong_buy = EXCLUDED.strong_buy, buy = EXCLUDED.buy,
                hold = EXCLUDED.hold, sell = EXCLUDED.sell,
                strong_sell = EXCLUDED.strong_sell, fetched_at = EXCLUDED.fetched_at
            """,
            [(t.symbol, t.provider, t.period, t.strong_buy, t.buy, t.hold, t.sell,
              t.strong_sell, t.fetched_at) for t in trends],
        )
