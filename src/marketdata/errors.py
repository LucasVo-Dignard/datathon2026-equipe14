"""Exceptions raised by the marketdata package.

Callers only need to catch ``MarketDataError``; the subclasses let them react
to specific cases (unknown symbol, rate limit, bad API key).
"""


class MarketDataError(Exception):
    """Base class for every error raised by this package."""


class ConfigurationError(MarketDataError):
    """Required configuration (for example an API key) is missing or invalid."""


class ProviderError(MarketDataError):
    """A data provider failed or returned something unusable."""

    def __init__(self, provider: str, message: str) -> None:
        self.provider = provider
        super().__init__(f"[{provider}] {message}")


class SymbolNotFoundError(ProviderError):
    """The provider has no data for this symbol."""

    def __init__(self, provider: str, symbol: str) -> None:
        self.symbol = symbol
        super().__init__(provider, f"no data for symbol {symbol!r}")


class RateLimitError(ProviderError):
    """The provider rejected the request because of its rate limit."""


class AuthenticationError(ProviderError):
    """The API key is invalid, or the endpoint is not included in our plan."""
