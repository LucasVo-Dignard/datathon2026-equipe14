'use strict';
// Global ranking of listed companies by market cap, from companiesmarketcap.com.
//
// The site publishes its whole ranking as one CSV (no API key):
//     "Rank","Name","Symbol","marketcap","price (USD)","country"
// Market caps and prices are in USD. Symbols use Yahoo's suffixes (RY.TO,
// 2222.SR, 0700.HK), so they can be passed to the Yahoo fetchers as is.
// Some names contain line breaks inside quotes, hence the small CSV parser.

const { ProviderError, RateLimitError } = require('../../errors');
const { RetryPolicy, sleep } = require('../../http');
const { normalizeSymbol } = require('../../values');

const PROVIDER = 'companiesmarketcap';
const CSV_URL = 'https://companiesmarketcap.com/?download=csv';

// RFC 4180 rows: quoted fields may contain commas, "" and line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim()));
}

// [{ rank, name, symbol, marketCapUsd, priceUsd, country }], by rank. Rows
// without a symbol or market cap are skipped, and a symbol listed twice keeps
// its best rank.
function toCompanies(text) {
  const [header, ...rows] = parseCsv(text);
  const index = Object.fromEntries((header || []).map((name, i) => [name.trim().toLowerCase(), i]));
  for (const column of ['rank', 'name', 'symbol', 'marketcap']) {
    if (!(column in index)) throw new ProviderError(PROVIDER, `CSV has no '${column}' column`);
  }
  const companies = new Map();
  for (const row of rows) {
    const value = (column) => row[index[column]]?.trim() ?? '';
    const marketCapUsd = Number(value('marketcap'));
    if (!value('symbol') || !(marketCapUsd > 0)) continue;
    const symbol = normalizeSymbol(value('symbol'));
    if (companies.has(symbol)) continue;
    companies.set(symbol, {
      rank: Number(value('rank')) || null,
      name: value('name').replace(/\s+/g, ' '),
      symbol,
      marketCapUsd,
      priceUsd: Number(value('price (usd)')) || null,
      country: value('country') || null,
    });
  }
  return [...companies.values()].sort((a, b) => b.marketCapUsd - a.marketCapUsd);
}

class CompaniesMarketCapClient {
  constructor({ fetch: fetchFn = globalThis.fetch, retry = new RetryPolicy(), timeoutMs = 60_000, wait = sleep,
    url = CSV_URL } = {}) {
    Object.assign(this, { fetchFn, retry, timeoutMs, wait, url });
  }

  // The `limit` largest companies, by market cap.
  async topCompanies(limit = 1000) {
    return toCompanies(await this.#download()).slice(0, limit);
  }

  async #download() {
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await this.fetchFn(this.url, {
          headers: { 'user-agent': 'Mozilla/5.0 (marketdata)' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (this.retry.isLast(attempt)) {
          throw new ProviderError(PROVIDER, `download failed: ${err.message}`, { cause: err });
        }
        await this.wait(this.retry.delayAfter(attempt));
        continue;
      }
      const { status } = response;
      if (status === 429 || status >= 500) {
        if (this.retry.isLast(attempt)) {
          const ErrorType = status === 429 ? RateLimitError : ProviderError;
          throw new ErrorType(PROVIDER, `HTTP ${status} after ${attempt} attempts`);
        }
        await this.wait(this.retry.delayAfter(attempt));
        continue;
      }
      if (status >= 400) throw new ProviderError(PROVIDER, `HTTP ${status}`);
      return response.text();
    }
  }
}

module.exports = { CompaniesMarketCapClient, PROVIDER, parseCsv, toCompanies };
