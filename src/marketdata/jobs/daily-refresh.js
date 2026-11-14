'use strict';
// Daily refresh of the tracked symbols (table tracked_symbols).
//
// Runs once a day on AWS Batch (see infra-batch/), and locally against the
// Docker Postgres:
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
// REFRESH_ENABLED=false turns the job into a no-op: it logs and exits 0
// without connecting to the database or calling any provider. The AWS job
// definition sets it from the refresh_enabled Terraform variable.

const { parseArgs } = require('node:util');
const { connect } = require('../db/connection');
const repo = require('../db/repositories');
const { defaultSteps, refresh } = require('../refresh');
const { normalizeSymbol } = require('../values');

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
    const symbols = fromArgs ? fromArgs.map(normalizeSymbol) : await repo.activeSymbols(db);
    if (!symbols.length) {
      log.warn('no active tracked symbols: nothing to do');
      return 0;
    }
    log.info(`refreshing ${symbols.length} symbols`);
    const report = await refresh(db, symbols, steps || defaultSteps({ env, log }), { log });
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
