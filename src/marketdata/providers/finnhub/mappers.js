'use strict';
// Translate Finnhub JSON into marketdata models.
//
// Finnhub units: market cap and shares outstanding are in millions; margins,
// ROE and dividend yield are percentages. They are converted here to units
// and fractions (see models.js).

const models = require('../../models');
const { firstPresent, scaled, toDate, toFloat, toInt, toText } = require('../../parsing');
const { PROVIDER } = require('./client');

const MILLION = 1_000_000;
const PERCENT = 0.01;

// Finnhub's /stock/metric has several names for some metrics; the first one
// present wins.
const METRIC_KEYS = {
  marketCap: ['marketCapitalization'],
  peTtm: ['peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM'],
  priceToBook: ['pbQuarterly', 'pbAnnual'],
  epsTtm: ['epsTTM', 'epsBasicExclExtraItemsTTM', 'epsInclExtraItemsTTM'],
  dividendYield: ['currentDividendYieldTTM', 'dividendYieldIndicatedAnnual'],
  beta: ['beta'],
  week52High: ['52WeekHigh'],
  week52Low: ['52WeekLow'],
  netMargin: ['netProfitMarginTTM', 'netProfitMarginAnnual'],
  returnOnEquity: ['roeTTM', 'roeRfy'],
};

function toProfile(symbol, raw) {
  return models.companyProfile({
    symbol,
    name: toText(raw.name) || symbol,
    provider: PROVIDER,
    exchange: toText(raw.exchange),
    currency: toText(raw.currency),
    country: toText(raw.country),
    industry: toText(raw.finnhubIndustry),
    marketCap: scaled(raw.marketCapitalization, MILLION),
    sharesOutstanding: scaled(raw.shareOutstanding, MILLION),
    website: toText(raw.weburl),
    logoUrl: toText(raw.logo),
    ipoDate: toDate(raw.ipo),
  });
}

// `metric` is the "metric" object of the /stock/metric response.
function toMetrics(symbol, metric) {
  const pick = (name) => firstPresent(metric, METRIC_KEYS[name]);
  return models.financialMetrics({
    symbol,
    provider: PROVIDER,
    marketCap: scaled(pick('marketCap'), MILLION),
    peTtm: toFloat(pick('peTtm')),
    priceToBook: toFloat(pick('priceToBook')),
    epsTtm: toFloat(pick('epsTtm')),
    dividendYield: scaled(pick('dividendYield'), PERCENT),
    beta: toFloat(pick('beta')),
    week52High: toFloat(pick('week52High')),
    week52Low: toFloat(pick('week52Low')),
    netMargin: scaled(pick('netMargin'), PERCENT),
    returnOnEquity: scaled(pick('returnOnEquity'), PERCENT),
    raw: { ...metric },
  });
}

// null for items missing the fields an article needs.
function toNewsArticle(symbol, raw) {
  const headline = toText(raw.headline);
  const url = toText(raw.url);
  const timestamp = toInt(raw.datetime);
  if (headline == null || url == null || timestamp == null) return null;
  return models.newsArticle({
    symbol,
    externalId: String(raw.id || url),
    publishedAt: new Date(timestamp * 1000),
    headline,
    url,
    provider: PROVIDER,
    summary: toText(raw.summary),
    publisher: toText(raw.source),
    imageUrl: toText(raw.image),
    category: toText(raw.category),
  });
}

function toEarningsEvent(symbol, raw) {
  const date = toDate(raw.date);
  if (date == null) return null;
  return models.earningsEvent({
    symbol,
    date,
    provider: PROVIDER,
    fiscalYear: toInt(raw.year),
    fiscalQuarter: toInt(raw.quarter),
    hour: toText(raw.hour),
    epsEstimate: toFloat(raw.epsEstimate),
    epsActual: toFloat(raw.epsActual),
    revenueEstimate: toFloat(raw.revenueEstimate),
    revenueActual: toFloat(raw.revenueActual),
  });
}

function toRecommendation(symbol, raw) {
  const period = toDate(raw.period);
  if (period == null) return null;
  return models.recommendationTrend({
    symbol,
    period,
    provider: PROVIDER,
    strongBuy: toInt(raw.strongBuy) || 0,
    buy: toInt(raw.buy) || 0,
    hold: toInt(raw.hold) || 0,
    sell: toInt(raw.sell) || 0,
    strongSell: toInt(raw.strongSell) || 0,
  });
}

module.exports = { toProfile, toMetrics, toNewsArticle, toEarningsEvent, toRecommendation };
