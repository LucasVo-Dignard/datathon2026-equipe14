from datetime import date

import pytest

from marketdata.http import RateLimiter, RetryPolicy
from marketdata.providers.parsing import first_present, scaled, to_date, to_float
from marketdata.values import DateRange, normalize_symbol


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def test_normalize_symbol():
    assert normalize_symbol("  ry.to ") == "RY.TO"
    with pytest.raises(ValueError):
        normalize_symbol("   ")


def test_date_range_validates_and_builds_last_days():
    with pytest.raises(ValueError):
        DateRange(date(2026, 1, 2), date(2026, 1, 1))
    period = DateRange.last_days(7, today=date(2026, 11, 14))
    assert period == DateRange(date(2026, 11, 8), date(2026, 11, 14))


def test_rate_limiter_waits_when_window_is_full():
    clock = FakeClock()
    limiter = RateLimiter(2, 60.0, clock=clock, sleep=clock.sleep)
    limiter.acquire()
    clock.now = 10.0
    limiter.acquire()
    assert clock.sleeps == []
    limiter.acquire()  # third call must wait until the first leaves the window
    assert clock.sleeps == [50.0]


def test_retry_policy_backoff():
    policy = RetryPolicy(max_attempts=3, backoff_seconds=1.0, backoff_factor=2.0)
    assert [policy.delay_after(n) for n in (1, 2, 3)] == [1.0, 2.0, 4.0]
    assert policy.is_last(3) and not policy.is_last(2)


def test_parsing_helpers():
    assert to_float("1.5") == 1.5
    assert to_float(float("nan")) is None
    assert to_float("N/A") is None
    assert to_float(True) is None
    assert scaled("2", 1_000_000) == 2_000_000
    assert to_date("2024-06-03") == date(2024, 6, 3)
    assert to_date("") is None
    assert first_present({"a": None, "b": "N/A", "c": 3}, ["a", "b", "c"]) == 3
