"""Small value objects shared by fetchers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta


def normalize_symbol(symbol: str) -> str:
    """Return the canonical form of a ticker (``" ry.to "`` -> ``"RY.TO"``).

    Yahoo and Finnhub both use the ``.TO`` suffix for TSX listings, so one
    format works for both providers.
    """
    cleaned = symbol.strip().upper()
    if not cleaned:
        raise ValueError("symbol must not be empty")
    return cleaned


@dataclass(frozen=True, slots=True)
class DateRange:
    """Inclusive range of calendar days."""

    start: date
    end: date

    def __post_init__(self) -> None:
        if self.start > self.end:
            raise ValueError(f"start {self.start} is after end {self.end}")

    @classmethod
    def last_days(cls, days: int, today: date | None = None) -> DateRange:
        """Range covering the ``days`` days that end on ``today`` (inclusive)."""
        if days < 1:
            raise ValueError("days must be at least 1")
        end = today or date.today()
        return cls(start=end - timedelta(days=days - 1), end=end)
