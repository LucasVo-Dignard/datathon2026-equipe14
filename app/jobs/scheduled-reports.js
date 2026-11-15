'use strict';
// Scheduled reports, every hour on AWS Batch (schedule in infra-batch/), or by hand:
//
//     DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata \
//     REPORTS_BUCKET=<bucket> node app/jobs/scheduled-reports.js [--dry-run] [--now 2026-11-16T12:05:00Z]
//
// The users set their schedules with the assistant (report_schedules, V13).
// For every schedule whose latest occurrence has not been written yet
// (report-schedule.js, dueAt), the job writes the report exactly like the
// "Générer" button (report-generator.js) and saves it in the reports bucket,
// where the Rapports tab shows it, flagged as new.
//
// Each occurrence is claimed in the database before the report is written
// (last_run_at), so an overlapping run or an AWS Batch retry never writes it
// twice. A failed report gives its occurrence back and is retried next hour;
// a user without a portfolio is skipped until the next occurrence.
//
// Environment: DATABASE_URL, or DB_HOST, DB_PORT, DB_NAME and DB_SECRET_ARN
// (AWS Batch); REPORTS_BUCKET; AWS credentials with Bedrock access (bot.js).

const { parseArgs } = require('node:util');
const { connectionConfig } = require('../../src/marketdata/db/connection');
const { dueAt } = require('../report-schedule');

const CONCURRENCY = 2;

const stamp = (level) => (message) => console.log(`${new Date().toISOString()} ${level} ${message}`);
const defaultLog = { info: stamp('INFO'), warn: stamp('WARNING'), error: stamp('ERROR') };

// The app's stores take a connection string. On AWS Batch it is built in
// memory from the DB secret (never logged nor written anywhere).
async function databaseUrl(env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const c = await connectionConfig(env, { applicationName: 'scheduled-reports' });
  const auth = `${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}`;
  return `postgres://${auth}@${c.host}:${c.port}/${encodeURIComponent(c.database)}?sslmode=no-verify`;
}

// Same services as the web server (server.js), on Postgres and S3.
// reportStore: another store, for local tests.
function createServices({ log, reportStore: localStore }) {
  const { report } = require('../bot');
  const { createReportStore } = require('../reports-store');
  const { createReportGenerator } = require('../report-generator');
  const { createReportScheduleStore } = require('../report-schedule-store');
  const { createProfileStore } = require('../profile-store');
  const { createPortfolioStore } = require('../portfolio-store');
  const { createPortfolioService } = require('../portfolio');
  const { createStockLookup } = require('../stocks');
  const { createNewsService } = require('../news');

  const unused = { db: { users: {} }, saveDb() { throw new Error('no JSON storage in the job'); } };
  const profiles = createProfileStore(unused);
  const portfolioStore = createPortfolioStore(unused);
  const stocks = createStockLookup();
  const portfolios = createPortfolioService({ store: portfolioStore, stocks, news: createNewsService({ pool: profiles.pool }) });
  const reportStore = localStore || createReportStore(unused);
  const schedules = createReportScheduleStore({ ...unused, pool: profiles.pool });
  const generator = createReportGenerator({ portfolios, profiles, stocks, reportStore, write: report, log });
  return {
    schedules,
    generator,
    async close() {
      await Promise.allSettled([portfolioStore.close(), stocks.close?.()]);
      await profiles.close(); // also the schedules' pool
    },
  };
}

async function runAll(due, { schedules, generator, log }) {
  const result = { written: 0, failed: 0, skipped: 0 };
  const queue = [...due];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { username, period, lastRunAt } = item.schedule;
      const tag = `${username} ${period} (${new Date(item.at).toISOString()})`;
      if (!(await schedules.claim(username, period, item.at))) {
        log.info(`${tag}: already taken by another run`);
        continue;
      }
      try {
        const saved = await generator.generate(username, period, { scheduledFor: item.at });
        result.written += 1;
        log.info(`${tag}: report ${saved.id} written`);
      } catch (err) {
        if (err.status === 409) { // no portfolio yet: wait for the next occurrence
          result.skipped += 1;
          log.info(`${tag}: skipped, ${err.message}`);
          continue;
        }
        result.failed += 1;
        log.warn(`${tag}: failed, retried next run: ${err.message}`);
        await schedules.release(username, period, item.at, lastRunAt).catch((e) => log.warn(`${tag}: release failed: ${e.message}`));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return result;
}

async function main(argv = process.argv.slice(2), { env = process.env, log = defaultLog, services } = {}) {
  const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' }, now: { type: 'string' } } });
  const dryRun = Boolean(values['dry-run']);
  const now = values.now ? Date.parse(values.now) : Date.now();
  if (Number.isNaN(now)) {
    log.error(`invalid --now: ${values.now}`);
    return 1;
  }
  if (!services) {
    if (!env.REPORTS_BUCKET && !dryRun) {
      log.error('REPORTS_BUCKET is not set: the reports would not reach the Rapports tab');
      return 1;
    }
    env.DATABASE_URL = await databaseUrl(env);
    services = createServices({ log });
  }
  try {
    const all = await services.schedules.all();
    const due = all.map((schedule) => ({ schedule, at: dueAt(schedule, now) })).filter((d) => d.at);
    log.info(`${all.length} schedule(s), ${due.length} report(s) due`);
    if (dryRun) {
      for (const d of due) log.info(`[dry run] ${d.schedule.username} ${d.schedule.period} (${new Date(d.at).toISOString()})`);
      return 0;
    }
    const result = await runAll(due, { ...services, log });
    log.info(`finished: ${result.written} written, ${result.skipped} skipped, ${result.failed} failed`);
    return result.failed && !result.written ? 1 : 0;
  } finally {
    await services.close();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code), // SDK clients may keep sockets open
    (err) => { console.error(err); process.exit(1); },
  );
}

module.exports = { main, runAll, databaseUrl, createServices };
