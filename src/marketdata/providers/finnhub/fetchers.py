"""Finnhub fetchers: each one fetches one kind of data.

They share a single ``FinnhubClient`` so they also share its rate limiter.
"""

from __future__ import annotations

from marketdata.errors import ProviderError, SymbolNotFoundError
from marketdata.fetchers.base import (
    EarningsFetcher,
    Fetcher,
    MetricsFetcher,
    NewsFetcher,
    ProfileFetcher,
    RecommendationFetcher,
)
from marketdata.models import (
    CompanyProfile,
    EarningsEvent,
    FinancialMetrics,
    NewsArticle,
    RecommendationTrend,
)
from marketdata.providers.finnhub import mappers
from marketdata.providers.finnhub.client import PROVIDER, FinnhubClient
from marketdata.values import DateRange


class FinnhubFetcher(Fetcher):
    """Base for every Finnhub fetcher: holds the shared client."""

    provider = PROVIDER

    def __init__(self, client: FinnhubClient) -> None:
        self._client = client

    def _get_list(self, path: str, params: dict[str, str]) -> list[dict]:
        payload = self._client.get(path, params)
        if not isinstance(payload, list):
            raise ProviderError(self.provider, f"expected a list from {path}")
        return payload


class FinnhubProfileFetcher(FinnhubFetcher, ProfileFetcher):
    def _fetch(self, symbol: str) -> CompanyProfile:
        raw = self._client.get("/stock/profile2", {"symbol": symbol})
        if not raw:  # Finnhub answers {} for unknown symbols.
            raise SymbolNotFoundError(self.provider, symbol)
        return mappers.to_profile(symbol, raw)


class FinnhubMetricsFetcher(FinnhubFetcher, MetricsFetcher):
    def _fetch(self, symbol: str) -> FinancialMetrics:
        raw = self._client.get("/stock/metric", {"symbol": symbol, "metric": "all"})
        metric = (raw or {}).get("metric") or {}
        if not metric:
            raise SymbolNotFoundError(self.provider, symbol)
        return mappers.to_metrics(symbol, metric)


class FinnhubRecommendationFetcher(FinnhubFetcher, RecommendationFetcher):
    def _fetch(self, symbol: str) -> list[RecommendationTrend]:
        items = self._get_list("/stock/recommendation", {"symbol": symbol})
        trends = [mappers.to_recommendation(symbol, item) for item in items]
        return [trend for trend in trends if trend is not None]


class FinnhubNewsFetcher(FinnhubFetcher, NewsFetcher):
    """Company news. The free plan only covers about the last year."""

    def _fetch(self, symbol: str, period: DateRange) -> list[NewsArticle]:
        items = self._get_list(
            "/company-news",
            {"symbol": symbol, "from": period.start.isoformat(), "to": period.end.isoformat()},
        )
        articles = [mappers.to_news_article(symbol, item) for item in items]
        return [article for article in articles if article is not None]


class FinnhubEarningsFetcher(FinnhubFetcher, EarningsFetcher):
    def _fetch(self, symbol: str, period: DateRange) -> list[EarningsEvent]:
        raw = self._client.get(
            "/calendar/earnings",
            {"symbol": symbol, "from": period.start.isoformat(), "to": period.end.isoformat()},
        )
        items = (raw or {}).get("earningsCalendar") or []
        events = [mappers.to_earnings_event(symbol, item) for item in items]
        return [event for event in events if event is not None]
