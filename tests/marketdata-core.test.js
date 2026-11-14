'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter, RetryPolicy } = require('../src/marketdata/http');
const { firstPresent, scaled, toDate, toFloat, toInt, toText } = require('../src/marketdata/parsing');
const { DateRange, normalizeSymbol, addDays } = require('../src/marketdata/values');
const models = require('../src/marketdata/models');

test('normalizeSymbol', () => {
  assert.equal(normalizeSymbol('  ry.to '), 'RY.TO');
  assert.throws(() => normalizeSymbol('   '), RangeError);
  assert.throws(() => normalizeSymbol(undefined), RangeError);
});

test('DateRange validates and builds last days', () => {
  assert.throws(() => new DateRange('2026-01-02', '2026-01-01'), RangeError);
  assert.throws(() => new DateRange('2026-1-2', '2026-01-03'), RangeError);
  assert.deepEqual(DateRange.lastDays(7, '2026-11-14'), new DateRange('2026-11-08', '2026-11-14'));
  assert.ok(DateRange.lastDays(1, '2026-11-14').includes('2026-11-14'));
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('rate limiter waits when the window is full', async () => {
  let now = 0;
  const waits = [];
  const limiter = new RateLimiter(2, 60_000, {
    clock: () => now,
    wait: async (ms) => { waits.push(ms); now += ms; },
  });
  await limiter.acquire();
  now = 10_000;
  await limiter.acquire();
  assert.deepEqual(waits, []);
  await limiter.acquire(); // third call must wait until the first leaves the window
  assert.deepEqual(waits, [50_000]);
});

test('retry policy backoff', () => {
  const policy = new RetryPolicy({ maxAttempts: 3, backoffMs: 1000, factor: 2 });
  assert.deepEqual([1, 2, 3].map((n) => policy.delayAfter(n)), [1000, 2000, 4000]);
  assert.ok(policy.isLast(3) && !policy.isLast(2));
  assert.throws(() => new RetryPolicy({ maxAttempts: 0 }), RangeError);
});

test('parsing helpers', () => {
  assert.equal(toFloat('1.5'), 1.5);
  assert.equal(toFloat(NaN), null);
  assert.equal(toFloat('N/A'), null);
  assert.equal(toFloat(''), null);
  assert.equal(toFloat(true), null);
  assert.equal(toFloat(Infinity), null);
  assert.equal(toInt('7.9'), 7);
  assert.equal(toText('  '), null);
  assert.equal(scaled('2', 1_000_000), 2_000_000);
  assert.equal(toDate('2024-06-03'), '2024-06-03');
  assert.equal(toDate('2024-06-03T12:00:00Z'), '2024-06-03');
  assert.equal(toDate(new Date('2024-06-03T23:00:00Z')), '2024-06-03');
  assert.equal(toDate('2024-02-30'), null);
  assert.equal(toDate(''), null);
  assert.equal(firstPresent({ a: null, b: 'N/A', c: 3 }, ['a', 'b', 'c']), 3);
});

test('models fill defaults and check required fields', () => {
  const t = models.recommendationTrend({ symbol: 'X', period: '2026-11-01', provider: 'finnhub', buy: 3 });
  assert.equal(t.strongBuy, 0);
  assert.equal(models.recommendationTotal(t), 3);
  assert.ok(t.fetchedAt instanceof Date);
  assert.ok(Object.isFrozen(t));
  assert.throws(() => models.companyProfile({ symbol: 'X', provider: 'yahoo' }), /name is required/);
  assert.equal(models.upside(models.priceTargetConsensus({ symbol: 'X', provider: 'y', targetMean: 110, currentPrice: 100 })).toFixed(2), '0.10');
});
