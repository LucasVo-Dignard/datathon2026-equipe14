'use strict';
// Finnhub fetchers: each one fetches one kind of data. They share a single
// FinnhubClient, so they also share its rate limiter.

const { ProviderError, SymbolNotFoundError } = require('../../errors');
const base = require('../../fetchers/base');
const mappers = require('./mappers');
const { API_KEY_ENV_VAR, FinnhubClient, PROVIDER } = require('./client');

async function getList(client, path, params) {
  const payload = await client.get(path, params);
  if (!Array.isArray(payload)) throw new ProviderError(PROVIDER, `expected a list from ${path}`);
  return payload;
}

const present = (items) => items.filter((item) => item != null);

class FinnhubProfileFetcher extends base.ProfileFetcher {
  static provider = PROVIDER;

  async _fetch(symbol) {
    const raw = await this.client.get('/stock/profile2', { symbol });
    // Finnhub answers {} for unknown symbols.
    if (!raw || !Object.keys(raw).length) throw new SymbolNotFoundError(PROVIDER, symbol);
    return mappers.toProfile(symbol, raw);
  }
}

class FinnhubMetricsFetcher extends base.MetricsFetcher {
  static provider = PROVIDER;

  async _fetch(symbol) {
    const raw = await this.client.get('/stock/metric', { symbol, metric: 'all' });
    const metric = raw?.metric || {};
    if (!Object.keys(metric).length) throw new SymbolNotFoundError(PROVIDER, symbol);
    return mappers.toMetrics(symbol, metric);
  }
}

class FinnhubRecommendationFetcher extends base.RecommendationFetcher {
  static provider = PROVIDER;

  async _fetch(symbol) {
    const items = await getList(this.client, '/stock/recommendation', { symbol });
    return present(items.map((item) => mappers.toRecommendation(symbol, item)));
  }
}

// Company news. The free plan only covers about the last year.
class FinnhubNewsFetcher extends base.NewsFetcher {
  static provider = PROVIDER;

  async _fetch(symbol, period) {
    const items = await getList(this.client, '/company-news', { symbol, from: period.start, to: period.end });
    return present(items.map((item) => mappers.toNewsArticle(symbol, item)));
  }
}

class FinnhubEarningsFetcher extends base.EarningsFetcher {
  static provider = PROVIDER;

  async _fetch(symbol, period) {
    const raw = await this.client.get('/calendar/earnings', { symbol, from: period.start, to: period.end });
    const items = raw?.earningsCalendar || [];
    return present(items.map((item) => mappers.toEarningsEvent(symbol, item)));
  }
}

module.exports = {
  API_KEY_ENV_VAR,
  FinnhubClient,
  FinnhubProfileFetcher,
  FinnhubMetricsFetcher,
  FinnhubRecommendationFetcher,
  FinnhubNewsFetcher,
  FinnhubEarningsFetcher,
};
