'use strict';
// Report data sheet (no agent call).
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBrief, periodStart, PERIODS } = require('../app/reports');

const HISTORY = [
  { date: '2025-11-14', value: 900 },
  { date: '2026-10-14', value: 950 },
  { date: '2026-11-06', value: 980 },
  { date: '2026-11-13', value: 990 },
  { date: '2026-11-14', value: 1000 },
];

const PORTFOLIO = {
  currency: 'CAD',
  asOf: '2026-11-14',
  summary: { totalValue: 1000, investedValue: 900, cash: 100, cost: 800, gain: 100, gainPct: 0.125, dayChange: 10, dayChangePct: 0.0101 },
  holdings: [
    { symbol: 'RY.TO', name: 'Royal Bank', sector: 'Finance', quantity: 5, available: true, marketValue: 900,
      weight: 0.9, gain: 100, gainPct: 0.125, dayChangePct: 0.01 },
    { symbol: 'NOPE', name: 'NOPE', quantity: 1, available: false, marketValue: 0, weight: 0 },
  ],
  history: HISTORY,
  news: [
    { publishedAt: '2026-11-14T10:00:00Z', sector: 'Finance', symbols: ['RY'], source: 'Fil', title: 'Récent', summary: 'r' },
    { publishedAt: '2026-11-01T10:00:00Z', sector: 'Finance', symbols: ['RY'], source: 'Fil', title: 'Ancien', summary: 'a' },
    { publishedAt: '2026-11-14T09:00:00Z', sector: 'Énergie', symbols: ['ENB'], source: 'Fil', title: 'Hors portefeuille', summary: 'h' },
  ],
};

const NOW = Date.parse('2026-11-14T12:00:00Z');

test('periodStart picks the last close on or before the cutoff', () => {
  assert.equal(periodStart(HISTORY, 1, '2026-11-14').date, '2026-11-13');
  assert.equal(periodStart(HISTORY, 7, '2026-11-14').date, '2026-11-06');
  assert.equal(periodStart(HISTORY, 30, '2026-11-14').date, '2026-10-14');
  assert.equal(periodStart(HISTORY, 365, '2026-11-14').date, '2025-11-14');
  assert.equal(periodStart(HISTORY.slice(0, 1), 7, '2026-11-14'), null);
});

test('brief covers the period, holdings, related news and profile', () => {
  const weekly = buildBrief({ period: 'weekly', portfolio: PORTFOLIO, profile: null, now: NOW });
  assert.match(weekly, /rapport hebdomadaire/);
  assert.match(weekly, /\+2,04 %/); // 980 -> 1000
  assert.match(weekly, /RY\.TO ; Royal Bank ; Finance/);
  assert.match(weekly, /NOPE ; cours indisponible/);
  assert.match(weekly, /Finance : 90,0 %/);
  assert.match(weekly, /Récent/);
  assert.doesNotMatch(weekly, /Ancien/);
  assert.doesNotMatch(weekly, /Hors portefeuille/);
  assert.match(weekly, /Profil investisseur non renseign/);

  const yearly = buildBrief({ period: 'yearly', portfolio: PORTFOLIO, profile: null, now: NOW });
  assert.match(yearly, /\+11,11 %/); // 900 -> 1000
  assert.match(yearly, /Ancien/);
});

test('every period has a label and title', () => {
  assert.deepEqual(Object.keys(PERIODS), ['daily', 'weekly', 'monthly', 'yearly']);
  for (const p of Object.values(PERIODS)) assert.ok(p.label && p.title && p.days);
});
