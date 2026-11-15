'use strict';
// Portfolio service with the JSON store and a fake stock lookup (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioStore } = require('../app/portfolio-store');
const { createPortfolioService, parseQuantity, RANDOM_SIZE, RANDOM_FUNDS } = require('../app/portfolio');
const { tradable, RANDOM_ETFS } = require('../app/stocks');

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

test('random portfolio mixes stocks and ETFs, ETFs sized as the core', async () => {
  const db = { users: {}, sessions: {}, chats: {} };
  const store = createPortfolioStore({ db, saveDb: () => {}, connectionString: '' });
  const quotes = {
    ...QUOTES,
    'XEQT.TO': { symbol: 'XEQT.TO', name: 'iShares Core Equity', currency: 'CAD', price: 40, change: 0 },
    QQQ: { symbol: 'QQQ', name: 'Invesco QQQ', currency: 'USD', price: 500, change: 0 },
  };
  const stocks = {
    async lookup(symbol) { return quotes[symbol] || null; },
    async randomSymbols(n) { return ['RY.TO', 'AAPL', 'NOPE', 'VOD.L'].slice(0, n); },
    async randomFunds(n) { return ['GONE', 'XEQT.TO', 'QQQ', 'XEG.TO'].slice(0, n); },
    async fund(symbol) { return ['XEQT.TO', 'QQQ'].includes(symbol) ? { type: 'ETF', sectorWeights: {}, topHoldings: [] } : null; },
  };
  const service = createPortfolioService({ store, stocks, random: () => 0.5, log: { error() {} } });
  const p = await service.create('bob', 'random');
  assert.deepEqual(p.holdings.map((h) => h.symbol).sort(), ['AAPL', 'QQQ', 'RY.TO', 'VOD.L', 'XEQT.TO']);
  assert.equal(p.holdings.filter((h) => h.fund).length, RANDOM_FUNDS);
  const xeqt = p.holdings.find((h) => h.symbol === 'XEQT.TO');
  assert.equal(xeqt.quantity, 200); // (4000 + 0.5 × 8000) / 40
  assert.equal(p.holdings.find((h) => h.symbol === 'RY.TO').quantity, 28); // (1500 + 0.5 × 6500) / 170
});

test('random symbols: one batch request keeps only the ones Yahoo prices, in drawn order', async () => {
  const calls = [];
  const client = { async quotes(symbols) {
    calls.push(symbols);
    return [{ symbol: 'RY.TO', price: 288 }, { symbol: 'DEAD', price: null }, { symbol: '0669.HK', price: 141 }, { symbol: 'AAPL', price: 356 }];
  } };
  assert.deepEqual(await tradable(client, ['0669.HK', 'DEAD', 'GONE', 'RY.TO', 'AAPL'], 2), ['0669.HK', 'RY.TO']);
  assert.equal(calls.length, 1);
  assert.ok(RANDOM_ETFS.length >= 20 && new Set(RANDOM_ETFS).size === RANDOM_ETFS.length);
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
