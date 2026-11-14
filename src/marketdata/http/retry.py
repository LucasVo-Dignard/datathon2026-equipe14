"""Retry policy for transient provider failures."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Exponential backoff: wait ``backoff_seconds * backoff_factor ** (n - 1)``
    after the n-th failed attempt, for at most ``max_attempts`` attempts."""

    max_attempts: int = 3
    backoff_seconds: float = 1.0
    backoff_factor: float = 2.0

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")

    def delay_after(self, attempt: int) -> float:
        return self.backoff_seconds * self.backoff_factor ** (attempt - 1)

    def is_last(self, attempt: int) -> bool:
        return attempt >= self.max_attempts
