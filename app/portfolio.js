'use strict';
// ---------------------------------------------------------------------------
// Portefeuille du client — données fictives codées en dur (prototype).
// Remplacez getPortfolio() par les vraies données du client plus tard.
// Tous les montants sont en CAD.
// ---------------------------------------------------------------------------

const CURRENCY = 'CAD';
const CASH = 2450.0;

const HOLDINGS = [
  { symbol: 'RY', name: 'Banque Royale du Canada', quantity: 40, avgCost: 128.4, price: 171.25, prevClose: 169.9 },
  { symbol: 'SHOP', name: 'Shopify', quantity: 25, avgCost: 92.1, price: 148.6, prevClose: 152.3 },
  { symbol: 'TD', name: 'Banque Toronto-Dominion', quantity: 60, avgCost: 84.7, price: 79.15, prevClose: 78.8 },
  { symbol: 'ENB', name: 'Enbridge', quantity: 80, avgCost: 49.2, price: 58.4, prevClose: 58.65 },
  { symbol: 'CNR', name: 'Canadien National', quantity: 20, avgCost: 158.0, price: 149.3, prevClose: 148.1 },
  { symbol: 'AAPL', name: 'Apple', quantity: 15, avgCost: 182.5, price: 231.4, prevClose: 229.0 },
  { symbol: 'MSFT', name: 'Microsoft', quantity: 10, avgCost: 335.0, price: 428.9, prevClose: 431.2 },
  { symbol: 'XEQT', name: 'iShares Core Equity ETF Portfolio', quantity: 120, avgCost: 28.6, price: 33.85, prevClose: 33.7 },
];

const round2 = (n) => Math.round(n * 100) / 100;

// Deterministic PRNG so the fake history is the same on every request.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// One year of daily closing values (weekdays), ending today at `total`,
// with yesterday's close at `prevTotal`.
function fakeHistory(total, prevTotal) {
  const rand = mulberry32(14);
  const days = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const start = new Date(d);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  for (; d >= start; d.setUTCDate(d.getUTCDate() - 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(isoDate(d));
  }
  // days[0] is today, going back in time.
  const values = [total, prevTotal];
  for (let i = 2; i < days.length; i++) {
    // Daily log return ~ drift + noise (Box-Muller), walked backwards.
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const r = 0.0006 + 0.0085 * z;
    values.push(values[i - 1] / Math.exp(r));
  }
  return days.map((date, i) => ({ date, value: round2(values[i]) })).reverse();
}

function getPortfolio(/* username */) {
  const holdings = HOLDINGS.map((h) => {
    const marketValue = h.quantity * h.price;
    const cost = h.quantity * h.avgCost;
    const dayChange = h.quantity * (h.price - h.prevClose);
    return {
      ...h,
      marketValue: round2(marketValue),
      cost: round2(cost),
      gain: round2(marketValue - cost),
      gainPct: (marketValue - cost) / cost,
      dayChange: round2(dayChange),
      dayChangePct: (h.price - h.prevClose) / h.prevClose,
    };
  });

  const invested = holdings.reduce((s, h) => s + h.marketValue, 0);
  const cost = holdings.reduce((s, h) => s + h.cost, 0);
  const dayChange = holdings.reduce((s, h) => s + h.dayChange, 0);
  const total = invested + CASH;
  for (const h of holdings) h.weight = h.marketValue / total;

  return {
    currency: CURRENCY,
    asOf: isoDate(new Date()),
    summary: {
      totalValue: round2(total),
      investedValue: round2(invested),
      cash: CASH,
      cost: round2(cost),
      gain: round2(invested - cost),
      gainPct: (invested - cost) / cost,
      dayChange: round2(dayChange),
      dayChangePct: dayChange / (total - dayChange),
    },
    holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
    history: fakeHistory(total, total - dayChange),
  };
}

module.exports = { getPortfolio };
