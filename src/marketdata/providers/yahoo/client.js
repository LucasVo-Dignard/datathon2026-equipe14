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

// Quote summary modules flattened into one `info` object, like yfinance's
// Ticker.info. On a key collision the first module wins.
const INFO_MODULES = ['price', 'summaryDetail', 'financialData', 'defaultKeyStatistics', 'summaryProfile'];
const SUMMARY_MODULES = [...INFO_MODULES, 'upgradeDowngradeHistory'];
// Profile, metrics, price target and rating actions all read the same quote
// summary: keep the last one briefly so a refresh costs a single request.
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
    this.cached = null; // { symbol, at, promise }
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

  #summary(symbol) {
    const at = this.now();
    if (this.cached && this.cached.symbol === symbol && at - this.cached.at < SUMMARY_TTL_MS) {
      return this.cached.promise;
    }
    const promise = this.#call(symbol, (lib) => lib.quoteSummary(symbol, { modules: SUMMARY_MODULES }))
      .catch((err) => {
        if (err.notFound) return {};
        throw err;
      });
    this.cached = { symbol, at, promise };
    promise.catch(() => {
      if (this.cached?.promise === promise) this.cached = null;
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
