'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AuthenticationError,
  ConfigurationError,
  ProviderError,
  RateLimitError,
  SymbolNotFoundError,
} = require('../src/marketdata/errors');
const base = require('../src/marketdata/fetchers/base');
const { RateLimiter, RetryPolicy } = require('../src/marketdata/http');
const {
  FinnhubClient,
  FinnhubEarningsFetcher,
  FinnhubMetricsFetcher,
  FinnhubNewsFetcher,
  FinnhubProfileFetcher,
  FinnhubRecommendationFetcher,
} = require('../src/marketdata/providers/finnhub');
const { recommendationTotal } = require('../src/marketdata/models');
const { DateRange } = require('../src/marketdata/values');

// --- Client ------------------------------------------------------------------

const response = (status, payload) => ({
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

function makeClient(...responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const client = new FinnhubClient('test-key', {
    fetch,
    rateLimiter: new RateLimiter(1000, 1000),
    retry: new RetryPolicy({ maxAttempts: 3, backoffMs: 0 }),
    wait: async () => {},
  });
  return { client, calls };
}

test('client sends the key in a header, not the URL', async () => {
  const { client, calls } = makeClient(response(200, { ok: true }));
  assert.deepEqual(await client.get('/quote', { symbol: 'AAPL' }), { ok: true });
  assert.equal(calls[0].url, 'https://finnhub.io/api/v1/quote?symbol=AAPL');
  assert.deepEqual(calls[0].headers, { 'X-Finnhub-Token': 'test-key' });
  assert.ok(!calls[0].url.includes('test-key'));
});

test('client retries rate limit and server errors', async () => {
  const { client, calls } = makeClient(response(429), response(503), response(200, [1]));
  assert.deepEqual(await client.get('/x'), [1]);
  assert.equal(calls.length, 3);
});

test('client raises after the last attempt', async () => {
  const { client } = makeClient(response(429), response(429), response(429));
  await assert.rejects(client.get('/x'), RateLimitError);
});

test('client retries network errors', async () => {
  const { client } = makeClient(new TypeError('fetch failed'), response(200, {}));
  assert.deepEqual(await client.get('/x'), {});
});

test('client auth errors are not retried', async () => {
  const { client, calls } = makeClient(response(403, { error: 'no access' }));
  await assert.rejects(client.get('/x'), AuthenticationError);
  assert.equal(calls.length, 1);
});

test('client other 4xx', async () => {
  const { client } = makeClient(response(422, { error: 'bad' }));
  await assert.rejects(client.get('/x'), ProviderError);
});

test('fromEnv requires a key', () => {
  assert.throws(() => FinnhubClient.fromEnv({}), ConfigurationError);
  assert.throws(() => new FinnhubClient(''), ConfigurationError);
});

// --- Fetchers (with a fake client returning canned JSON) -----------------------

class FakeClient {
  constructor(payloads) {
    this.payloads = payloads;
    this.calls = [];
  }

  async get(path, params) {
    this.calls.push([path, params]);
    return this.payloads[path];
  }
}

test('fetchers implement the abstract kinds', () => {
  const client = new FakeClient({});
  assert.ok(new FinnhubProfileFetcher(client) instanceof base.ProfileFetcher);
  assert.ok(new FinnhubMetricsFetcher(client) instanceof base.MetricsFetcher);
  assert.ok(new FinnhubNewsFetcher(client) instanceof base.NewsFetcher);
  assert.equal(FinnhubNewsFetcher.provider, 'finnhub');
});

test('profile converts millions and normalizes the symbol', async () => {
  const client = new FakeClient({
    '/stock/profile2': {
      name: 'NVIDIA Corp', exchange: 'NASDAQ NMS - GLOBAL MARKET',
      currency: 'USD', country: 'US', finnhubIndustry: 'Semiconductors',
      marketCapitalization: 3_900_000.5, shareOutstanding: 24_300,
      weburl: 'https://nvidia.com', logo: '', ipo: '1999-01-22',
    },
  });
  const profile = await new FinnhubProfileFetcher(client).fetch(' nvda ');
  assert.deepEqual(client.calls, [['/stock/profile2', { symbol: 'NVDA' }]]);
  assert.equal(profile.symbol, 'NVDA');
  assert.ok(Math.abs(profile.marketCap - 3_900_000.5e6) < 1);
  assert.equal(profile.sharesOutstanding, 24_300e6);
  assert.equal(profile.ipoDate, '1999-01-22');
  assert.equal(profile.logoUrl, null);
});

test('unknown symbol raises SymbolNotFoundError', async () => {
  const client = new FakeClient({ '/stock/profile2': {}, '/stock/metric': { metric: {} } });
  await assert.rejects(new FinnhubProfileFetcher(client).fetch('ZZZZ'), SymbolNotFoundError);
  await assert.rejects(new FinnhubMetricsFetcher(client).fetch('ZZZZ'), SymbolNotFoundError);
});

test('metrics convert percentages and use fallback keys', async () => {
  const client = new FakeClient({
    '/stock/metric': { metric: {
      peBasicExclExtraTTM: 45.2, epsTTM: 2.9, pbAnnual: 30,
      dividendYieldIndicatedAnnual: 0.03, beta: 1.7,
      '52WeekHigh': 212, '52WeekLow': 86.6,
      netProfitMarginTTM: 55.8, roeTTM: 119.2,
      marketCapitalization: 1000,
    } },
  });
  const metrics = await new FinnhubMetricsFetcher(client).fetch('NVDA');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  assert.equal(metrics.peTtm, 45.2);
  assert.equal(metrics.priceToBook, 30);
  near(metrics.dividendYield, 0.0003);
  near(metrics.netMargin, 0.558);
  near(metrics.returnOnEquity, 1.192);
  assert.equal(metrics.marketCap, 1e9);
  assert.equal(metrics.raw.beta, 1.7);
});

test('news maps items and skips incomplete ones', async () => {
  const client = new FakeClient({ '/company-news': [
    { id: 7, datetime: 1_700_000_000, headline: 'Big news', url: 'https://x/1',
      summary: '', source: 'Reuters', category: 'company', image: '' },
    { id: 8, datetime: 1_700_000_000, headline: '', url: 'https://x/2' },
  ] });
  const articles = await new FinnhubNewsFetcher(client).fetch('AAPL', new DateRange('2023-11-01', '2023-11-30'));
  assert.deepEqual(client.calls[0][1], { symbol: 'AAPL', from: '2023-11-01', to: '2023-11-30' });
  assert.equal(articles.length, 1);
  assert.equal(articles[0].externalId, '7');
  assert.equal(articles[0].publishedAt.getTime(), 1_700_000_000_000);
  assert.equal(articles[0].publisher, 'Reuters');
  assert.equal(articles[0].summary, null);
});

test('news rejects a non-list payload', async () => {
  const client = new FakeClient({ '/company-news': { error: '?' } });
  await assert.rejects(new FinnhubNewsFetcher(client).fetch('AAPL', DateRange.lastDays(1)), ProviderError);
});

test('earnings and recommendations', async () => {
  const client = new FakeClient({
    '/calendar/earnings': { earningsCalendar: [
      { date: '2026-11-19', symbol: 'NVDA', year: 2027, quarter: 3, hour: 'amc',
        epsEstimate: 1.2, epsActual: null, revenueEstimate: 5.4e10, revenueActual: null },
    ] },
    '/stock/recommendation': [
      { period: '2026-11-01', strongBuy: 20, buy: 30, hold: 5, sell: 1, strongSell: 0 },
    ],
  });
  const events = await new FinnhubEarningsFetcher(client).fetch('NVDA', DateRange.lastDays(30));
  assert.equal(events[0].date, '2026-11-19');
  assert.equal(events[0].hour, 'amc');
  assert.equal(events[0].epsActual, null);

  const trends = await new FinnhubRecommendationFetcher(client).fetch('NVDA');
  assert.equal(trends[0].period, '2026-11-01');
  assert.equal(recommendationTotal(trends[0]), 56);
});
