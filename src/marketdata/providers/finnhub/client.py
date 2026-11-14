"""HTTP client for the Finnhub REST API.

Its only job is transport: authentication, rate limiting, retries and turning
HTTP failures into ``marketdata`` errors. It returns raw JSON; mapping JSON to
models is done in ``mappers.py``.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Mapping
from typing import Any

import requests

from marketdata.errors import (
    AuthenticationError,
    ConfigurationError,
    ProviderError,
    RateLimitError,
)
from marketdata.http.rate_limiter import RateLimiter
from marketdata.http.retry import RetryPolicy

PROVIDER = "finnhub"
API_KEY_ENV_VAR = "FINNHUB_API_KEY"


class FinnhubClient:
    BASE_URL = "https://finnhub.io/api/v1"
    # Free plan: 60 calls/minute per API key.
    DEFAULT_CALLS_PER_MINUTE = 60

    def __init__(
        self,
        api_key: str,
        *,
        session: requests.Session | None = None,
        rate_limiter: RateLimiter | None = None,
        retry: RetryPolicy | None = None,
        timeout_seconds: float = 10.0,
        sleep: Callable[[float], None] = time.sleep,
        base_url: str = BASE_URL,
    ) -> None:
        if not api_key:
            raise ConfigurationError("Finnhub API key is empty")
        self._api_key = api_key
        self._session = session or requests.Session()
        self._rate_limiter = rate_limiter or RateLimiter(self.DEFAULT_CALLS_PER_MINUTE, 60.0)
        self._retry = retry or RetryPolicy()
        self._timeout = timeout_seconds
        self._sleep = sleep
        self._base_url = base_url.rstrip("/")

    @classmethod
    def from_env(cls, env_var: str = API_KEY_ENV_VAR, **kwargs: Any) -> FinnhubClient:
        api_key = os.environ.get(env_var, "").strip()
        if not api_key:
            raise ConfigurationError(
                f"Environment variable {env_var} is not set. "
                "Put it in .env-finnhub and load it with: set -a; source .env-finnhub; set +a"
            )
        return cls(api_key, **kwargs)

    def get(self, path: str, params: Mapping[str, Any] | None = None) -> Any:
        """GET ``path`` (e.g. ``"/stock/profile2"``) and return the decoded JSON."""
        url = f"{self._base_url}/{path.lstrip('/')}"
        attempt = 0
        while True:
            attempt += 1
            self._rate_limiter.acquire()
            try:
                response = self._session.get(
                    url,
                    params=dict(params or {}),
                    # Header rather than query string, so the key never
                    # appears in URLs, logs or exception messages.
                    headers={"X-Finnhub-Token": self._api_key},
                    timeout=self._timeout,
                )
            except requests.RequestException as exc:
                if self._retry.is_last(attempt):
                    raise ProviderError(PROVIDER, f"request to {path} failed: {exc}") from exc
                self._sleep(self._retry.delay_after(attempt))
                continue

            status = response.status_code
            if status in (401, 403):
                raise AuthenticationError(
                    PROVIDER,
                    f"HTTP {status} on {path}: invalid API key or endpoint not in our plan",
                )
            if status == 429 or status >= 500:
                if self._retry.is_last(attempt):
                    error = RateLimitError if status == 429 else ProviderError
                    raise error(PROVIDER, f"HTTP {status} on {path} after {attempt} attempts")
                self._sleep(self._retry.delay_after(attempt))
                continue
            if status >= 400:
                raise ProviderError(PROVIDER, f"HTTP {status} on {path}: {response.text[:200]}")

            try:
                return response.json()
            except ValueError as exc:
                raise ProviderError(PROVIDER, f"invalid JSON from {path}") from exc
