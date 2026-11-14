'use strict';
// Load World Bank macro indicators into macro_observations.
//
//     node src/marketdata/jobs/macro-refresh.js --dry-run          # fetch and print, no database
//     DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata \
//         node src/marketdata/jobs/macro-refresh.js [--years 10] \
//         [--indicators FP.CPI.TOTL.ZG ...] [--countries CAN USA ...]
//
// Defaults: the last 10 years of worldbank.DEFAULT_INDICATORS for
// worldbank.DEFAULT_COUNTRIES. The data is yearly, so running it once a week
// or so is plenty. Exit code 1 only when every indicator failed.

const { parseArgs } = require('node:util');
const { connect } = require('../db/connection');
const { refreshMacro } = require('../refresh');
const worldbank = require('../providers/worldbank');
const { YearRange } = require('../values');

const stamp = (level) => (message) => console.log(`${new Date().toISOString()} ${level} ${message}`);
const defaultLog = { info: stamp('INFO'), warn: stamp('WARNING') };

// `--countries A B`: parseArgs takes A as the option value and B as a
// positional, so positionals belong to whichever list option came last.
function parse(argv) {
  const { values, tokens } = parseArgs({
    args: argv,
    options: {
      indicators: { type: 'string', multiple: true },
      countries: { type: 'string', multiple: true },
      years: { type: 'string', default: '10' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    tokens: true,
  });
  const lists = { indicators: [], countries: [] };
  let current = null;
  for (const token of tokens) {
    if (token.kind === 'option') {
      current = token.name in lists ? token.name : null;
      if (current) lists[current].push(token.value);
    } else if (token.kind === 'positional') {
      if (!current) throw new TypeError(`unexpected argument: ${token.value}`);
      lists[current].push(token.value);
    }
  }
  const years = Number(values.years);
  if (!Number.isInteger(years) || years < 1) throw new RangeError('--years must be a positive integer');
  return {
    indicators: lists.indicators.length ? lists.indicators : Object.keys(worldbank.DEFAULT_INDICATORS),
    countries: lists.countries.length ? lists.countries : [...worldbank.DEFAULT_COUNTRIES],
    years: YearRange.lastYears(years),
    dryRun: values['dry-run'],
  };
}

async function main(argv = process.argv.slice(2), {
  env = process.env,
  log = defaultLog,
  connectFn = connect,
  fetcher = new worldbank.WorldBankIndicatorFetcher(new worldbank.WorldBankClient()),
} = {}) {
  const options = parse(argv);
  log.info(`${options.indicators.length} indicators, ${options.countries.length} countries, ` +
    `${options.years.start}-${options.years.end}`);

  if (options.dryRun) {
    let failed = 0;
    for (const indicator of options.indicators) {
      try {
        const observations = await fetcher.fetch(indicator, options.countries, options.years);
        console.log(`\n== ${indicator} ${observations[0]?.indicatorName ?? ''}`);
        for (const o of observations) console.log(`   ${o.country} ${o.year} ${o.value}`);
      } catch (err) {
        failed++;
        log.warn(`${indicator} failed: ${err.message}`);
      }
    }
    return failed === options.indicators.length ? 1 : 0;
  }

  const db = await connectFn(env, { applicationName: 'marketdata-macro-refresh' });
  try {
    const report = await refreshMacro(db, fetcher, { ...options, log });
    log.info(`finished: ${report.succeeded} indicators ok, ${report.failed} failed`);
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

module.exports = { main, parse };
