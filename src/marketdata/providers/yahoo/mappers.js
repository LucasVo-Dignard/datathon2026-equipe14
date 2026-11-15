'use strict';
// Translate Yahoo data (from YahooClient) into marketdata models.
//
// Yahoo units: market cap is in units; margins, ROE and
// `trailingAnnualDividendYield` are already fractions. (`dividendYield` is
// not used: yfinance reported it as a percentage.)

const models = require('../../models');
const { toDate, toFloat, toInt, toText } = require('../../parsing');
const { PROVIDER } = require('./client');

// Yahoo has no quote summary (so an empty info) for unknown symbols.
function hasQuote(info) {
  return Boolean(info?.longName || info?.shortName);
}

function toProfile(symbol, info) {
  return models.companyProfile({
    symbol,
    name: toText(info.longName) || toText(info.shortName) || symbol,
    provider: PROVIDER,
    exchange: toText(info.fullExchangeName) || toText(info.exchange),
    currency: toText(info.currency),
    country: toText(info.country),
    sector: toText(info.sector),
    industry: toText(info.industry),
    marketCap: toFloat(info.marketCap),
    sharesOutstanding: toFloat(info.sharesOutstanding),
    website: toText(info.website),
    description: toText(info.longBusinessSummary),
  });
}

function toMetrics(symbol, info) {
  return models.financialMetrics({
    symbol,
    provider: PROVIDER,
    marketCap: toFloat(info.marketCap),
    peTtm: toFloat(info.trailingPE),
    forwardPe: toFloat(info.forwardPE),
    priceToBook: toFloat(info.priceToBook),
    epsTtm: toFloat(info.trailingEps),
    dividendYield: toFloat(info.trailingAnnualDividendYield),
    beta: toFloat(info.beta),
    week52High: toFloat(info.fiftyTwoWeekHigh),
    week52Low: toFloat(info.fiftyTwoWeekLow),
    netMargin: toFloat(info.profitMargins),
    returnOnEquity: toFloat(info.returnOnEquity),
    raw: { ...info },
  });
}

const PRICE_FIELDS = ['open', 'high', 'low', 'close', 'adjClose'];

// One bar per row; rows with a missing price or date are skipped.
function toPriceBars(symbol, rows, currency) {
  const bars = [];
  for (const row of rows) {
    const day = toDate(row.date);
    const values = Object.fromEntries(PRICE_FIELDS.map((f) => [f, toFloat(row[f])]));
    if (!day || PRICE_FIELDS.some((f) => values[f] == null)) continue;
    bars.push(models.priceBar({
      symbol,
      date: day,
      ...values,
      volume: toInt(row.volume) || 0,
      provider: PROVIDER,
      currency,
    }));
  }
  return bars;
}

// Consensus targets come from the same quote summary as the profile.
// `currentPrice` is missing for some listings, so fall back to the last
// regular-market price.
function toPriceTarget(symbol, info) {
  const recommendation = toText(info.recommendationKey);
  return models.priceTargetConsensus({
    symbol,
    provider: PROVIDER,
    currency: toText(info.currency),
    currentPrice: toFloat(info.currentPrice) ?? toFloat(info.regularMarketPrice),
    targetMean: toFloat(info.targetMeanPrice),
    targetMedian: toFloat(info.targetMedianPrice),
    targetHigh: toFloat(info.targetHighPrice),
    targetLow: toFloat(info.targetLowPrice),
    analystCount: toInt(info.numberOfAnalystOpinions),
    recommendationMean: toFloat(info.recommendationMean),
    // Yahoo uses "none" for symbols without coverage.
    recommendationKey: recommendation === 'none' ? null : recommendation,
  });
}

function toInstant(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// One action per row inside `period`, oldest first. Rows without a date or
// firm are skipped. Price-target fields are optional.
function toRatingActions(symbol, rows, period) {
  const actions = [];
  for (const row of rows) {
    const gradedAt = toInstant(row.gradedAt);
    const firm = toText(row.firm);
    if (!gradedAt || !firm || !period.includes(gradedAt.toISOString().slice(0, 10))) continue;
    actions.push(models.analystRatingAction({
      symbol,
      gradedAt,
      firm,
      provider: PROVIDER,
      action: toText(row.action),
      fromGrade: toText(row.fromGrade),
      toGrade: toText(row.toGrade),
      priceTargetAction: toText(row.priceTargetAction),
      // Yahoo reports 0 when a firm gives no target.
      priceTarget: toFloat(row.currentPriceTarget) || null,
      priorPriceTarget: toFloat(row.priorPriceTarget) || null,
    }));
  }
  return actions.sort((a, b) => a.gradedAt - b.gradedAt);
}

// Yahoo's fund sector keys -> the sector names Yahoo uses in company profiles,
// so a fund's weights add up with its stocks' sectors.
const FUND_SECTORS = {
  realestate: 'Real Estate',
  consumer_cyclical: 'Consumer Cyclical',
  basic_materials: 'Basic Materials',
  consumer_defensive: 'Consumer Defensive',
  technology: 'Technology',
  communication_services: 'Communication Services',
  financial_services: 'Financial Services',
  utilities: 'Utilities',
  industrials: 'Industrials',
  energy: 'Energy',
  healthcare: 'Healthcare',
};

function toFundComposition(symbol, fund) {
  const sectorWeights = {};
  for (const entry of fund.sectorWeightings || []) {
    for (const [key, value] of Object.entries(entry || {})) {
      const weight = toFloat(value);
      if (weight > 0) sectorWeights[FUND_SECTORS[key] || key] = weight;
    }
  }
  const topHoldings = (fund.holdings || [])
    .map((h) => ({ symbol: toText(h.symbol), name: toText(h.holdingName), weight: toFloat(h.holdingPercent) }))
    .filter((h) => (h.symbol || h.name) && h.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  return models.fundComposition({
    symbol,
    provider: PROVIDER,
    quoteType: toText(fund.quoteType)?.toUpperCase() || 'UNKNOWN',
    category: toText(fund.category),
    family: toText(fund.family),
    stockPosition: toFloat(fund.stockPosition),
    bondPosition: toFloat(fund.bondPosition),
    cashPosition: toFloat(fund.cashPosition),
    sectorWeights,
    topHoldings,
  });
}

module.exports = { hasQuote, toProfile, toMetrics, toPriceBars, toPriceTarget, toRatingActions, toFundComposition, FUND_SECTORS };
