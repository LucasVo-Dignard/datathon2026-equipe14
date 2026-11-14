"""Provider-independent data models.

Every fetcher returns these types, whatever the source, so the rest of the
application (and later the RDS repositories) never sees provider-specific
JSON. Each model maps to one future table.

Conventions:
- Amounts are in the listing currency, in units (not millions).
- Ratios such as margins, ROE and dividend yield are fractions (0.25 = 25%).
- ``provider`` records where the row came from ("yahoo", "finnhub").
- ``fetched_at`` is UTC and lets us decide later when cached data is stale.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True, kw_only=True)
class CompanyProfile:
    symbol: str
    name: str
    provider: str
    exchange: str | None = None
    currency: str | None = None
    country: str | None = None
    sector: str | None = None
    industry: str | None = None
    market_cap: float | None = None
    shares_outstanding: float | None = None
    website: str | None = None
    logo_url: str | None = None
    ipo_date: date | None = None
    description: str | None = None
    fetched_at: datetime = field(default_factory=_utc_now)


@dataclass(frozen=True, slots=True, kw_only=True)
class PriceBar:
    """One daily OHLCV bar. ``close`` is split-adjusted only; ``adj_close``
    is also adjusted for dividends and is the one to use for returns."""

    symbol: str
    date: date
    open: float
    high: float
    low: float
    close: float
    adj_close: float
    volume: int
    provider: str
    currency: str | None = None
    fetched_at: datetime = field(default_factory=_utc_now)


@dataclass(frozen=True, slots=True, kw_only=True)
class FinancialMetrics:
    """Snapshot of key fundamentals. ``raw`` keeps every value the provider
    returned, so nothing is lost if we need another metric later."""

    symbol: str
    provider: str
    market_cap: float | None = None
    pe_ttm: float | None = None
    forward_pe: float | None = None
    price_to_book: float | None = None
    eps_ttm: float | None = None
    dividend_yield: float | None = None
    beta: float | None = None
    week52_high: float | None = None
    week52_low: float | None = None
    net_margin: float | None = None
    return_on_equity: float | None = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False, compare=False)
    fetched_at: datetime = field(default_factory=_utc_now)


@dataclass(frozen=True, slots=True, kw_only=True)
class NewsArticle:
    symbol: str
    external_id: str
    published_at: datetime
    headline: str
    url: str
    provider: str
    summary: str | None = None
    publisher: str | None = None
    image_url: str | None = None
    category: str | None = None
    fetched_at: datetime = field(default_factory=_utc_now)


@dataclass(frozen=True, slots=True, kw_only=True)
class EarningsEvent:
    """A scheduled or past earnings release. ``hour`` is "bmo" (before market
    open), "amc" (after market close), "dmh" (during market hours) or None."""

    symbol: str
    date: date
    provider: str
    fiscal_year: int | None = None
    fiscal_quarter: int | None = None
    hour: str | None = None
    eps_estimate: float | None = None
    eps_actual: float | None = None
    revenue_estimate: float | None = None
    revenue_actual: float | None = None
    fetched_at: datetime = field(default_factory=_utc_now)


@dataclass(frozen=True, slots=True, kw_only=True)
class RecommendationTrend:
    """Number of analysts per rating for one month (``period``)."""

    symbol: str
    period: date
    provider: str
    strong_buy: int = 0
    buy: int = 0
    hold: int = 0
    sell: int = 0
    strong_sell: int = 0
    fetched_at: datetime = field(default_factory=_utc_now)

    @property
    def total(self) -> int:
        return self.strong_buy + self.buy + self.hold + self.sell + self.strong_sell


@dataclass(frozen=True, slots=True, kw_only=True)
class PriceTargetConsensus:
    """Snapshot of the analysts' consensus 12-month price target.

    Targets are None when no analyst covers the symbol. ``recommendation_mean``
    goes from 1 (strong buy) to 5 (strong sell); ``recommendation_key`` is the
    provider's label for it ("buy", "hold", ...).
    """

    symbol: str
    provider: str
    currency: str | None = None
    current_price: float | None = None
    target_mean: float | None = None
    target_median: float | None = None
    target_high: float | None = None
    target_low: float | None = None
    analyst_count: int | None = None
    recommendation_mean: float | None = None
    recommendation_key: str | None = None
    fetched_at: datetime = field(default_factory=_utc_now)

    @property
    def upside(self) -> float | None:
        """Mean target relative to the current price (0.2 = 20% upside)."""
        if not self.target_mean or not self.current_price:
            return None
        return self.target_mean / self.current_price - 1


@dataclass(frozen=True, slots=True, kw_only=True)
class AnalystRatingAction:
    """One firm's rating or price-target change (upgrade, downgrade, ...).

    ``action`` is the provider's code: "up", "down", "init", "main"
    (maintained) or "reit" (reiterated). Price targets are None when the firm
    changed only its rating, or when the provider doesn't report targets.
    """

    symbol: str
    graded_at: datetime
    firm: str
    provider: str
    action: str | None = None
    from_grade: str | None = None
    to_grade: str | None = None
    price_target_action: str | None = None
    price_target: float | None = None
    prior_price_target: float | None = None
    fetched_at: datetime = field(default_factory=_utc_now)
