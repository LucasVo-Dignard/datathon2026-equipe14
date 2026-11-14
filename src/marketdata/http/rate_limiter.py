"""Client-side rate limiting, so we stay under a provider's quota."""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable


class RateLimiter:
    """Sliding-window limiter: at most ``max_calls`` per ``period_seconds``.

    ``acquire()`` blocks until a call is allowed. It is thread-safe, so one
    instance can be shared by every fetcher that uses the same API key.
    """

    def __init__(
        self,
        max_calls: int,
        period_seconds: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if max_calls < 1 or period_seconds <= 0:
            raise ValueError("max_calls must be >= 1 and period_seconds > 0")
        self._max_calls = max_calls
        self._period = period_seconds
        self._clock = clock
        self._sleep = sleep
        self._calls: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        with self._lock:
            while True:
                now = self._clock()
                while self._calls and self._calls[0] <= now - self._period:
                    self._calls.popleft()
                if len(self._calls) < self._max_calls:
                    self._calls.append(now)
                    return
                self._sleep(self._calls[0] + self._period - now)
