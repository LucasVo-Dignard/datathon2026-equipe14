"""Yahoo Finance fetchers: each one fetches one kind of data."""

from __future__ import annotations

from marketdata.errors import SymbolNotFoundError
from marketdata.fetchers.base import (
    Fetcher,
    MetricsFetcher,
    PriceHistoryFetcher,
    PriceTargetFetcher,
    ProfileFetcher,
    RatingActionFetcher,
)
from marketdata.models import (
    AnalystRatingAction,
    CompanyProfile,
    FinancialMetrics,
    PriceBar,
    PriceTargetConsensus,
)
from marketdata.providers.yahoo import mappers
from marketdata.providers.yahoo.client import PROVIDER, YahooClient
from marketdata.values import DateRange


class YahooFetcher(Fetcher):
    """Base for every Yahoo fetcher: holds the shared client."""

    provider = PROVIDER

    def __init__(self, client: YahooClient | None = None) -> None:
        self._client = client or YahooClient()

    def _quote_info(self, symbol: str) -> dict:
        info = self._client.info(symbol)
        if not mappers.has_quote(info):
            raise SymbolNotFoundError(self.provider, symbol)
        return info


class YahooProfileFetcher(YahooFetcher, ProfileFetcher):
    def _fetch(self, symbol: str) -> CompanyProfile:
        return mappers.to_profile(symbol, self._quote_info(symbol))


class YahooMetricsFetcher(YahooFetcher, MetricsFetcher):
    def _fetch(self, symbol: str) -> FinancialMetrics:
        return mappers.to_metrics(symbol, self._quote_info(symbol))


class YahooPriceHistoryFetcher(YahooFetcher, PriceHistoryFetcher):
    def _fetch(self, symbol: str, period: DateRange) -> list[PriceBar]:
        history = self._client.history(symbol, period)
        return mappers.to_price_bars(symbol, history.frame, history.currency)


class YahooPriceTargetFetcher(YahooFetcher, PriceTargetFetcher):
    """Targets are None (not an error) when no analyst covers the symbol, so
    the cache can record that it checked."""

    def _fetch(self, symbol: str) -> PriceTargetConsensus:
        return mappers.to_price_target(symbol, self._quote_info(symbol))


class YahooRatingActionFetcher(YahooFetcher, RatingActionFetcher):
    def _fetch(self, symbol: str, period: DateRange) -> list[AnalystRatingAction]:
        frame = self._client.upgrades_downgrades(symbol)
        return mappers.to_rating_actions(symbol, frame, period)
