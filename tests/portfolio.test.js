'use strict';
// Portfolio service with the JSON store and a fake stock lookup (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioStore } = require('../app/portfolio-store');
const { createPortfolioService, parseQuantity, RANDOM_SIZE } = require('../app/portfolio');

const QUOTES = {
  'RY.TO': { symbol: 'RY.TO', name: 'Royal Bank', currency: 'CAD', price: 170, change: 2 },
  AAPL: { symbol: 'AAPL', name: 'Apple', currency: 'USD', price: 200, change: -2 },
  'USDCAD=X': { symbol: 'USDCAD=X', name: 'USD/CAD', currency: 'CAD', price: 1.4, change: 0 },
  'VOD.L': { symbol: 'VOD.L', name: 'Vodafone', currency: 'GBp', price: 70, change: null },
  'GBPCAD=X': { symbol: 'GBPCAD=X', name: 'GBP/CAD', currency: 'CAD', price: 1.8, change: 0 },
};

function setup() {
  const db = { users: { alice: { createdAt: 1 } }, sessions: {}, chats: {} };
  const store = createPortfolioStore({ db, saveDb: () => {}, connectionString: '' });
  const stocks = {
    async lookup(symbol) { return QUOTES[symbol] || null; },
    async randomSymbols(n) { return ['RY.TO', 'AAPL', 'NOPE', 'VOD.L'].slice(0, n); },
  };
  const service = createPortfolioService({ store, stocks, random: () => 0.5, log: { error() {} } });
  return { db, service };
}

test('parseQuantity', () => {
  assert.equal(parseQuantity(10), 10);
  assert.equal(parseQuantity('2,5'), 2.5);
  assert.equal(parseQuantity(0.123456), 0.1235);
  for (const bad of [0, -1, 'abc', null, undefined, Infinity, 1e8]) assert.throws(() => parseQuantity(bad));
});

test('no portfolio until the user chooses', async () => {
  const { service } = setup();
  assert.equal(await service.get('alice'), null);
  await assert.rejects(service.create('alice', 'other'), /Mode invalide/);
});

test('random portfolio picks priced symbols and values them in CAD', async () => {
  const { db, service } = setup();
  const p = await service.create('alice', 'random');
  assert.equal(p.source, 'random');
  assert.ok(RANDOM_SIZE >= 3);
  assert.deepEqual(p.holdings.map((h) => h.symbol).sort(), ['AAPL', 'RY.TO', 'VOD.L']);
  const aapl = p.holdings.find((h) => h.symbol === 'AAPL');
  assert.equal(aapl.price, 280); // 200 USD * 1.4
  const vod = p.holdings.find((h) => h.symbol === 'VOD.L');
  assert.equal(vod.price, 1.26); // 70 pence * 1.8 / 100
  assert.ok(p.summary.cash > 0);
  assert.ok(p.history.length > 200);
  assert.equal(db.users.alice.createdAt, 1, 'keeps existing user fields');
});

test('custom portfolio: add, edit the quantity, remove', async () => {
  const { service } = setup();
  let p = await service.create('alice', 'custom');
  assert.deepEqual(p.holdings, []);
  assert.deepEqual(p.history, []);
  assert.equal(p.summary.totalValue, 0);

  p = await service.setQuantity('alice', 'RY.TO', 10);
  assert.equal(p.holdings[0].quantity, 10);
  assert.equal(p.holdings[0].avgCost, 170);
  assert.equal(p.summary.totalValue, 1700);
  assert.equal(p.holdings[0].dayChange, 20);

  p = await service.setQuantity('alice', 'RY.TO', '25');
  assert.equal(p.holdings.length, 1);
  assert.equal(p.holdings[0].quantity, 25);
  assert.equal(p.holdings[0].avgCost, 170, 'editing keeps the cost basis');

  await assert.rejects(service.setQuantity('alice', 'NOPE', 1), /Aucune donnée/);
  await assert.rejects(service.setQuantity('alice', 'RY.TO', 0), /Quantité invalide/);

  p = await service.remove('alice', 'RY.TO');
  assert.deepEqual(p.holdings, []);
});

test('adding a stock without choosing first creates a custom portfolio', async () => {
  const { service } = setup();
  const p = await service.setQuantity('alice', 'AAPL', 3);
  assert.equal(p.source, 'custom');
  assert.equal(p.holdings[0].marketValue, 840);
});
