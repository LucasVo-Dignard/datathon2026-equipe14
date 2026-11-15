'use strict';
// Adapter around the `yahoo-finance2` library.
//
// This is the only module that imports yahoo-finance2. It hides the library's
// quirks (exclusive end dates, UTC timestamps for daily bars, its own errors)
// and returns plain data, so fetchers can be tested with a fake client and the
// library can be replaced.

const { ProviderError, RateLimitError } = require('../../errors');
const { addDays } = require('../../values');

const PROVIDER = 'yahoo';

// Quote summary modules flattened into one `info` object. On a key collision
// the first module wins.
const INFO_MODULES = ['price', 'summaryDetail', 'financialData', 'defaultKeyStatistics', 'summaryProfile'];
// Funds (ETFs): what they hold. Kept out of `info` (no key collisions); empty for stocks.
const FUND_MODULES = ['quoteType', 'fundProfile', 'topHoldings'];
const SUMMARY_MODULES = [...INFO_MODULES, ...FUND_MODULES, 'upgradeDowngradeHistory'];
// Profile, metrics, price target, rating actions and fund composition all read
// the same quote summary: keep each symbol's briefly so a refresh costs a single
// request, even when several symbols load at once.
const SUMMARY_TTL_MS = 60 * 1000;

function defaultLibrary() {
  const YahooFinance = require('yahoo-finance2').default;
  return new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
}

function isNotFound(err) {
  return /not found|no data found|delisted/i.test(err?.message || '');
}

// Calendar day of an instant in the exchange's time zone (daily bars are
// stamped with the market open in UTC).
function localDay(instant, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC' }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

class YahooClient {
  constructor({ library, rateLimiter = null, now = Date.now } = {}) {
    this.library = library || defaultLibrary();
    this.rateLimiter = rateLimiter;
    this.now = now;
    this.cached = new Map(); // symbol -> { at, promise }, kept SUMMARY_TTL_MS
  }

  // Quote summary (profile and key statistics) as one flat object. Unknown
  // symbols give an empty object, not an error.
  async info(symbol) {
    const summary = await this.#summary(symbol);
    const info = {};
    for (const name of INFO_MODULES) {
      for (const [key, value] of Object.entries(summary[name] || {})) {
        if (info[key] == null) info[key] = value;
      }
    }
    if (summary.price?.exchangeName) info.fullExchangeName = summary.price.exchangeName;
    return info;
  }

  // Fund data from the same quote summary: { quoteType, category, family,
  // stockPosition, bondPosition, cashPosition, sectorWeightings: [{ key: w }],
  // holdings: [{ symbol, holdingName, holdingPercent }] }, as Yahoo gives them.
  async fund(symbol) {
    const summary = await this.#summary(symbol);
    const top = summary.topHoldings || {};
    return {
      quoteType: summary.quoteType?.quoteType || null,
      category: summary.fundProfile?.categoryName || null,
      family: summary.fundProfile?.family || null,
      stockPosition: top.stockPosition,
      bondPosition: top.bondPosition,
      cashPosition: top.cashPosition,
      sectorWeightings: top.sectorWeightings || [],
      holdings: top.holdings || [],
    };
  }

  // Per-firm rating actions: [{ gradedAt, firm, toGrade, fromGrade, action,
  // priceTargetAction, currentPriceTarget, priorPriceTarget }]. Empty when
  // Yahoo has nothing.
  async upgradesDowngrades(symbol) {
    const summary = await this.#summary(symbol);
    return (summary.upgradeDowngradeHistory?.history || []).map((h) => ({
      gradedAt: h.epochGradeDate,
      firm: h.firm,
      toGrade: h.toGrade,
      fromGrade: h.fromGrade,
      action: h.action,
      priceTargetAction: h.priceTargetAction,
      currentPriceTarget: h.currentPriceTarget,
      priorPriceTarget: h.priorPriceTarget,
    }));
  }

  // Daily bars over an inclusive DateRange: { currency, bars: [{ date, open,
  // high, low, close, adjClose, volume }] }. Unknown symbols give no bars.
  async history(symbol, period) {
    let chart;
    try {
      chart = await this.#call(symbol, (lib) => lib.chart(symbol, {
        period1: period.start,
        // Yahoo treats the end as exclusive; our ranges are inclusive.
        period2: addDays(period.end, 1),
        interval: '1d',
      }));
    } catch (err) {
      if (err.notFound) return { currency: null, bars: [] };
      throw err;
    }
    const timeZone = chart.meta?.exchangeTimezoneName;
    return {
      currency: chart.meta?.currency || null,
      bars: (chart.quotes || []).map((q) => ({
        date: q.date instanceof Date ? localDay(q.date, timeZone) : q.date,
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        adjClose: q.adjclose,
        volume: q.volume,
      })),
    };
  }

  // Latest price of many symbols in one request: [{ symbol, quoteType,
  // currency, price, previousClose, name }]. Unknown symbols are left out.
  async quotes(symbols) {
    if (!symbols.length) return [];
    let rows;
    try {
      rows = await this.#call(symbols.join(','), (lib) => lib.quote(symbols, { return: 'array' }));
    } catch (err) {
      if (err.notFound) return [];
      throw err;
    }
    return (rows || []).filter((q) => q?.symbol).map((q) => ({
      symbol: q.symbol,
      quoteType: q.quoteType || null,
      currency: q.currency || null,
      price: q.regularMarketPrice ?? null,
      previousClose: q.regularMarketPreviousClose ?? null,
      name: q.longName || q.shortName || null,
    }));
  }

  // Latest news Yahoo links to a symbol: [{ id, title, publisher, url,
  // publishedAt (Date), relatedSymbols }]. Unknown symbols give no news.
  async news(symbol, count = 5) {
    let result;
    try {
      result = await this.#call(symbol, (lib) => lib.search(symbol, { quotesCount: 0, newsCount: count }));
    } catch (err) {
      if (err.notFound) return [];
      throw err;
    }
    return (result.news || []).map((n) => ({
      id: n.uuid,
      title: n.title,
      publisher: n.publisher,
      url: n.link,
      publishedAt: n.providerPublishTime instanceof Date ? n.providerPublishTime : new Date(n.providerPublishTime),
      relatedSymbols: n.relatedTickers || [],
    }));
  }

  #summary(symbol) {
    const at = this.now();
    const hit = this.cached.get(symbol);
    if (hit && at - hit.at < SUMMARY_TTL_MS) return hit.promise;
    for (const [key, entry] of this.cached) {
      if (at - entry.at >= SUMMARY_TTL_MS) this.cached.delete(key);
    }
    const promise = this.#call(symbol, (lib) => lib.quoteSummary(symbol, { modules: SUMMARY_MODULES }))
      .catch((err) => {
        if (err.notFound) return {};
        throw err;
      });
    this.cached.set(symbol, { at, promise });
    promise.catch(() => {
      if (this.cached.get(symbol)?.promise === promise) this.cached.delete(symbol);
    });
    return promise;
  }

  async #call(symbol, action) {
    if (this.rateLimiter) await this.rateLimiter.acquire();
    try {
      return await action(this.library);
    } catch (err) {
      // Schema drift: the library still gives us what Yahoo returned.
      if (err?.name === 'FailedYahooValidationError' && err.result) return err.result;
      if (err?.code === 429 || /too many requests/i.test(err?.message || '')) {
        throw new RateLimitError(PROVIDER, `rate limited while fetching ${symbol}`, { cause: err });
      }
      const wrapped = new ProviderError(PROVIDER, `failed to fetch ${symbol}: ${err?.message || err}`, { cause: err });
      wrapped.notFound = isNotFound(err);
      throw wrapped;
    }
  }
}

module.exports = { YahooClient, PROVIDER };
