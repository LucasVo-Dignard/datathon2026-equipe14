'use strict';
// Fetch data for symbols and save it, one transaction per (symbol, step).
//
// Used by the daily job (jobs/daily-refresh.js) for tracked symbols, and by
// the web app to load a symbol on demand when its data is missing or stale.

const { transaction } = require('./db/connection');
const repo = require('./db/repositories');
const { RateLimiter } = require('./http');
const yahoo = require('./providers/yahoo');
const { DateRange, today: localToday } = require('./values');

// Re-fetching a short overlap picks up late corrections and actions that
// Yahoo reports a few days after the fact; upserts make it idempotent.
const LOOKBACK_DAYS = 7;
// Yahoo has no published quota; stay well below where it starts throttling.
const YAHOO_CALLS_PER_MINUTE = 60;

// A step is [name, async (db, symbol) => void].
function yahooSteps(client, { today = localToday(), priceDays = LOOKBACK_DAYS } = {}) {
  const recent = DateRange.lastDays(LOOKBACK_DAYS, today);
  const prices = DateRange.lastDays(priceDays, today);
  const profile = new yahoo.YahooProfileFetcher(client);
  const metrics = new yahoo.YahooMetricsFetcher(client);
  const target = new yahoo.YahooPriceTargetFetcher(client);
  const history = new yahoo.YahooPriceHistoryFetcher(client);
  const ratings = new yahoo.YahooRatingActionFetcher(client);
  const fund = new yahoo.YahooFundCompositionFetcher(client);
  return [
    ['yahoo.profile', async (db, s) => repo.saveProfile(db, await profile.fetch(s))],
    ['yahoo.metrics', async (db, s) => repo.saveMetrics(db, await metrics.fetch(s))],
    ['yahoo.price_target', async (db, s) => repo.savePriceTarget(db, await target.fetch(s))],
    ['yahoo.prices', async (db, s) => repo.savePriceBars(db, await history.fetch(s, prices))],
    ['yahoo.rating_actions', async (db, s) => repo.saveRatingActions(db, await ratings.fetch(s, recent))],
    // Same quote summary as the profile: no extra request.
    ['yahoo.fund_composition', async (db, s) => repo.saveFundComposition(db, await fund.fetch(s))],
  ];
}

function newYahooClient(callsPerMinute = YAHOO_CALLS_PER_MINUTE) {
  return new yahoo.YahooClient({ rateLimiter: new RateLimiter(callsPerMinute, 60_000) });
}

function defaultSteps({ yahooClient = newYahooClient(), ...options } = {}) {
  return yahooSteps(yahooClient, options);
}

// Run every step for every symbol. A failing step is logged and recorded
// without losing the other steps or symbols. `track` records the outcome in
// tracked_symbols (a no-op for symbols that aren't tracked).
async function refresh(db, symbols, steps, { log = console, track = true } = {}) {
  const report = { succeeded: 0, failed: 0, failures: {} };
  for (const symbol of symbols) {
    const errors = [];
    for (const [name, step] of steps) {
      try {
        await transaction(db, (tx) => step(tx, symbol));
        report.succeeded++;
      } catch (err) {
        report.failed++;
        errors.push({ step: name, error: err });
        log.warn(`${symbol} ${name} failed: ${err.message}`);
      }
    }
    if (errors.length) report.failures[symbol] = errors;
    if (track) {
      const summary = errors.map((e) => `${e.step}: ${e.error.message}`).join('; ').slice(0, 2000);
      await transaction(db, (tx) => repo.markRefreshed(tx, symbol, summary || null));
    }
    log.info(`${symbol} done (${steps.length - errors.length}/${steps.length} steps ok)`);
  }
  report.nothingSucceeded = report.succeeded === 0 && report.failed > 0;
  return report;
}

module.exports = { yahooSteps, defaultSteps, newYahooClient, refresh, LOOKBACK_DAYS };
