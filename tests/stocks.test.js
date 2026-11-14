'use strict';
// The database mode (load on demand and save) is tested in marketdata-db.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStockLookup, normalizeSymbol } = require('../app/stocks');

test('normalizeSymbol', () => {
  assert.equal(normalizeSymbol(' ry '), 'RY');
  assert.equal(normalizeSymbol('ry.to'), 'RY.TO');
  assert.equal(normalizeSymbol('BRK-B'), 'BRK-B');
  assert.equal(normalizeSymbol(''), null);
  assert.equal(normalizeSymbol('a b'), null);
  assert.equal(normalizeSymbol('../etc'), null);
  assert.equal(normalizeSymbol('X'.repeat(16)), null);
  assert.equal(normalizeSymbol(42), null);
});

const fakeYahoo = (info, bars) => ({
  async info() { return info; },
  async upgradesDowngrades() { return []; },
  async history() { return { currency: 'CAD', bars }; },
});

test('without a database, the lookup asks Yahoo directly', async () => {
  const stocks = createStockLookup({
    connectionString: '',
    yahooClient: fakeYahoo({ longName: 'Royal Bank of Canada', fullExchangeName: 'Toronto', currency: 'CAD' }, [
      { date: '2026-11-12', open: 1, high: 1, low: 1, close: 169.9, adjClose: 169.9, volume: 1 },
      { date: '2026-11-13', open: 1, high: 1, low: 1, close: 171.25, adjClose: 171.25, volume: 1 },
    ]),
  });
  const ry = await stocks.lookup('RY.TO');
  assert.equal(ry.name, 'Royal Bank of Canada');
  assert.equal(ry.exchange, 'Toronto');
  assert.equal(ry.currency, 'CAD');
  assert.equal(ry.asOf, '2026-11-13');
  assert.equal(ry.source, 'yahoo');
  assert.ok(Math.abs(ry.change - 1.35) < 1e-9);
  assert.ok(Math.abs(ry.changePct - 1.35 / 169.9) < 1e-9);
});

test('unknown symbols give null', async () => {
  const stocks = createStockLookup({ connectionString: '', yahooClient: fakeYahoo({}, []) });
  assert.equal(await stocks.lookup('NOPE'), null);
});
