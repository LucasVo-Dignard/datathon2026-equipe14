from datetime import UTC, date, datetime

import pandas as pd
import pytest

from marketdata.errors import ProviderError, SymbolNotFoundError
from marketdata.fetchers import (
    MetricsFetcher,
    PriceHistoryFetcher,
    PriceTargetFetcher,
    ProfileFetcher,
    RatingActionFetcher,
)
from marketdata.providers.yahoo import (
    YahooClient,
    YahooHistory,
    YahooMetricsFetcher,
    YahooPriceHistoryFetcher,
    YahooPriceTargetFetcher,
    YahooProfileFetcher,
    YahooRatingActionFetcher,
)
from marketdata.values import DateRange

NVDA_INFO = {
    "longName": "NVIDIA Corporation", "fullExchangeName": "NasdaqGS", "currency": "USD",
    "country": "United States", "sector": "Technology", "industry": "Semiconductors",
    "marketCap": 3_932_339_044_352, "sharesOutstanding": 24_147_000_000,
    "trailingPE": 20.58, "forwardPE": 10.27, "priceToBook": 17.17, "trailingEps": 7.91,
    "trailingAnnualDividendYield": 0.0017, "dividendYield": 0.61, "beta": 2.247,
    "fiftyTwoWeekHigh": 243.37, "fiftyTwoWeekLow": 148.8,
    "profitMargins": 0.636, "returnOnEquity": 1.172,
}


class FakeYahooClient:
    def __init__(self, info=None, history=None, grades=None) -> None:
        self._info = info or {}
        self._history = history
        self._grades = grades if grades is not None else pd.DataFrame()
        self.history_calls: list[tuple[str, DateRange]] = []

    def upgrades_downgrades(self, symbol):
        return self._grades

    def info(self, symbol):
        return self._info

    def history(self, symbol, period):
        self.history_calls.append((symbol, period))
        return self._history


def test_fetchers_implement_abstract_kinds():
    client = FakeYahooClient()
    assert isinstance(YahooProfileFetcher(client), ProfileFetcher)
    assert isinstance(YahooMetricsFetcher(client), MetricsFetcher)
    assert isinstance(YahooPriceHistoryFetcher(client), PriceHistoryFetcher)
    assert YahooProfileFetcher.provider == "yahoo"


def test_profile():
    profile = YahooProfileFetcher(FakeYahooClient(NVDA_INFO)).fetch("nvda")
    assert profile.symbol == "NVDA"
    assert profile.name == "NVIDIA Corporation"
    assert profile.exchange == "NasdaqGS"
    assert profile.sector == "Technology"
    assert profile.market_cap == 3_932_339_044_352


def test_metrics_use_fraction_dividend_yield():
    metrics = YahooMetricsFetcher(FakeYahooClient(NVDA_INFO)).fetch("NVDA")
    assert metrics.dividend_yield == 0.0017  # not the percentage `dividendYield`
    assert metrics.forward_pe == 10.27
    assert metrics.net_margin == 0.636


def test_unknown_symbol_raises_not_found():
    client = FakeYahooClient({"trailingPegRatio": None})
    with pytest.raises(SymbolNotFoundError):
        YahooProfileFetcher(client).fetch("ZZZZNOTREAL")
    with pytest.raises(SymbolNotFoundError):
        YahooMetricsFetcher(client).fetch("ZZZZNOTREAL")


def test_price_history_maps_rows_and_skips_missing_prices():
    index = pd.DatetimeIndex(
        ["2026-11-02", "2026-11-03", "2026-11-04"], tz="America/New_York", name="Date"
    )
    frame = pd.DataFrame(
        {
            "Open": [207.5, 207.9, None], "High": [209.9, 209.1, 1.0],
            "Low": [205.0, 204.0, 1.0], "Close": [206.0, 207.0, 1.0],
            "Adj Close": [202.0, 206.6, 1.0], "Volume": [119_272_200, 91_943_400, 1],
        },
        index=index,
    )
    client = FakeYahooClient(history=YahooHistory(frame=frame, currency="USD"))
    period = DateRange(date(2026, 11, 2), date(2026, 11, 4))
    bars = YahooPriceHistoryFetcher(client).fetch("NVDA", period)
    assert client.history_calls == [("NVDA", period)]
    assert [bar.date for bar in bars] == [date(2026, 11, 2), date(2026, 11, 3)]
    assert bars[0].adj_close == 202.0
    assert bars[0].volume == 119_272_200
    assert bars[0].currency == "USD"


def test_empty_history_gives_empty_list():
    empty = pd.DataFrame(columns=["Open", "High", "Low", "Close", "Adj Close", "Volume"])
    client = FakeYahooClient(history=YahooHistory(frame=empty, currency=None))
    assert YahooPriceHistoryFetcher(client).fetch("ZZZZ", DateRange.last_days(5)) == []


class FakeTicker:
    def __init__(self) -> None:
        self.history_kwargs: dict = {}
        self.history_metadata = {"currency": "CAD"}

    def history(self, **kwargs):
        self.history_kwargs = kwargs
        return pd.DataFrame()

    @property
    def info(self):
        raise RuntimeError("network down")


def test_client_makes_end_date_inclusive_and_reads_currency():
    ticker = FakeTicker()
    client = YahooClient(ticker_factory=lambda symbol: ticker)
    result = client.history("RY.TO", DateRange(date(2026, 11, 2), date(2026, 11, 6)))
    assert ticker.history_kwargs["start"] == "2026-11-02"
    assert ticker.history_kwargs["end"] == "2026-11-07"
    assert ticker.history_kwargs["auto_adjust"] is False
    assert result.currency == "CAD"


def test_client_wraps_library_errors():
    client = YahooClient(ticker_factory=lambda symbol: FakeTicker())
    with pytest.raises(ProviderError):
        client.info("RY.TO")


# --- Price targets ----------------------------------------------------------

RY_TARGET_INFO = {
    "longName": "Royal Bank of Canada", "currency": "CAD", "currentPrice": 200.0,
    "targetMeanPrice": 220.0, "targetMedianPrice": 219.0, "targetHighPrice": 240.0,
    "targetLowPrice": 190.0, "numberOfAnalystOpinions": 14,
    "recommendationMean": 2.1, "recommendationKey": "buy",
}


def test_price_target_fetchers_implement_abstract_kinds():
    client = FakeYahooClient()
    assert isinstance(YahooPriceTargetFetcher(client), PriceTargetFetcher)
    assert isinstance(YahooRatingActionFetcher(client), RatingActionFetcher)


def test_price_target_consensus():
    target = YahooPriceTargetFetcher(FakeYahooClient(RY_TARGET_INFO)).fetch("ry.to")
    assert target.symbol == "RY.TO"
    assert target.currency == "CAD"
    assert target.target_mean == 220.0
    assert target.target_low == 190.0
    assert target.analyst_count == 14
    assert target.recommendation_key == "buy"
    assert target.upside == pytest.approx(0.10)


def test_price_target_without_coverage_is_empty_not_an_error():
    info = {"shortName": "Tiny Co", "regularMarketPrice": 1.5, "recommendationKey": "none"}
    target = YahooPriceTargetFetcher(FakeYahooClient(info)).fetch("TINY.V")
    assert target.current_price == 1.5  # falls back to regularMarketPrice
    assert target.target_mean is None
    assert target.recommendation_key is None
    assert target.upside is None


def test_price_target_unknown_symbol_raises_not_found():
    with pytest.raises(SymbolNotFoundError):
        YahooPriceTargetFetcher(FakeYahooClient({})).fetch("ZZZZNOTREAL")


def _grades_frame() -> pd.DataFrame:
    index = pd.DatetimeIndex(
        ["2026-11-10 12:00", "2026-10-01 09:30", "2026-11-03 08:00", "2025-01-01"],
        name="GradeDate",
    )
    return pd.DataFrame(
        {
            "Firm": ["RBC Capital", "Scotiabank", "TD Securities", "Old Firm"],
            "ToGrade": ["Outperform", "Sector Perform", "Buy", "Hold"],
            "FromGrade": ["Sector Perform", "", "Hold", ""],
            "Action": ["up", "main", "up", "init"],
            "priceTargetAction": ["Raises", "Maintains", "Raises", "Announces"],
            "currentPriceTarget": [230.0, 205.0, 0.0, 150.0],
            "priorPriceTarget": [210.0, 205.0, 0.0, 0.0],
        },
        index=index,
    )


def test_rating_actions_filter_by_period_and_sort_oldest_first():
    client = FakeYahooClient(grades=_grades_frame())
    period = DateRange(date(2026, 10, 1), date(2026, 11, 14))
    actions = YahooRatingActionFetcher(client).fetch("RY.TO", period)
    assert [a.firm for a in actions] == ["Scotiabank", "TD Securities", "RBC Capital"]
    rbc = actions[-1]
    assert rbc.symbol == "RY.TO"
    assert rbc.graded_at == datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
    assert rbc.action == "up"
    assert rbc.from_grade == "Sector Perform"
    assert rbc.price_target == 230.0
    assert rbc.prior_price_target == 210.0
    assert actions[0].from_grade is None  # empty string
    assert actions[1].price_target is None  # 0 means no target


def test_rating_actions_without_target_columns():
    frame = _grades_frame()[["Firm", "ToGrade", "FromGrade", "Action"]]
    client = FakeYahooClient(grades=frame)
    actions = YahooRatingActionFetcher(client).fetch("RY.TO", DateRange.last_days(365, date(2026, 11, 14)))
    assert len(actions) == 3
    assert all(a.price_target is None and a.price_target_action is None for a in actions)


def test_rating_actions_empty():
    client = FakeYahooClient()
    assert YahooRatingActionFetcher(client).fetch("RY.TO", DateRange.last_days(30)) == []


class FakeGradesTicker:
    upgrades_downgrades = None


def test_client_upgrades_downgrades_none_becomes_empty_frame():
    client = YahooClient(ticker_factory=lambda symbol: FakeGradesTicker())
    frame = client.upgrades_downgrades("RY.TO")
    assert isinstance(frame, pd.DataFrame) and frame.empty
