"""Translate yfinance output into ``marketdata`` models.

Yahoo units: market cap is in units; margins, ROE and
``trailingAnnualDividendYield`` are already fractions. (``dividendYield`` is a
percentage, which is why it is not used.)
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pandas as pd

from marketdata.models import (
    AnalystRatingAction,
    CompanyProfile,
    FinancialMetrics,
    PriceBar,
    PriceTargetConsensus,
)
from marketdata.providers.parsing import to_date, to_float, to_int, to_text
from marketdata.values import DateRange

PROVIDER = "yahoo"


def has_quote(info: Mapping[str, Any]) -> bool:
    """yfinance returns a near-empty dict for unknown symbols."""
    return bool(info.get("longName") or info.get("shortName"))


def to_profile(symbol: str, info: Mapping[str, Any]) -> CompanyProfile:
    return CompanyProfile(
        symbol=symbol,
        name=to_text(info.get("longName")) or to_text(info.get("shortName")) or symbol,
        provider=PROVIDER,
        exchange=to_text(info.get("fullExchangeName")) or to_text(info.get("exchange")),
        currency=to_text(info.get("currency")),
        country=to_text(info.get("country")),
        sector=to_text(info.get("sector")),
        industry=to_text(info.get("industry")),
        market_cap=to_float(info.get("marketCap")),
        shares_outstanding=to_float(info.get("sharesOutstanding")),
        website=to_text(info.get("website")),
        description=to_text(info.get("longBusinessSummary")),
    )


def to_metrics(symbol: str, info: Mapping[str, Any]) -> FinancialMetrics:
    return FinancialMetrics(
        symbol=symbol,
        provider=PROVIDER,
        market_cap=to_float(info.get("marketCap")),
        pe_ttm=to_float(info.get("trailingPE")),
        forward_pe=to_float(info.get("forwardPE")),
        price_to_book=to_float(info.get("priceToBook")),
        eps_ttm=to_float(info.get("trailingEps")),
        dividend_yield=to_float(info.get("trailingAnnualDividendYield")),
        beta=to_float(info.get("beta")),
        week52_high=to_float(info.get("fiftyTwoWeekHigh")),
        week52_low=to_float(info.get("fiftyTwoWeekLow")),
        net_margin=to_float(info.get("profitMargins")),
        return_on_equity=to_float(info.get("returnOnEquity")),
        raw=dict(info),
    )


def to_price_bars(symbol: str, frame: pd.DataFrame, currency: str | None) -> list[PriceBar]:
    """One bar per row; rows with a missing price are skipped."""
    bars: list[PriceBar] = []
    for timestamp, row in frame.iterrows():
        values = {
            name: to_float(row.get(column))
            for name, column in (
                ("open", "Open"),
                ("high", "High"),
                ("low", "Low"),
                ("close", "Close"),
                ("adj_close", "Adj Close"),
            )
        }
        bar_date = to_date(timestamp)
        if bar_date is None or any(value is None for value in values.values()):
            continue
        bars.append(
            PriceBar(
                symbol=symbol,
                date=bar_date,
                volume=to_int(row.get("Volume")) or 0,
                provider=PROVIDER,
                currency=currency,
                **values,
            )
        )
    return bars


def to_price_target(symbol: str, info: Mapping[str, Any]) -> PriceTargetConsensus:
    """Consensus targets come from the same quote summary as the profile.
    ``currentPrice`` is missing for some listings, so fall back to the last
    regular-market price."""
    current = to_float(info.get("currentPrice"))
    if current is None:
        current = to_float(info.get("regularMarketPrice"))
    recommendation = to_text(info.get("recommendationKey"))
    return PriceTargetConsensus(
        symbol=symbol,
        provider=PROVIDER,
        currency=to_text(info.get("currency")),
        current_price=current,
        target_mean=to_float(info.get("targetMeanPrice")),
        target_median=to_float(info.get("targetMedianPrice")),
        target_high=to_float(info.get("targetHighPrice")),
        target_low=to_float(info.get("targetLowPrice")),
        analyst_count=to_int(info.get("numberOfAnalystOpinions")),
        recommendation_mean=to_float(info.get("recommendationMean")),
        # Yahoo uses "none" for symbols without coverage.
        recommendation_key=None if recommendation == "none" else recommendation,
    )


def _to_utc(value: Any) -> datetime | None:
    try:
        timestamp = pd.Timestamp(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(timestamp):
        return None
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize(UTC)
    return timestamp.tz_convert(UTC).to_pydatetime()


def to_rating_actions(
    symbol: str, frame: pd.DataFrame, period: DateRange
) -> list[AnalystRatingAction]:
    """One action per row inside ``period``, oldest first. Rows without a
    date or firm are skipped. The price-target columns are optional because
    older yfinance versions don't return them."""
    actions: list[AnalystRatingAction] = []
    for index, row in frame.iterrows():
        graded_at = _to_utc(index)
        firm = to_text(row.get("Firm"))
        if graded_at is None or firm is None:
            continue
        if not period.start <= graded_at.date() <= period.end:
            continue
        actions.append(
            AnalystRatingAction(
                symbol=symbol,
                graded_at=graded_at,
                firm=firm,
                provider=PROVIDER,
                action=to_text(row.get("Action")),
                from_grade=to_text(row.get("FromGrade")),
                to_grade=to_text(row.get("ToGrade")),
                price_target_action=to_text(row.get("priceTargetAction")),
                # Yahoo reports 0 when a firm gives no target.
                price_target=to_float(row.get("currentPriceTarget")) or None,
                prior_price_target=to_float(row.get("priorPriceTarget")) or None,
            )
        )
    actions.sort(key=lambda action: action.graded_at)
    return actions
