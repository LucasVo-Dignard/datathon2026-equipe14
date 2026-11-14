"""Helpers that turn loosely-typed provider values into clean Python values.

Providers return ``None``, ``""``, ``"N/A"``, NaN or numbers as strings. These
helpers return ``None`` for anything unusable so mappers stay simple.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from typing import Any


def to_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(result) or math.isinf(result) else result


def to_int(value: Any) -> int | None:
    number = to_float(value)
    return None if number is None else int(number)


def to_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def to_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = to_text(value)
    if text is None:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def scaled(value: Any, factor: float) -> float | None:
    """Multiply a numeric value, e.g. millions -> units or percent -> fraction."""
    number = to_float(value)
    return None if number is None else number * factor


def first_present(raw: Mapping[str, Any], keys: Sequence[str]) -> Any:
    """Value of the first key whose value is usable as a number.

    Useful when a provider has several names for the same metric.
    """
    for key in keys:
        if to_float(raw.get(key)) is not None:
            return raw[key]
    return None
