'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderError, RateLimitError } = require('../src/marketdata/errors');
const base = require('../src/marketdata/fetchers/base');
const { RateLimiter, RetryPolicy } = require('../src/marketdata/http');
const { parse } = require('../src/marketdata/jobs/macro-refresh');
const {
  DEFAULT_COUNTRIES,
  DEFAULT_INDICATORS,
  WorldBankClient,
  WorldBankIndicatorFetcher,
} = require('../src/marketdata/providers/worldbank');
const { YearRange, normalizeCode } = require('../src/marketdata/values');

const response = (status, payload) => ({
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

function makeClient(...responses) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const client = new WorldBankClient({
    fetch,
    rateLimiter: new RateLimiter(1000, 1000),
    retry: new RetryPolicy({ maxAttempts: 3, backoffMs: 0 }),
    wait: async () => {},
  });
  return { client, calls };
}

const row = (country, year, value, indicator = 'FP.CPI.TOTL.ZG') => ({
  indicator: { id: indicator, value: 'Inflation, consumer prices (annual %)' },
  country: { id: country.slice(0, 2), value: `${country} name` },
  countryiso3code: country,
  date: String(year),
  value,
});

// --- Values ------------------------------------------------------------------

test('normalizeCode uppercases and rejects anything unsafe in a URL', () => {
  assert.equal(normalizeCode(' ny.gdp.mktp.kd.zg '), 'NY.GDP.MKTP.KD.ZG');
  for (const bad of ['', 'CAN;USA', 'a/b', '../x', null]) assert.throws(() => normalizeCode(bad), RangeError);
});

test('YearRange', () => {
  const years = YearRange.lastYears(3, 2025);
  assert.deepEqual([years.start, years.end], [2023, 2025]);
  assert.ok(years.includes(2024) && !years.includes(2022));
  assert.throws(() => new YearRange(2025, 2020), RangeError);
  assert.throws(() => new YearRange(2020.5, 2021), RangeError);
});

// --- Client ------------------------------------------------------------------

test('client asks for JSON and follows every page', async () => {
  const { client, calls } = makeClient(
    response(200, [{ page: 1, pages: 2, lastupdated: '2026-11-11' }, [1, 2]]),
    response(200, [{ page: 2, pages: 2 }, [3]]));
  const { meta, rows } = await client.getAll('/country/CAN/indicator/X', { date: '2020:2025' });
  assert.deepEqual(rows, [1, 2, 3]);
  assert.equal(meta.lastupdated, '2026-11-11'); // first page's meta
  const first = new URL(calls[0]);
  assert.equal(first.pathname, '/v2/country/CAN/indicator/X');
  assert.equal(first.searchParams.get('format'), 'json');
  assert.equal(first.searchParams.get('date'), '2020:2025');
  assert.equal(first.searchParams.get('page'), '1');
  assert.equal(new URL(calls[1]).searchParams.get('page'), '2');
});

test('client handles a page without rows', async () => {
  const { client } = makeClient(response(200, [{ page: 1, pages: 0, total: 0 }, null]));
  assert.deepEqual((await client.getAll('/x')).rows, []);
});

test('client turns World Bank error messages into ProviderError', async () => {
  const { client, calls } = makeClient(response(200, [{ message: [{ id: '120', key: 'Invalid value',
    value: 'The provided parameter value is not valid' }] }]));
  await assert.rejects(client.getAll('/x'), (err) => err instanceof ProviderError && /not valid/.test(err.message));
  assert.equal(calls.length, 1);
});

test('client retries server errors, network errors and rate limits', async () => {
  const { client, calls } = makeClient(response(502), new TypeError('fetch failed'), response(200, [{ pages: 1 }, [1]]));
  assert.deepEqual((await client.getAll('/x')).rows, [1]);
  assert.equal(calls.length, 3);

  const limited = makeClient(response(429), response(429), response(429));
  await assert.rejects(limited.client.getAll('/x'), RateLimitError);
});

test('client rejects HTML or unexpected JSON', async () => {
  const html = { status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  await assert.rejects(makeClient(html).client.getAll('/x'), ProviderError);
  await assert.rejects(makeClient(response(200, { not: 'a list' })).client.getAll('/x'), ProviderError);
  await assert.rejects(makeClient(response(404, {})).client.getAll('/x'), ProviderError);
});

// --- Fetcher -------------------------------------------------------------------

const INDICATOR_META = {
  id: 'FP.CPI.TOTL.ZG',
  source: { id: '2', value: 'World Development Indicators' },
  sourceOrganization: 'International Financial Statistics database, International Monetary Fund (IMF)',
};

class FakeClient {
  constructor(rows, { meta = INDICATOR_META, failMeta = false } = {}) {
    this.rows = rows;
    this.meta = meta;
    this.failMeta = failMeta;
    this.calls = [];
  }

  async getAll(path, params) {
    this.calls.push([path, params]);
    if (path.startsWith('/indicator/')) {
      if (this.failMeta) throw new ProviderError('worldbank', 'HTTP 502');
      return { meta: {}, rows: [this.meta] };
    }
    return { meta: { lastupdated: '2026-11-11' }, rows: this.rows };
  }
}

test('fetcher implements the macro kind', () => {
  assert.ok(new WorldBankIndicatorFetcher(new FakeClient([])) instanceof base.MacroIndicatorFetcher);
  assert.equal(WorldBankIndicatorFetcher.provider, 'worldbank');
});

test('fetcher maps rows and skips missing values', async () => {
  const client = new FakeClient([
    row('CAN', 2025, null), // not published yet
    row('CAN', 2024, 2.38),
    row('USA', 2024, '2.95'),
    { ...row('WLD', 2024, 5.7), countryiso3code: '' }, // falls back to country.id
    { ...row('CAN', 2024, 1), date: '2024M01' }, // not yearly
    row('CAN', 1999, 1.7), // outside the range
  ]);
  const years = new YearRange(2020, 2025);
  const observations = await new WorldBankIndicatorFetcher(client).fetch('fp.cpi.totl.zg', ['can', ' usa '], years);

  assert.deepEqual(client.calls, [
    ['/indicator/FP.CPI.TOTL.ZG', undefined],
    ['/country/CAN;USA/indicator/FP.CPI.TOTL.ZG', { date: '2020:2025' }],
  ]);
  assert.deepEqual(observations.map((o) => [o.country, o.year, o.value]),
    [['CAN', 2024, 2.38], ['USA', 2024, 2.95], ['WL', 2024, 5.7]]);
  const [first] = observations;
  assert.equal(first.provider, 'worldbank');
  assert.equal(first.indicator, 'FP.CPI.TOTL.ZG');
  assert.equal(first.indicatorName, 'Inflation, consumer prices (annual %)');
  assert.equal(first.countryName, 'CAN name');
  assert.ok(first.fetchedAt instanceof Date);
  assert.ok(Object.isFrozen(first));
});

test('fetcher records where each value comes from', async () => {
  const client = new FakeClient([row('CAN', 2024, 2.38), row('USA', 2024, 2.95)]);
  const fetcher = new WorldBankIndicatorFetcher(client);
  const [can, usa] = await fetcher.fetch('FP.CPI.TOTL.ZG', ['CAN', 'USA'], new YearRange(2020, 2025));
  assert.equal(can.dataset, 'World Development Indicators');
  assert.match(can.sourceOrganization, /International Monetary Fund/);
  assert.equal(can.sourceUpdatedOn, '2026-11-11');
  assert.equal(can.sourceUrl, 'https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG?locations=CA');
  assert.equal(usa.sourceUrl, 'https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG?locations=US');

  await fetcher.fetch('FP.CPI.TOTL.ZG', ['CAN'], new YearRange(2020, 2025));
  assert.equal(client.calls.filter(([path]) => path.startsWith('/indicator/')).length, 1); // cached
});

test('fetcher still returns values when the indicator metadata fails', async () => {
  const client = new FakeClient([row('CAN', 2024, 2.38)], { failMeta: true });
  const [obs] = await new WorldBankIndicatorFetcher(client).fetch('FP.CPI.TOTL.ZG', ['CAN'], new YearRange(2020, 2025));
  assert.equal(obs.value, 2.38);
  assert.equal(obs.dataset, null);
  assert.equal(obs.sourceOrganization, null);
  assert.equal(obs.sourceUpdatedOn, '2026-11-11');
});

test('fetcher validates its arguments', async () => {
  const fetcher = new WorldBankIndicatorFetcher(new FakeClient([]));
  await assert.rejects(fetcher.fetch('X', ['CAN'], { start: 2020, end: 2025 }), TypeError);
  await assert.rejects(fetcher.fetch('X', [], new YearRange(2020, 2025)), RangeError);
  assert.deepEqual(await fetcher.fetch('X', 'CAN', new YearRange(2020, 2025)), []);
});

// --- Job arguments ---------------------------------------------------------------

test('macro job defaults', () => {
  const options = parse([]);
  assert.deepEqual(options.indicators, Object.keys(DEFAULT_INDICATORS));
  assert.deepEqual(options.countries, [...DEFAULT_COUNTRIES]);
  assert.equal(options.years.end - options.years.start, 9);
  assert.equal(options.dryRun, false);
});

test('macro job lists take several values', () => {
  const options = parse(['--countries', 'CAN', 'USA', '--indicators', 'A', 'B', '--years', '3', '--dry-run']);
  assert.deepEqual(options.countries, ['CAN', 'USA']);
  assert.deepEqual(options.indicators, ['A', 'B']);
  assert.equal(options.years.end - options.years.start, 2);
  assert.ok(options.dryRun);
  assert.throws(() => parse(['stray']), TypeError);
  assert.throws(() => parse(['--years', '0']), RangeError);
});
