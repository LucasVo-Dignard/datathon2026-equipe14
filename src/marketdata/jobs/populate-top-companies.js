'use strict';
// Follow the world's largest companies: take the top N by market cap from
// companiesmarketcap.com, save each one's Yahoo profile in company_profiles
// and add it to tracked_symbols (so the daily job refreshes it).
//
//     node src/marketdata/jobs/populate-top-companies.js --dry-run     # print the list, no database
//     DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata \
//         node src/marketdata/jobs/populate-top-companies.js [--limit 1000] [--skip-existing]
//
// Yahoo is rate limited to 60 calls a minute here, so 1000 companies take
// about 17 minutes. Each company is its own transaction: --skip-existing resumes an
// interrupted run by skipping symbols that already have a Yahoo profile.
// Symbols Yahoo doesn't know are skipped, not tracked. Exit code 1 only when
// every company failed.

const { parseArgs } = require('node:util');
const { connect, transaction } = require('../db/connection');
const repo = require('../db/repositories');
const { SymbolNotFoundError } = require('../errors');
const { newYahooClient } = require('../refresh');
const yahoo = require('../providers/yahoo');
const { CompaniesMarketCapClient } = require('../providers/companiesmarketcap');

const stamp = (level) => (message) => console.log(`${new Date().toISOString()} ${level} ${message}`);
const defaultLog = { info: stamp('INFO'), warn: stamp('WARNING') };

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit: { type: 'string', default: '1000' },
      'skip-existing': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('--limit must be a positive integer');
  return { limit, skipExisting: values['skip-existing'], dryRun: values['dry-run'] };
}

// One-off job, at the same 60 calls a minute as the daily job and the app.
const CALLS_PER_MINUTE = 60;

const billions = (usd) => `${(usd / 1e9).toFixed(1)}B USD`;

async function main(argv = process.argv.slice(2), {
  env = process.env,
  log = defaultLog,
  connectFn = connect,
  ranking = new CompaniesMarketCapClient(),
  profiles = new yahoo.YahooProfileFetcher(newYahooClient(CALLS_PER_MINUTE)),
} = {}) {
  const options = parse(argv);
  const companies = await ranking.topCompanies(options.limit);
  log.info(`${companies.length} companies, from ${billions(companies[0]?.marketCapUsd ?? 0)} ` +
    `down to ${billions(companies.at(-1)?.marketCapUsd ?? 0)}`);

  if (options.dryRun) {
    for (const c of companies) console.log(`${String(c.rank).padStart(5)} ${c.symbol.padEnd(14)} ${c.name} (${c.country}, ${billions(c.marketCapUsd)})`);
    return companies.length ? 0 : 1;
  }

  const db = await connectFn(env, { applicationName: 'marketdata-populate-top-companies' });
  try {
    const existing = options.skipExisting ? await repo.profiledSymbols(db, profiles.constructor.provider) : new Set();
    const report = { added: 0, skipped: 0, unknown: [], failed: 0 };
    for (const [i, company] of companies.entries()) {
      const { symbol } = company;
      if (existing.has(symbol)) {
        await transaction(db, (tx) => repo.trackSymbols(tx, [symbol]));
        report.skipped++;
        continue;
      }
      try {
        const profile = await profiles.fetch(symbol);
        await transaction(db, async (tx) => {
          await repo.saveProfile(tx, profile);
          await repo.trackSymbols(tx, [symbol]);
        });
        report.added++;
        log.info(`${i + 1}/${companies.length} ${symbol} ${profile.name}`);
      } catch (err) {
        if (err instanceof SymbolNotFoundError) {
          report.unknown.push(symbol);
          log.warn(`${symbol} (${company.name}): unknown to Yahoo, not tracked`);
          continue;
        }
        // Probably transient (network, throttling): track it anyway, the daily
        // job will fetch the profile.
        report.failed++;
        log.warn(`${symbol} profile failed, tracked anyway: ${err.message}`);
        await transaction(db, (tx) => repo.trackSymbols(tx, [symbol])).catch((e) => {
          log.warn(`${symbol} could not be tracked: ${e.message}`);
        });
      }
    }
    log.info(`finished: ${report.added} profiles saved, ${report.skipped} already there, ` +
      `${report.failed} failed, ${report.unknown.length} unknown to Yahoo` +
      (report.unknown.length ? ` (${report.unknown.join(' ')})` : ''));
    return report.added + report.skipped === 0 ? 1 : 0;
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
