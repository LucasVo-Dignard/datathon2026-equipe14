"""Translate Finnhub JSON into ``marketdata`` models.

Finnhub units: market cap and shares outstanding are in millions; margins,
ROE and dividend yield are percentages. They are converted here to units and
fractions (see ``marketdata.models``).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from marketdata.models import (
    CompanyProfile,
    EarningsEvent,
    FinancialMetrics,
    NewsArticle,
    RecommendationTrend,
)
from marketdata.providers.parsing import (
    first_present,
    scaled,
    to_date,
    to_float,
    to_int,
    to_text,
)

PROVIDER = "finnhub"
MILLION = 1_000_000
PERCENT = 0.01

# Finnhub's /stock/metric has several names for some metrics; the first one
# present wins.
_METRIC_KEYS: dict[str, tuple[str, ...]] = {
    "market_cap": ("marketCapitalization",),
    "pe_ttm": ("peTTM", "peBasicExclExtraTTM", "peExclExtraTTM"),
    "price_to_book": ("pbQuarterly", "pbAnnual"),
    "eps_ttm": ("epsTTM", "epsBasicExclExtraItemsTTM", "epsInclExtraItemsTTM"),
    "dividend_yield": ("currentDividendYieldTTM", "dividendYieldIndicatedAnnual"),
    "beta": ("beta",),
    "week52_high": ("52WeekHigh",),
    "week52_low": ("52WeekLow",),
    "net_margin": ("netProfitMarginTTM", "netProfitMarginAnnual"),
    "return_on_equity": ("roeTTM", "roeRfy"),
}


def to_profile(symbol: str, raw: Mapping[str, Any]) -> CompanyProfile:
    return CompanyProfile(
        symbol=symbol,
        name=to_text(raw.get("name")) or symbol,
        provider=PROVIDER,
        exchange=to_text(raw.get("exchange")),
        currency=to_text(raw.get("currency")),
        country=to_text(raw.get("country")),
        industry=to_text(raw.get("finnhubIndustry")),
        market_cap=scaled(raw.get("marketCapitalization"), MILLION),
        shares_outstanding=scaled(raw.get("shareOutstanding"), MILLION),
        website=to_text(raw.get("weburl")),
        logo_url=to_text(raw.get("logo")),
        ipo_date=to_date(raw.get("ipo")),
    )


def to_metrics(symbol: str, metric: Mapping[str, Any]) -> FinancialMetrics:
    """``metric`` is the ``"metric"`` object of the /stock/metric response."""

    def pick(name: str) -> Any:
        return first_present(metric, _METRIC_KEYS[name])

    return FinancialMetrics(
        symbol=symbol,
        provider=PROVIDER,
        market_cap=scaled(pick("market_cap"), MILLION),
        pe_ttm=to_float(pick("pe_ttm")),
        price_to_book=to_float(pick("price_to_book")),
        eps_ttm=to_float(pick("eps_ttm")),
        dividend_yield=scaled(pick("dividend_yield"), PERCENT),
        beta=to_float(pick("beta")),
        week52_high=to_float(pick("week52_high")),
        week52_low=to_float(pick("week52_low")),
        net_margin=scaled(pick("net_margin"), PERCENT),
        return_on_equity=scaled(pick("return_on_equity"), PERCENT),
        raw=dict(metric),
    )


def to_news_article(symbol: str, raw: Mapping[str, Any]) -> NewsArticle | None:
    """Return None for items missing the fields an article needs."""
    headline = to_text(raw.get("headline"))
    url = to_text(raw.get("url"))
    timestamp = to_int(raw.get("datetime"))
    if headline is None or url is None or timestamp is None:
        return None
    return NewsArticle(
        symbol=symbol,
        external_id=str(raw.get("id") or url),
        published_at=datetime.fromtimestamp(timestamp, UTC),
        headline=headline,
        url=url,
        provider=PROVIDER,
        summary=to_text(raw.get("summary")),
        publisher=to_text(raw.get("source")),
        image_url=to_text(raw.get("image")),
        category=to_text(raw.get("category")),
    )


def to_earnings_event(symbol: str, raw: Mapping[str, Any]) -> EarningsEvent | None:
    event_date = to_date(raw.get("date"))
    if event_date is None:
        return None
    return EarningsEvent(
        symbol=symbol,
        date=event_date,
        provider=PROVIDER,
        fiscal_year=to_int(raw.get("year")),
        fiscal_quarter=to_int(raw.get("quarter")),
        hour=to_text(raw.get("hour")),
        eps_estimate=to_float(raw.get("epsEstimate")),
        eps_actual=to_float(raw.get("epsActual")),
        revenue_estimate=to_float(raw.get("revenueEstimate")),
        revenue_actual=to_float(raw.get("revenueActual")),
    )


def to_recommendation(symbol: str, raw: Mapping[str, Any]) -> RecommendationTrend | None:
    period = to_date(raw.get("period"))
    if period is None:
        return None
    return RecommendationTrend(
        symbol=symbol,
        period=period,
        provider=PROVIDER,
        strong_buy=to_int(raw.get("strongBuy")) or 0,
        buy=to_int(raw.get("buy")) or 0,
        hold=to_int(raw.get("hold")) or 0,
        sell=to_int(raw.get("sell")) or 0,
        strong_sell=to_int(raw.get("strongSell")) or 0,
    )
