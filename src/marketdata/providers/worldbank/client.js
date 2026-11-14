'use strict';
// HTTP client for the World Bank Indicators API (v2).
//
// No API key. Transport only: rate limiting, retries, pagination and turning
// failures into marketdata errors. It returns raw JSON rows; mapping them to
// models is done in mappers.js.
//
// Every JSON response is `[meta, rows]`, where meta has `page` and `pages`.
// Errors come back either as `[{ message: [...] }]` with HTTP 200, or (for
// some invalid codes) as an HTML 502 page.

const { ProviderError, RateLimitError } = require('../../errors');
const { RateLimiter, RetryPolicy, sleep } = require('../../http');

const PROVIDER = 'worldbank';
const BASE_URL = 'https://api.worldbank.org/v2';
// No published quota; stay polite.
const DEFAULT_CALLS_PER_MINUTE = 60;
const PAGE_SIZE = 1000;

class WorldBankClient {
  constructor({
    fetch: fetchFn = globalThis.fetch,
    rateLimiter = new RateLimiter(DEFAULT_CALLS_PER_MINUTE, 60_000),
    retry = new RetryPolicy(),
    // The API is slow: 20-90 seconds per request is common.
    timeoutMs = 90_000,
    wait = sleep,
    baseUrl = BASE_URL,
  } = {}) {
    Object.assign(this, { fetchFn, rateLimiter, retry, timeoutMs, wait, baseUrl: baseUrl.replace(/\/+$/, '') });
  }

  // GET every page of `path` (e.g. "/country/CAN/indicator/FP.CPI.TOTL.ZG").
  // Returns `{ meta, rows }`: the first page's meta (`lastupdated`,
  // `sourceid`, ...) and the rows of all pages.
  async getAll(path, params = {}) {
    const rows = [];
    let first;
    for (let page = 1; ; page++) {
      const [meta, items] = await this.getPage(path, { ...params, page });
      first ??= meta || {};
      rows.push(...(items || []));
      if (page >= (Number(meta?.pages) || 1)) return { meta: first, rows };
    }
  }

  // GET one page and return `[meta, rows]`.
  async getPage(path, params = {}) {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries({ format: 'json', per_page: PAGE_SIZE, ...params })) {
      url.searchParams.set(key, String(value));
    }

    for (let attempt = 1; ; attempt++) {
      await this.rateLimiter.acquire();
      let response;
      try {
        response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (this.retry.isLast(attempt)) {
          throw new ProviderError(PROVIDER, `request to ${path} failed: ${err.message}`, { cause: err });
        }
        await this.wait(this.retry.delayAfter(attempt));
        continue;
      }

      const { status } = response;
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

      let payload;
      try {
        payload = await response.json();
      } catch (err) {
        throw new ProviderError(PROVIDER, `invalid JSON from ${path}`, { cause: err });
      }
      if (Array.isArray(payload?.[0]?.message)) {
        const reason = payload[0].message.map((m) => m.value || m.key).join('; ');
        throw new ProviderError(PROVIDER, `${path}: ${reason}`);
      }
      if (!Array.isArray(payload)) throw new ProviderError(PROVIDER, `unexpected response from ${path}`);
      return payload;
    }
  }
}

module.exports = { WorldBankClient, PROVIDER };
