'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, toCompanies, CompaniesMarketCapClient } = require('../src/marketdata/providers/companiesmarketcap');
const { main, parse } = require('../src/marketdata/jobs/populate-top-companies');
const { SymbolNotFoundError } = require('../src/marketdata/errors');
const models = require('../src/marketdata/models');

const quiet = { info() {}, warn() {} };

const CSV = [
  '"Rank","Name","Symbol","marketcap","price (USD)","country"',
  '"2","NVIDIA","NVDA","3932339044352","162.85","United States"',
  '"1","Apple","aapl","5177380175872","356.27","United States"',
  '"3","Seven Group Holdings\n (SGH)","SGH.AX","24168943078","29.79","Australia"',
  '"4","No cap","XXX","","1","Nowhere"',
  '"5","Royal Bank ""RBC""","RY.TO","200000000000","140","Canada"',
  '',
].join('\r\n');

test('parseCsv handles quotes, escaped quotes and line breaks in fields', () => {
  assert.deepEqual(parseCsv('a,"b,c"\n"d ""e""","f\ng"\n'), [['a', 'b,c'], ['d "e"', 'f\ng']]);
});

test('toCompanies sorts by market cap and skips rows without one', () => {
  const companies = toCompanies(CSV);
  assert.deepEqual(companies.map((c) => c.symbol), ['AAPL', 'NVDA', 'RY.TO', 'SGH.AX']);
  assert.equal(companies[2].name, 'Royal Bank "RBC"');
  assert.equal(companies[3].name, 'Seven Group Holdings (SGH)');
  assert.equal(companies[0].marketCapUsd, 5177380175872);
});

test('client returns the top N and retries server errors', async () => {
  const statuses = [503, 200];
  const client = new CompaniesMarketCapClient({
    fetch: async () => ({ status: statuses.shift(), text: async () => CSV }),
    wait: async () => {},
  });
  assert.deepEqual((await client.topCompanies(2)).map((c) => c.symbol), ['AAPL', 'NVDA']);
});

test('parse validates --limit', () => {
  assert.equal(parse([]).limit, 1000);
  assert.throws(() => parse(['--limit', '0']), RangeError);
});

function fakeDb() {
  const queries = [];
  return {
    queries,
    ended: false,
    async query(text, params) {
      queries.push({ text, params });
      if (/FROM company_profiles/.test(text)) return { rows: [{ symbol: 'NVDA' }] };
      return { rows: [] };
    },
    async end() { this.ended = true; },
  };
}

test('populate saves profiles and tracks known symbols only', async () => {
  const db = fakeDb();
  const fetched = [];
  const profiles = {
    constructor: { provider: 'yahoo' },
    async fetch(symbol) {
      fetched.push(symbol);
      if (symbol === 'SGH.AX') throw new SymbolNotFoundError('yahoo', symbol);
      return models.companyProfile({ symbol, name: symbol, provider: 'yahoo' });
    },
  };
  const ranking = { topCompanies: async (n) => toCompanies(CSV).slice(0, n) };
  const code = await main(['--skip-existing'], { log: quiet, connectFn: async () => db, ranking, profiles });

  assert.equal(code, 0);
  assert.ok(db.ended);
  assert.deepEqual(fetched, ['AAPL', 'RY.TO', 'SGH.AX']); // NVDA already has a profile
  const tracked = db.queries.filter((q) => /INSERT INTO tracked_symbols/.test(q.text)).map((q) => q.params[0]);
  assert.deepEqual(tracked, ['AAPL', 'NVDA', 'RY.TO']);
  assert.equal(db.queries.filter((q) => /INSERT INTO company_profiles/.test(q.text)).length, 2);
});
