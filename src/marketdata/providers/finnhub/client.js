'use strict';
// HTTP client for the Finnhub REST API.
//
// Its only job is transport: authentication, rate limiting, retries and
// turning HTTP failures into marketdata errors. It returns raw JSON; mapping
// JSON to models is done in mappers.js.

const {
  AuthenticationError,
  ConfigurationError,
  ProviderError,
  RateLimitError,
} = require('../../errors');
const { RateLimiter, RetryPolicy, sleep } = require('../../http');

const PROVIDER = 'finnhub';
const API_KEY_ENV_VAR = 'FINNHUB_API_KEY';
const BASE_URL = 'https://finnhub.io/api/v1';
// Free plan: 60 calls/minute per API key.
const DEFAULT_CALLS_PER_MINUTE = 60;

class FinnhubClient {
  #apiKey;

  constructor(apiKey, {
    fetch: fetchFn = globalThis.fetch,
    rateLimiter = new RateLimiter(DEFAULT_CALLS_PER_MINUTE, 60_000),
    retry = new RetryPolicy(),
    timeoutMs = 10_000,
    wait = sleep,
    baseUrl = BASE_URL,
  } = {}) {
    if (!apiKey) throw new ConfigurationError('Finnhub API key is empty');
    this.#apiKey = apiKey;
    Object.assign(this, { fetchFn, rateLimiter, retry, timeoutMs, wait, baseUrl: baseUrl.replace(/\/+$/, '') });
  }

  static fromEnv(env = process.env, options = {}) {
    const apiKey = (env[API_KEY_ENV_VAR] || '').trim();
    if (!apiKey) {
      throw new ConfigurationError(
        `Environment variable ${API_KEY_ENV_VAR} is not set. ` +
        'Put it in .env-finnhub and load it with: set -a; source .env-finnhub; set +a');
    }
    return new FinnhubClient(apiKey, options);
  }

  // GET `path` (e.g. "/stock/profile2") and return the decoded JSON.
  async get(path, params = {}) {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    for (let attempt = 1; ; attempt++) {
      await this.rateLimiter.acquire();
      let response;
      try {
        response = await this.fetchFn(url, {
          // Header rather than query string, so the key never appears in
          // URLs, logs or error messages.
          headers: { 'X-Finnhub-Token': this.#apiKey },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (this.retry.isLast(attempt)) {
          throw new ProviderError(PROVIDER, `request to ${path} failed: ${err.message}`, { cause: err });
        }
        await this.wait(this.retry.delayAfter(attempt));
        continue;
      }

      const { status } = response;
      if (status === 401 || status === 403) {
        throw new AuthenticationError(PROVIDER, `HTTP ${status} on ${path}: invalid API key or endpoint not in our plan`);
      }
      if (status === 429 || status >= 500) {
        if (this.retry.isLast(attempt)) {
          const ErrorType = status === 429 ? RateLimitError : ProviderError;
          throw new ErrorType(PROVIDER, `HTTP ${status} on ${path} after ${attempt} attempts`);
        }
        await this.wait(this.retry.delayAfter(attempt));
        continue;
      }
      if (status >= 400) {
        const text = await response.text().catch(() => '');
        throw new ProviderError(PROVIDER, `HTTP ${status} on ${path}: ${text.slice(0, 200)}`);
      }

      try {
        return await response.json();
      } catch (err) {
        throw new ProviderError(PROVIDER, `invalid JSON from ${path}`, { cause: err });
      }
    }
  }
}

module.exports = { FinnhubClient, PROVIDER, API_KEY_ENV_VAR };
