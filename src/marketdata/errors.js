'use strict';
// Errors thrown by the marketdata package. Callers only need to catch
// MarketDataError; the subclasses let them react to specific cases (unknown
// symbol, rate limit, bad API key).

class MarketDataError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

// Required configuration (for example an API key) is missing or invalid.
class ConfigurationError extends MarketDataError {}

// A data provider failed or returned something unusable.
class ProviderError extends MarketDataError {
  constructor(provider, message, options) {
    super(`[${provider}] ${message}`, options);
    this.provider = provider;
  }
}

// The provider has no data for this symbol.
class SymbolNotFoundError extends ProviderError {
  constructor(provider, symbol) {
    super(provider, `no data for symbol '${symbol}'`);
    this.symbol = symbol;
  }
}

// The provider rejected the request because of its rate limit.
class RateLimitError extends ProviderError {}

// The API key is invalid, or the endpoint is not included in our plan.
class AuthenticationError extends ProviderError {}

module.exports = {
  MarketDataError,
  ConfigurationError,
  ProviderError,
  SymbolNotFoundError,
  RateLimitError,
  AuthenticationError,
};
