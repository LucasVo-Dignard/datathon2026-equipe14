'use strict';
// Database tests.
//
// The connection and job-switch tests always run. The repository and refresh
// tests need a Postgres with the Flyway migrations applied (see db/README.md)
// and run only when TEST_DATABASE_URL is set, e.g.:
//
//     TEST_DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata npm test
//
// They only touch rows of the fake symbol ZZTEST.TO.
const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionConfig } = require('../src/marketdata/db/connection');
const repo = require('../src/marketdata/db/repositories');
const { ConfigurationError } = require('../src/marketdata/errors');
const { main, refreshEnabled } = require('../src/marketdata/jobs/daily-refresh');
const models = require('../src/marketdata/models');
const { refresh, refreshMacro } = require('../src/marketdata/refresh');
const { YearRange } = require('../src/marketdata/values');
const { createStockLookup } = require('../app/stocks');

const quiet = { info() {}, warn() {}, error() {} };

// --- connectionConfig() ---------------------------------------------------------

test('connectionConfig prefers DATABASE_URL', async () => {
  const config = await connectionConfig({ DATABASE_URL: 'postgres://x' }, {
    readSecret: () => assert.fail('must not read the secret'),
  });
  assert.equal(config.connectionString, 'postgres://x');
});

test('connectionConfig reads credentials from the secret and requires TLS', async () => {
  const secrets = [];
  const config = await connectionConfig(
    { DB_HOST: 'db.internal', DB_NAME: 'marketdata', DB_SECRET_ARN: 'arn:secret' },
    { readSecret: async (arn) => { secrets.push(arn); return { username: 'u', password: 'p' }; } });
  assert.deepEqual(secrets, ['arn:secret']);
  assert.equal(config.host, 'db.internal');
  assert.equal(config.port, 5432);
  assert.equal(config.user, 'u');
  assert.equal(config.password, 'p');
  assert.ok(config.ssl);
});

test('connectionConfig without config throws', async () => {
  await assert.rejects(connectionConfig({}), (err) => err instanceof ConfigurationError && /DB_HOST/.test(err.message));
});

// --- REFRESH_ENABLED --------------------------------------------------------------

test('refreshEnabled defaults on and accepts false values', () => {
  assert.ok(refreshEnabled({}));
  assert.ok(refreshEnabled({ REFRESH_ENABLED: 'true' }));
  for (const off of ['false', 'False', '0', 'no', 'off']) assert.ok(!refreshEnabled({ REFRESH_ENABLED: off }));
});

test('disabled job does nothing', async () => {
  const code = await main([], {
    env: { REFRESH_ENABLED: 'false' },
    log: quiet,
    connectFn: () => assert.fail('must not connect when disabled'),
  });
  assert.equal(code, 0);
});

// --- Against a real Postgres ------------------------------------------------------

const DB_URL = process.env.TEST_DATABASE_URL;
const SYMBOL = 'ZZTEST.TO';
const TABLES = ['company_profiles', 'price_bars', 'financial_metrics', 'price_target_consensus',
  'analyst_rating_actions', 'tracked_symbols'];

async function withDb(fn) {
  const { Client } = require('pg');
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const { rows } = await db.query("SELECT to_regclass('tracked_symbols') AS t");
  if (!rows[0].t) {
    await db.end();
    throw new Error('market data tables missing: apply the Flyway migrations to TEST_DATABASE_URL');
  }
  const cleanup = async () => {
    for (const table of TABLES) await db.query(`DELETE FROM ${table} WHERE symbol = $1`, [SYMBOL]);
  };
  await cleanup();
  try {
    await fn(db);
  } finally {
    await cleanup();
    await db.end();
  }
}

const count = async (db, table) =>
  Number((await db.query(`SELECT count(*) FROM ${table} WHERE symbol = $1`, [SYMBOL])).rows[0].count);

const needsDb = { skip: !DB_URL && 'TEST_DATABASE_URL not set' };

test('upserts are idempotent and snapshots accumulate', needsDb, () => withDb(async (db) => {
  const bar = models.priceBar({ symbol: SYMBOL, date: '2026-11-13', open: 1, high: 2, low: 0.5,
    close: 1.5, adjClose: 1.5, volume: 10, provider: 'yahoo' });
  const action = models.analystRatingAction({ symbol: SYMBOL, firm: 'RBC Capital', provider: 'yahoo',
    gradedAt: new Date('2026-11-12T16:00:00Z'), action: 'up', priceTarget: 230 });
  const target = models.priceTargetConsensus({ symbol: SYMBOL, provider: 'yahoo', targetMean: 220 });
  const metrics = models.financialMetrics({ symbol: SYMBOL, provider: 'yahoo', peTtm: 12,
    raw: { pe: NaN, officers: [{ since: new Date('2020-01-01') }] } });
  const profile = models.companyProfile({ symbol: SYMBOL, name: 'Test Co', provider: 'yahoo', ipoDate: '2001-02-03' });
  for (let i = 0; i < 2; i++) {
    await repo.savePriceBars(db, [bar]);
    await repo.saveRatingActions(db, [action, action]);
    await repo.savePriceTarget(db, target);
    await repo.saveMetrics(db, metrics);
    await repo.saveProfile(db, profile);
  }
  assert.equal(await count(db, 'price_bars'), 1);
  assert.equal(await count(db, 'analyst_rating_actions'), 1);
  assert.equal(await count(db, 'company_profiles'), 1);
  assert.equal(await count(db, 'price_target_consensus'), 2); // snapshots
  assert.equal(await count(db, 'financial_metrics'), 2);
  const { rows: [m] } = await db.query('SELECT raw FROM financial_metrics WHERE symbol = $1 LIMIT 1', [SYMBOL]);
  assert.deepEqual(m.raw, { pe: null, officers: [{ since: '2020-01-01T00:00:00.000Z' }] });

  const quote = await repo.latestQuote(db, SYMBOL);
  assert.equal(quote.name, 'Test Co');
  assert.equal(quote.price, 1.5);
  assert.equal(quote.asOf, '2026-11-13');
  assert.equal(quote.prevClose, null);
}));

test('refresh isolates failures and records them', needsDb, () => withDb(async (db) => {
  await db.query('INSERT INTO tracked_symbols (symbol) VALUES ($1)', [SYMBOL]);
  const target = models.priceTargetConsensus({ symbol: SYMBOL, provider: 'yahoo', targetMean: 1 });
  const ok = (tx) => repo.savePriceTarget(tx, target);
  const boom = async (tx) => {
    await repo.savePriceTarget(tx, target); // rolled back with its step
    throw new Error('yahoo down');
  };

  let report = await refresh(db, [SYMBOL], [['ok', ok], ['boom', boom]], { log: quiet });
  assert.deepEqual([report.succeeded, report.failed], [1, 1]);
  assert.ok(!report.nothingSucceeded);
  assert.equal(await count(db, 'price_target_consensus'), 1);
  let { rows: [row] } = await db.query('SELECT last_refreshed_at, last_error FROM tracked_symbols WHERE symbol = $1', [SYMBOL]);
  assert.equal(row.last_refreshed_at, null); // moves only on full success
  assert.equal(row.last_error, 'boom: yahoo down');

  report = await refresh(db, [SYMBOL], [['ok', ok]], { log: quiet });
  ({ rows: [row] } = await db.query('SELECT last_refreshed_at, last_error FROM tracked_symbols WHERE symbol = $1', [SYMBOL]));
  assert.ok(row.last_refreshed_at);
  assert.equal(row.last_error, null);
}));

test('refresh reports a total failure', needsDb, () => withDb(async (db) => {
  const boom = async () => { throw new Error('network down'); };
  assert.ok((await refresh(db, [SYMBOL], [['boom', boom]], { log: quiet })).nothingSucceeded);
}));

test('macro refresh upserts observations and isolates failures', needsDb, () => withDb(async (db) => {
  // Fake provider name, so only test rows are touched.
  const PROVIDER = 'zztest';
  const macroCount = async () => Number((await db.query(
    'SELECT count(*) FROM macro_observations WHERE provider = $1', [PROVIDER])).rows[0].count);
  const obs = (year, value) => models.macroObservation({ country: 'CAN', indicator: 'FP.CPI.TOTL.ZG', year, value,
    provider: PROVIDER, indicatorName: 'Inflation, consumer prices (annual %)',
    dataset: 'World Development Indicators', sourceOrganization: 'IMF', sourceUpdatedOn: '2026-11-11',
    sourceUrl: 'https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG?locations=CA' });
  let value = 2.4;
  const fetcher = {
    async fetch(indicator) {
      if (indicator === 'BROKEN') throw new Error('worldbank down');
      return [obs(2024, value), obs(2023, 3.9), obs(2023, 3.9)];
    },
  };
  const options = { indicators: ['FP.CPI.TOTL.ZG', 'BROKEN'], countries: ['CAN'], years: new YearRange(2023, 2024),
    log: quiet };
  try {
    let report = await refreshMacro(db, fetcher, options);
    assert.deepEqual([report.succeeded, report.failed], [1, 1]);
    assert.equal(await macroCount(), 2);

    value = 2.1; // revised
    report = await refreshMacro(db, fetcher, options);
    assert.equal(await macroCount(), 2);
    const { rows: [row] } = await db.query(
      'SELECT value FROM macro_observations WHERE provider = $1 AND year = 2024', [PROVIDER]);
    assert.equal(row.value, 2.1);
    const saved = (await repo.macroObservations(db)).find((o) => o.provider === PROVIDER && o.year === 2024);
    assert.deepEqual(
      [saved.dataset, saved.sourceOrganization, saved.sourceUpdatedOn, saved.sourceUrl],
      ['World Development Indicators', 'IMF', '2026-11-11',
        'https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG?locations=CA']);

    report = await refreshMacro(db, fetcher, { ...options, indicators: ['BROKEN'] });
    assert.ok(report.nothingSucceeded);
  } finally {
    await db.query('DELETE FROM macro_observations WHERE provider = $1', [PROVIDER]);
  }
}));

test('the job refreshes the symbols given on the command line', needsDb, () => withDb(async (db) => {
  const seen = [];
  const code = await main(['--symbols', 'zztest.to'], {
    env: { DATABASE_URL: DB_URL },
    log: quiet,
    steps: [['record', async (tx, s) => { seen.push(s); }]],
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [SYMBOL]);
}));

test('stock search loads a missing symbol into the database', needsDb, () => withDb(async (db) => {
  const calls = { info: 0, history: 0 };
  const yahooClient = {
    async info() {
      calls.info++;
      return { longName: 'Test Co', fullExchangeName: 'Toronto', currency: 'CAD', trailingPE: 10 };
    },
    async upgradesDowngrades() { return []; },
    async history() {
      calls.history++;
      return { currency: 'CAD', bars: [
        { date: '2026-11-12', open: 1, high: 1, low: 1, close: 10, adjClose: 10, volume: 1 },
        { date: '2026-11-13', open: 1, high: 1, low: 1, close: 11, adjClose: 11, volume: 1 },
      ] };
    },
  };
  let now = Date.now();
  const stocks = createStockLookup({ connectionString: DB_URL, yahooClient, now: () => now, log: quiet });
  try {
    const quote = await stocks.lookup(SYMBOL);
    assert.equal(quote.name, 'Test Co');
    assert.equal(quote.price, 11);
    assert.ok(Math.abs(quote.changePct - 0.1) < 1e-9);
    assert.equal(quote.source, 'yahoo');
    assert.equal(await count(db, 'company_profiles'), 1);
    assert.equal(await count(db, 'price_bars'), 2);
    assert.equal(await count(db, 'financial_metrics'), 1);

    await stocks.lookup(SYMBOL); // fresh: served from the database
    assert.equal(calls.history, 1);

    now += 2 * 60 * 60 * 1000; // stale: fetched again
    await stocks.lookup(SYMBOL);
    assert.equal(calls.history, 2);
  } finally {
    await stocks.close();
  }
}));
