'use strict';
// Daily refresh of the tracked symbols (table tracked_symbols).
//
// Runs on weekdays at 18:00 (Toronto time) on AWS Batch (see infra-batch/),
// and locally against the Docker Postgres:
//
//     DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata \
//         node src/marketdata/jobs/daily-refresh.js [--symbols RY.TO NVDA]
//
// Each (symbol, step) is its own transaction: a failure is logged and
// recorded in tracked_symbols.last_error without losing the other steps or
// symbols. The exit code is 1 only when nothing succeeded at all (database or
// network down), so AWS Batch retries the job only in that case.
//
// Finnhub steps run only if FINNHUB_API_KEY is set.
//
// When ALERTS_SENDER is set, the subscribers' holdings are refreshed first,
// then price-move alerts are emailed (SES, price-alerts.js), then the other
// symbols are refreshed. With --symbols, alerts are still sent but holdings
// are not refreshed first. An alert failure is logged but never fails the job.
//
// REFRESH_ENABLED=false turns the job into a no-op: it logs and exits 0
// without connecting to the database or calling any provider. The AWS job
// definition sets it from the refresh_enabled Terraform variable.

const { parseArgs } = require('node:util');
const { connect } = require('../db/connection');
const repo = require('../db/repositories');
const { defaultSteps, refresh } = require('../refresh');
const { normalizeSymbol } = require('../values');
const priceAlerts = require('./price-alerts');

// On unless REFRESH_ENABLED is explicitly false/0/no/off.
function refreshEnabled(env = process.env) {
  const value = (env.REFRESH_ENABLED ?? 'true').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(value);
}

const stamp = (level) => (message) => console.log(`${new Date().toISOString()} ${level} ${message}`);
const defaultLog = { info: stamp('INFO'), warn: stamp('WARNING') };

async function main(argv = process.argv.slice(2), { env = process.env, log = defaultLog, connectFn = connect, steps } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { symbols: { type: 'string', multiple: true } },
    allowPositionals: true,
  });
  // `--symbols A B`: parseArgs takes A as the option value and B as a positional.
  const fromArgs = values.symbols ? [...values.symbols, ...positionals] : null;

  if (!refreshEnabled(env)) {
    log.info('REFRESH_ENABLED is off: doing nothing');
    return 0;
  }

  const db = await connectFn(env, { applicationName: 'marketdata-daily-refresh' });
  try {
    let symbols = fromArgs ? fromArgs.map(normalizeSymbol) : await repo.activeSymbols(db);
    // Subscribers' holdings go first, then the alerts are sent, then the rest:
    // with ~1 000 tracked symbols the full refresh takes hours, and alerts
    // must not depend on it finishing (timeout, retry, Yahoo throttling).
    let first = [];
    if (!fromArgs && env.ALERTS_SENDER) {
      first = await priceAlerts.subscribedSymbols(db).catch((err) => {
        log.warn(`subscribers' holdings unavailable: ${err.message}`);
        return [];
      });
      symbols = [...new Set([...first, ...symbols])];
    }
    if (!symbols.length) {
      log.warn('no active tracked symbols: nothing to do');
      return 0;
    }
    const jobSteps = steps || defaultSteps({ env, log });
    const firstSet = new Set(first);
    const rest = symbols.filter((s) => !firstSet.has(s));
    const report = { succeeded: 0, failed: 0 };
    const add = (r) => { report.succeeded += r.succeeded; report.failed += r.failed; };

    if (first.length) {
      log.info(`refreshing ${first.length} subscribed symbols first (price alerts)`);
      add(await refresh(db, first, jobSteps, { log }));
    }
    await priceAlerts.sendPriceAlerts(db, { env, log });
    if (rest.length) {
      log.info(`refreshing ${rest.length} symbols`);
      add(await refresh(db, rest, jobSteps, { log }));
    }
    report.nothingSucceeded = report.succeeded === 0 && report.failed > 0;
    log.info(`finished: ${report.succeeded} steps ok, ${report.failed} failed`);
    return report.nothingSucceeded ? 1 : 0;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}

module.exports = { main, refreshEnabled };
