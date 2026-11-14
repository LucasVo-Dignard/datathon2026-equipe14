from datetime import UTC, date, datetime

import pytest
import requests

from marketdata.errors import (
    AuthenticationError,
    ConfigurationError,
    ProviderError,
    RateLimitError,
    SymbolNotFoundError,
)
from marketdata.fetchers import MetricsFetcher, NewsFetcher, ProfileFetcher
from marketdata.http import RateLimiter, RetryPolicy
from marketdata.providers.finnhub import (
    FinnhubClient,
    FinnhubEarningsFetcher,
    FinnhubMetricsFetcher,
    FinnhubNewsFetcher,
    FinnhubProfileFetcher,
    FinnhubRecommendationFetcher,
)
from marketdata.values import DateRange

# --- Client -----------------------------------------------------------------


class FakeResponse:
    def __init__(self, status_code: int, payload=None) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, responses) -> None:
        self._responses = list(responses)
        self.calls: list[dict] = []

    def get(self, url, params, headers, timeout):
        self.calls.append({"url": url, "params": params, "headers": headers})
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def make_client(*responses) -> tuple[FinnhubClient, FakeSession]:
    session = FakeSession(responses)
    client = FinnhubClient(
        "test-key",
        session=session,
        rate_limiter=RateLimiter(1000, 1.0),
        retry=RetryPolicy(max_attempts=3, backoff_seconds=0),
        sleep=lambda _: None,
    )
    return client, session


def test_client_sends_key_in_header_not_url():
    client, session = make_client(FakeResponse(200, {"ok": True}))
    assert client.get("/quote", {"symbol": "AAPL"}) == {"ok": True}
    call = session.calls[0]
    assert call["url"] == "https://finnhub.io/api/v1/quote"
    assert call["headers"] == {"X-Finnhub-Token": "test-key"}
    assert "test-key" not in str(call["params"])


def test_client_retries_rate_limit_and_server_errors():
    client, session = make_client(
        FakeResponse(429), FakeResponse(503), FakeResponse(200, [1])
    )
    assert client.get("/x") == [1]
    assert len(session.calls) == 3


def test_client_raises_after_last_attempt():
    client, _ = make_client(FakeResponse(429), FakeResponse(429), FakeResponse(429))
    with pytest.raises(RateLimitError):
        client.get("/x")


def test_client_retries_network_errors():
    client, _ = make_client(requests.ConnectionError("boom"), FakeResponse(200, {}))
    assert client.get("/x") == {}


def test_client_auth_error_is_not_retried():
    client, session = make_client(FakeResponse(403, {"error": "no access"}))
    with pytest.raises(AuthenticationError):
        client.get("/x")
    assert len(session.calls) == 1


def test_client_other_4xx():
    client, _ = make_client(FakeResponse(422, {"error": "bad"}))
    with pytest.raises(ProviderError):
        client.get("/x")


def test_from_env_requires_key(monkeypatch):
    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    with pytest.raises(ConfigurationError):
        FinnhubClient.from_env()


# --- Fetchers (with a fake client returning canned JSON) --------------------


class FakeClient:
    def __init__(self, payloads: dict) -> None:
        self._payloads = payloads
        self.calls: list[tuple[str, dict]] = []

    def get(self, path, params=None):
        self.calls.append((path, params))
        return self._payloads[path]


def test_fetchers_implement_abstract_kinds():
    client = FakeClient({})
    assert isinstance(FinnhubProfileFetcher(client), ProfileFetcher)
    assert isinstance(FinnhubMetricsFetcher(client), MetricsFetcher)
    assert isinstance(FinnhubNewsFetcher(client), NewsFetcher)
    assert FinnhubNewsFetcher.provider == "finnhub"


def test_profile_converts_millions_and_normalizes_symbol():
    client = FakeClient({
        "/stock/profile2": {
            "name": "NVIDIA Corp", "exchange": "NASDAQ NMS - GLOBAL MARKET",
            "currency": "USD", "country": "US", "finnhubIndustry": "Semiconductors",
            "marketCapitalization": 3_900_000.5, "shareOutstanding": 24_300.0,
            "weburl": "https://nvidia.com", "logo": "", "ipo": "1999-01-22",
        }
    })
    profile = FinnhubProfileFetcher(client).fetch(" nvda ")
    assert client.calls == [("/stock/profile2", {"symbol": "NVDA"})]
    assert profile.symbol == "NVDA"
    assert profile.market_cap == pytest.approx(3_900_000.5e6)
    assert profile.shares_outstanding == pytest.approx(24_300e6)
    assert profile.ipo_date == date(1999, 1, 22)
    assert profile.logo_url is None


def test_unknown_symbol_raises_not_found():
    client = FakeClient({"/stock/profile2": {}, "/stock/metric": {"metric": {}}})
    with pytest.raises(SymbolNotFoundError):
        FinnhubProfileFetcher(client).fetch("ZZZZ")
    with pytest.raises(SymbolNotFoundError):
        FinnhubMetricsFetcher(client).fetch("ZZZZ")


def test_metrics_converts_percentages_and_uses_fallback_keys():
    client = FakeClient({
        "/stock/metric": {"metric": {
            "peBasicExclExtraTTM": 45.2, "epsTTM": 2.9, "pbAnnual": 30.0,
            "dividendYieldIndicatedAnnual": 0.03, "beta": 1.7,
            "52WeekHigh": 212.0, "52WeekLow": 86.6,
            "netProfitMarginTTM": 55.8, "roeTTM": 119.2,
            "marketCapitalization": 1000.0,
        }}
    })
    metrics = FinnhubMetricsFetcher(client).fetch("NVDA")
    assert metrics.pe_ttm == 45.2
    assert metrics.price_to_book == 30.0
    assert metrics.dividend_yield == pytest.approx(0.0003)
    assert metrics.net_margin == pytest.approx(0.558)
    assert metrics.return_on_equity == pytest.approx(1.192)
    assert metrics.market_cap == pytest.approx(1e9)
    assert metrics.raw["beta"] == 1.7


def test_news_maps_items_and_skips_incomplete_ones():
    client = FakeClient({"/company-news": [
        {"id": 7, "datetime": 1_700_000_000, "headline": "Big news", "url": "https://x/1",
         "summary": "", "source": "Reuters", "category": "company", "image": ""},
        {"id": 8, "datetime": 1_700_000_000, "headline": "", "url": "https://x/2"},
    ]})
    period = DateRange(date(2023, 11, 1), date(2023, 11, 30))
    articles = FinnhubNewsFetcher(client).fetch("AAPL", period)
    assert client.calls[0][1] == {"symbol": "AAPL", "from": "2023-11-01", "to": "2023-11-30"}
    assert len(articles) == 1
    article = articles[0]
    assert article.external_id == "7"
    assert article.published_at == datetime.fromtimestamp(1_700_000_000, UTC)
    assert article.publisher == "Reuters"
    assert article.summary is None


def test_news_rejects_non_list_payload():
    client = FakeClient({"/company-news": {"error": "?"}})
    with pytest.raises(ProviderError):
        FinnhubNewsFetcher(client).fetch("AAPL", DateRange.last_days(1))


def test_earnings_and_recommendations():
    client = FakeClient({
        "/calendar/earnings": {"earningsCalendar": [
            {"date": "2026-11-19", "symbol": "NVDA", "year": 2027, "quarter": 3,
             "hour": "amc", "epsEstimate": 1.2, "epsActual": None,
             "revenueEstimate": 5.4e10, "revenueActual": None},
        ]},
        "/stock/recommendation": [
            {"period": "2026-11-01", "strongBuy": 20, "buy": 30, "hold": 5, "sell": 1, "strongSell": 0},
        ],
    })
    events = FinnhubEarningsFetcher(client).fetch("NVDA", DateRange.last_days(30))
    assert events[0].date == date(2026, 11, 19)
    assert events[0].hour == "amc" and events[0].eps_actual is None

    trends = FinnhubRecommendationFetcher(client).fetch("NVDA")
    assert trends[0].period == date(2026, 11, 1)
    assert trends[0].total == 56
