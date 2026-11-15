'use strict';
// Report data sheet (no agent call).
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBrief, periodStart, periodFrom, analyze, highlights, exposures, issuerCountry, PERIODS } = require('../app/reports');

const HISTORY = [
  { date: '2025-11-14', value: 900 },
  { date: '2026-10-14', value: 950 },
  { date: '2026-11-06', value: 980 },
  { date: '2026-11-13', value: 990 },
  { date: '2026-11-14', value: 1000 },
];

const holding = (o) => ({ available: true, quantity: 3, price: 123.45, avgCost: 99.87, gain: 11, dayChange: 1, ...o });

const PORTFOLIO = {
  currency: 'CAD',
  asOf: '2026-11-14',
  summary: { totalValue: 1000, investedValue: 900, cash: 100, cost: 800, gain: 100, gainPct: 0.125, dayChange: 10, dayChangePct: 0.0101 },
  holdings: [
    holding({ symbol: 'RY.TO', name: 'Royal Bank', sector: 'Finance', country: 'Canada', currency: 'CAD',
      marketValue: 450, weight: 0.45, gainPct: 0.125, dayChangePct: 0.01 }),
    holding({ symbol: 'AAPL', name: 'Apple', sector: 'Technologie', country: null, currency: 'USD',
      marketValue: 360, weight: 0.36, gainPct: -0.05, dayChangePct: -0.02 }),
    holding({ symbol: 'ASML', name: 'ASML', sector: 'Technologie', country: 'Netherlands', currency: 'USD',
      marketValue: 90, weight: 0.09, gainPct: 0.3, dayChangePct: 0 }),
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
  assert.equal(periodStart(HISTORY, 1).date, '2026-11-13');
  assert.equal(periodStart(HISTORY, 7).date, '2026-11-06');
  assert.equal(periodStart(HISTORY, 30).date, '2026-10-14');
  assert.equal(periodStart(HISTORY, 365).date, '2025-11-14');
  assert.equal(periodStart(HISTORY.slice(0, 1), 7), null);
});

test('issuer country: profile first, else guessed from the listing', () => {
  assert.deepEqual(issuerCountry({ symbol: 'ASML', country: 'Netherlands' }), { country: 'Netherlands', inferred: false });
  assert.deepEqual(issuerCountry({ symbol: 'TD.TO' }), { country: 'Canada', inferred: true });
  assert.deepEqual(issuerCountry({ symbol: 'AAPL', currency: 'USD' }), { country: 'United States', inferred: true });
  assert.deepEqual(issuerCountry({ symbol: 'XYZ.ZZ' }), { country: null, inferred: true });
});

test('regional, currency and sector exposure', () => {
  const ex = exposures(PORTFOLIO);
  assert.deepEqual(ex.regions.map(([k, w]) => [k, w.toFixed(2)]), [['Amérique du Nord', '0.90'], ['Europe', '0.10']]);
  assert.deepEqual(ex.countries.map(([k]) => k), ['Canada', 'États-Unis', 'Pays-Bas']);
  // Currencies include cash (CAD): (450 + 100) / 1000 and 450 / 1000.
  assert.deepEqual(ex.currencies.map(([k, w]) => [k, w.toFixed(2)]), [['CAD', '0.55'], ['USD', '0.45']]);
  assert.deepEqual(ex.sectors.map(([k, w]) => [k, w.toFixed(2)]), [['Finance', '0.50'], ['Technologie', '0.50']]);
  assert.deepEqual(ex.inferred, ['AAPL']);
});

test('brief has percentages and dates, never amounts', () => {
  const weekly = buildBrief({ period: 'weekly', portfolio: PORTFOLIO, profile: null, now: NOW });
  assert.match(weekly, /rapport hebdomadaire/);
  assert.match(weekly, /du 6 novembre 2026 au 14 novembre 2026 : \+2,04 %/); // 980 -> 1000
  assert.match(weekly, /RY\.TO ; Royal Bank ; Finance ; Canada ; CAD ; 50,0 % ; variation indisponible ; \+12,50 %/);
  assert.match(weekly, /AAPL ; Apple ; Technologie ; États-Unis ; USD/);
  assert.match(weekly, /Liquidités : 10,0 %/);
  assert.match(weekly, /EXPOSITION PAR RÉGION[^\n]*\n- Amérique du Nord : 90,0 %\n- Europe : 10,0 %/);
  assert.match(weekly, /EXPOSITION PAR DEVISE[^\n]*\n- CAD : 55,0 %\n- USD : 45,0 %/);
  assert.match(weekly, /déduit de la place de cotation[^\n]*AAPL/);
  assert.match(weekly, /NOPE ; cours indisponible/);
  assert.match(weekly, /Récent/);
  assert.doesNotMatch(weekly, /Ancien|Hors portefeuille/);
  assert.match(weekly, /Profil investisseur non renseign/);
  // No money, prices or quantities: every number is a percentage, a date or a count.
  assert.doesNotMatch(weekly, /\$|123|99,87|450|360/);

  const yearly = buildBrief({ period: 'yearly', portfolio: PORTFOLIO, profile: null, now: NOW });
  assert.match(yearly, /\+11,11 %/); // 900 -> 1000
  assert.match(yearly, /Ancien/);
});

test('period reports use each stock\'s move over the period, never the last session', () => {
  assert.equal(periodFrom(PORTFOLIO, 'daily'), null);
  assert.equal(periodFrom(PORTFOLIO, 'monthly'), '2026-10-15');
  const changes = { 'RY.TO': { change: 0.04 }, AAPL: { change: -0.1 }, ASML: null };
  const monthly = buildBrief({ period: 'monthly', portfolio: PORTFOLIO, profile: null, changes, now: NOW });
  assert.doesNotMatch(monthly, /Dernière séance :|\+1,01 %|-2,00 %/); // summary and holdings day changes
  assert.match(monthly, /variation du cours sur la période/);
  assert.match(monthly, /RY\.TO ; Royal Bank ; Finance ; Canada ; CAD ; 50,0 % ; \+4,00 % ; \+12,50 %/);
  assert.match(monthly, /ASML ; ASML ; Technologie ; Pays-Bas ; USD ; 10,0 % ; variation indisponible/);
  assert.match(monthly, /CONTRIBUTIONS[^\n]*\n- RY\.TO : \+2,00 %\n- AAPL : -4,00 %/); // 50 % × 4 %, 40 % × -10 %

  const daily = buildBrief({ period: 'daily', portfolio: PORTFOLIO, profile: null, now: NOW });
  assert.match(daily, /Dernière séance, du 13 novembre 2026 au 14 novembre 2026 : \+1,01 %/);
  assert.match(daily, /RY\.TO ; [^\n]* ; \+1,00 % ; \+12,50 %/);

  const tiles = highlights(analyze({ period: 'monthly', portfolio: PORTFOLIO, changes }));
  assert.deepEqual(tiles.map((t) => [t.label, t.value, t.detail]), [
    ['Rendement mensuel', '+5,26 %', 'du 14 octobre 2026 au 14 novembre 2026'], // 950 -> 1000
    ['Meilleur titre', '+4,00 %', 'RY.TO'],
    ['Plus faible', '-10,00 %', 'AAPL'],
    ['Région principale', '90,0 %', 'Amérique du Nord'],
  ]);
});

test('every period has a label and title', () => {
  assert.deepEqual(Object.keys(PERIODS), ['daily', 'weekly', 'monthly', 'yearly']);
  for (const p of Object.values(PERIODS)) assert.ok(p.label && p.title && p.days);
});
