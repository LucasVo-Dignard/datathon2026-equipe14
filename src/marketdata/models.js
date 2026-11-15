'use strict';
// Provider-independent data models.
//
// Every fetcher returns these shapes, whatever the source, so the rest of the
// application never sees provider-specific JSON. Each model maps to one table
// (db/migrations).
//
// Conventions:
// - Amounts are in the listing currency, in units (not millions).
// - Ratios such as margins, ROE and dividend yield are fractions (0.25 = 25%).
// - `provider` records where the row came from (e.g. "yahoo").
// - Calendar days are "YYYY-MM-DD" strings; instants are Date objects (UTC).
// - `fetchedAt` lets us decide when cached data is stale.
//
// Each factory fills optional fields with null and returns a frozen object.

function model(name, required, optional) {
  return (fields) => {
    for (const key of required) {
      if (fields[key] == null) throw new TypeError(`${name}.${key} is required`);
    }
    const out = {};
    for (const key of required) out[key] = fields[key];
    for (const [key, fallback] of Object.entries(optional)) {
      out[key] = fields[key] ?? (typeof fallback === 'function' ? fallback() : fallback);
    }
    return Object.freeze(out);
  };
}

const now = () => new Date();

const companyProfile = model('CompanyProfile', ['symbol', 'name', 'provider'], {
  exchange: null,
  currency: null,
  country: null,
  sector: null,
  industry: null,
  marketCap: null,
  sharesOutstanding: null,
  website: null,
  logoUrl: null,
  ipoDate: null,
  description: null,
  fetchedAt: now,
});

// One daily OHLCV bar. `close` is split-adjusted only; `adjClose` is also
// adjusted for dividends and is the one to use for returns.
const priceBar = model('PriceBar', ['symbol', 'date', 'open', 'high', 'low', 'close', 'adjClose', 'volume', 'provider'], {
  currency: null,
  fetchedAt: now,
});

// Snapshot of key fundamentals. `raw` keeps every value the provider
// returned, so nothing is lost if we need another metric later.
const financialMetrics = model('FinancialMetrics', ['symbol', 'provider'], {
  marketCap: null,
  peTtm: null,
  forwardPe: null,
  priceToBook: null,
  epsTtm: null,
  dividendYield: null,
  beta: null,
  week52High: null,
  week52Low: null,
  netMargin: null,
  returnOnEquity: null,
  raw: () => ({}),
  fetchedAt: now,
});

const newsArticle = model('NewsArticle', ['symbol', 'externalId', 'publishedAt', 'headline', 'url', 'provider'], {
  summary: null,
  publisher: null,
  imageUrl: null,
  category: null,
  fetchedAt: now,
});

// A scheduled or past earnings release. `hour` is "bmo" (before market
// open), "amc" (after market close), "dmh" (during market hours) or null.
const earningsEvent = model('EarningsEvent', ['symbol', 'date', 'provider'], {
  fiscalYear: null,
  fiscalQuarter: null,
  hour: null,
  epsEstimate: null,
  epsActual: null,
  revenueEstimate: null,
  revenueActual: null,
  fetchedAt: now,
});

// Number of analysts per rating for one month (`period`).
const recommendationTrend = model('RecommendationTrend', ['symbol', 'period', 'provider'], {
  strongBuy: 0,
  buy: 0,
  hold: 0,
  sell: 0,
  strongSell: 0,
  fetchedAt: now,
});

function recommendationTotal(t) {
  return t.strongBuy + t.buy + t.hold + t.sell + t.strongSell;
}

// Snapshot of the analysts' consensus 12-month price target. Targets are null
// when no analyst covers the symbol. `recommendationMean` goes from 1 (strong
// buy) to 5 (strong sell); `recommendationKey` is the provider's label.
const priceTargetConsensus = model('PriceTargetConsensus', ['symbol', 'provider'], {
  currency: null,
  currentPrice: null,
  targetMean: null,
  targetMedian: null,
  targetHigh: null,
  targetLow: null,
  analystCount: null,
  recommendationMean: null,
  recommendationKey: null,
  fetchedAt: now,
});

// Mean target relative to the current price (0.2 = 20% upside).
function upside(t) {
  if (!t.targetMean || !t.currentPrice) return null;
  return t.targetMean / t.currentPrice - 1;
}

// One firm's rating or price-target change. `action` is the provider's code:
// "up", "down", "init", "main" (maintained) or "reit" (reiterated). Price
// targets are null when the firm changed only its rating.
const analystRatingAction = model('AnalystRatingAction', ['symbol', 'gradedAt', 'firm', 'provider'], {
  action: null,
  fromGrade: null,
  toGrade: null,
  priceTargetAction: null,
  priceTarget: null,
  priorPriceTarget: null,
  fetchedAt: now,
});

// What a fund holds. `quoteType` is the provider's security type ("ETF",
// "MUTUALFUND", "EQUITY", ...): non-funds get a composition too, with empty
// weights, so callers know the symbol was checked. `sectorWeights` maps a
// sector name (same names as CompanyProfile.sector) to a fraction;
// `topHoldings` is [{ symbol, name, weight }], largest first.
const fundComposition = model('FundComposition', ['symbol', 'provider', 'quoteType'], {
  category: null,
  family: null,
  stockPosition: null,
  bondPosition: null,
  cashPosition: null,
  sectorWeights: () => ({}),
  topHoldings: () => [],
  fetchedAt: now,
});

const FUND_TYPES = new Set(['ETF', 'MUTUALFUND']);
const isFund = (c) => FUND_TYPES.has(c?.quoteType);

module.exports = {
  companyProfile,
  priceBar,
  financialMetrics,
  newsArticle,
  earningsEvent,
  recommendationTrend,
  recommendationTotal,
  priceTargetConsensus,
  upside,
  analystRatingAction,
  fundComposition,
  isFund,
};
