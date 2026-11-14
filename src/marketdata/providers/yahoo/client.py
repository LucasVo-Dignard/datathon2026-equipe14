"""Adapter around the ``yfinance`` library.

This is the only module that imports ``yfinance``. It hides the library's
quirks (exclusive end dates, its own exceptions) and returns plain data, so
fetchers can be tested with a fake client and the library can be replaced.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import pandas as pd
import yfinance as yf
from yfinance.exceptions import YFRateLimitError

from marketdata.errors import ProviderError, RateLimitError
from marketdata.http.rate_limiter import RateLimiter
from marketdata.values import DateRange

PROVIDER = "yahoo"


@dataclass(frozen=True, slots=True)
class YahooHistory:
    """Daily bars with columns Open, High, Low, Close, Adj Close, Volume."""

    frame: pd.DataFrame
    currency: str | None


class YahooClient:
    def __init__(
        self,
        *,
        ticker_factory: Callable[[str], Any] = yf.Ticker,
        rate_limiter: RateLimiter | None = None,
    ) -> None:
        self._ticker_factory = ticker_factory
        self._rate_limiter = rate_limiter

    def info(self, symbol: str) -> dict[str, Any]:
        """Quote summary (profile and key statistics). Unknown symbols give a
        dict without a name, not an exception."""
        return self._call(symbol, lambda ticker: dict(ticker.info or {}))

    def history(self, symbol: str, period: DateRange) -> YahooHistory:
        def load(ticker: Any) -> YahooHistory:
            frame = ticker.history(
                start=period.start.isoformat(),
                # yfinance treats `end` as exclusive; our ranges are inclusive.
                end=(period.end + timedelta(days=1)).isoformat(),
                interval="1d",
                auto_adjust=False,
                actions=False,
            )
            metadata = getattr(ticker, "history_metadata", None) or {}
            return YahooHistory(frame=frame, currency=metadata.get("currency"))

        return self._call(symbol, load)

    def upgrades_downgrades(self, symbol: str) -> pd.DataFrame:
        """Per-firm rating actions, indexed by GradeDate. Columns: Firm,
        ToGrade, FromGrade, Action and, in recent yfinance versions,
        priceTargetAction, currentPriceTarget, priorPriceTarget. Empty frame
        when Yahoo has nothing."""

        def load(ticker: Any) -> pd.DataFrame:
            frame = ticker.upgrades_downgrades
            return frame if isinstance(frame, pd.DataFrame) else pd.DataFrame()

        return self._call(symbol, load)

    def _call(self, symbol: str, action: Callable[[Any], Any]) -> Any:
        if self._rate_limiter is not None:
            self._rate_limiter.acquire()
        try:
            return action(self._ticker_factory(symbol))
        except YFRateLimitError as exc:
            raise RateLimitError(PROVIDER, f"rate limited while fetching {symbol}") from exc
        except Exception as exc:  # yfinance raises many unrelated exception types
            raise ProviderError(PROVIDER, f"failed to fetch {symbol}: {exc}") from exc
