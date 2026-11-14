"""Abstract fetcher hierarchy.

The hierarchy has two axes:

* **What** is fetched: one abstract class per kind of data (``ProfileFetcher``,
  ``PriceHistoryFetcher``, ...). Code that needs data depends only on these,
  so providers can be swapped or combined without touching callers.
* **Where** it comes from: one base class per provider (``FinnhubFetcher``,
  ``YahooFetcher``) that holds the shared client.

A concrete fetcher combines both, for example
``class FinnhubNewsFetcher(FinnhubFetcher, NewsFetcher)``, and has a single
job: fetch one kind of data from one provider.

The public ``fetch`` methods are template methods: they validate and
normalize the input, then call ``_fetch``, which subclasses implement.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import ClassVar, Generic, TypeVar

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
from marketdata.values import DateRange, normalize_symbol

T = TypeVar("T")


class Fetcher(ABC):
    """Root of every fetcher. ``provider`` names the data source."""

    provider: ClassVar[str]


class SymbolFetcher(Fetcher, Generic[T]):
    """Fetches data that depends only on a symbol (profile, metrics, ...).

    Raises ``SymbolNotFoundError`` when the provider has nothing for it.
    """

    def fetch(self, symbol: str) -> T:
        return self._fetch(normalize_symbol(symbol))

    @abstractmethod
    def _fetch(self, symbol: str) -> T:
        """Fetch data for an already-normalized symbol."""


class RangeFetcher(Fetcher, Generic[T]):
    """Fetches a time series for a symbol over a date range.

    Returns an empty list when the provider has nothing in the range.
    """

    def fetch(self, symbol: str, period: DateRange) -> list[T]:
        return self._fetch(normalize_symbol(symbol), period)

    @abstractmethod
    def _fetch(self, symbol: str, period: DateRange) -> list[T]:
        """Fetch data for an already-normalized symbol."""


# --- One abstract class per kind of data ------------------------------------


class ProfileFetcher(SymbolFetcher[CompanyProfile]):
    """Company identity: name, exchange, sector, market cap, ..."""


class MetricsFetcher(SymbolFetcher[FinancialMetrics]):
    """Snapshot of fundamentals: P/E, EPS, margins, ..."""


class RecommendationFetcher(SymbolFetcher[list[RecommendationTrend]]):
    """Monthly analyst rating counts."""


class PriceTargetFetcher(SymbolFetcher[PriceTargetConsensus]):
    """Analysts' consensus price target (mean, median, high, low)."""


class RatingActionFetcher(RangeFetcher[AnalystRatingAction]):
    """Per-firm upgrades, downgrades and price-target changes."""


class PriceHistoryFetcher(RangeFetcher[PriceBar]):
    """Daily OHLCV bars."""


class NewsFetcher(RangeFetcher[NewsArticle]):
    """Company news articles."""


class EarningsFetcher(RangeFetcher[EarningsEvent]):
    """Earnings releases (past and scheduled)."""
