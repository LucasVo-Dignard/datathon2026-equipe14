'use strict';
// Scheduled reports: schedules (app/report-schedule.js), their JSON storage,
// and the hourly job (app/jobs/scheduled-reports.js) with fake services.
const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('../app/report-schedule');
const { createReportScheduleStore } = require('../app/report-schedule-store');
const job = require('../app/jobs/scheduled-reports');

const at = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();
const quietLog = { info() {}, warn() {}, error() {} };

test('validate keeps only the fields of each period, sorted', () => {
  const list = schedule.validate([
    { period: 'monthly', day: 1, hour: 8, weekday: 3 },
    { period: 'daily', hour: '18' },
    { period: 'weekly', weekday: 1, hour: 7 },
    { period: 'yearly', month: 1, day: 2, hour: 8 },
  ]);
  assert.deepEqual(list.map((s) => s.period), ['daily', 'weekly', 'monthly', 'yearly']);
  assert.deepEqual(list[0], { period: 'daily', weekday: null, day: null, month: null, hour: 18, timezone: 'America/Toronto' });
  assert.equal(list[2].weekday, null);
  assert.deepEqual(schedule.validate([]), []);
});

test('validate rejects incomplete or impossible schedules', () => {
  const bad = [
    'weekly',
    [{ period: 'hourly', hour: 1 }],
    [{ period: 'daily' }],
    [{ period: 'daily', hour: 24 }],
    [{ period: 'weekly', hour: 7 }],
    [{ period: 'weekly', hour: 7, weekday: 8 }],
    [{ period: 'monthly', hour: 7, day: 31 }],
    [{ period: 'yearly', hour: 7, day: 2 }],
    [{ period: 'daily', hour: 7 }, { period: 'daily', hour: 9 }],
    [{ period: 'daily', hour: 7.5 }],
  ];
  for (const input of bad) assert.throws(() => schedule.validate(input), schedule.ScheduleError, JSON.stringify(input));
});

test('describe in French', () => {
  const [d, w, m, y] = schedule.validate([
    { period: 'daily', hour: 18 }, { period: 'weekly', weekday: 1, hour: 7 },
    { period: 'monthly', day: 1, hour: 8 }, { period: 'yearly', month: 1, day: 15, hour: 9 },
  ]);
  assert.equal(schedule.describe(d), 'Rapport quotidien, du lundi au vendredi à 18 h');
  assert.equal(schedule.describe(w), 'Rapport hebdomadaire, chaque lundi à 7 h');
  assert.equal(schedule.describe(m), 'Rapport mensuel, le 1er de chaque mois à 8 h');
  assert.equal(schedule.describe(y), 'Rapport annuel, le 15 janvier de chaque année à 9 h');
});

test('last occurrence in Eastern time, daylight saving time included', () => {
  const last = (s, now) => iso(schedule.lastOccurrence({ timezone: 'America/Toronto', ...s }, at(now)));
  // Sunday 15 November 2026, noon EST.
  const sunday = '2026-11-15T17:00:00Z';
  assert.equal(last({ period: 'weekly', weekday: 1, hour: 7 }, sunday), '2026-11-09T12:00:00.000Z');
  assert.equal(last({ period: 'weekly', weekday: 7, hour: 7 }, sunday), '2026-11-15T12:00:00.000Z');
  assert.equal(last({ period: 'weekly', weekday: 7, hour: 13 }, sunday), '2026-11-08T18:00:00.000Z');
  // Daily: weekdays only, so Friday's report on a weekend.
  assert.equal(last({ period: 'daily', hour: 18 }, sunday), '2026-11-13T23:00:00.000Z');
  assert.equal(last({ period: 'daily', hour: 18 }, '2026-11-16T23:00:30Z'), '2026-11-16T23:00:00.000Z');
  assert.equal(last({ period: 'daily', hour: 18 }, '2026-11-16T22:59:00Z'), '2026-11-13T23:00:00.000Z');
  // 1 November 2026 is the day DST ends: 8:00 is already EST (UTC-5).
  assert.equal(last({ period: 'monthly', day: 1, hour: 8 }, sunday), '2026-11-01T13:00:00.000Z');
  // 20 October: still EDT (UTC-4).
  assert.equal(last({ period: 'monthly', day: 20, hour: 8 }, sunday), '2026-10-20T12:00:00.000Z');
  assert.equal(last({ period: 'yearly', month: 1, day: 2, hour: 8 }, sunday), '2026-01-02T13:00:00.000Z');
  assert.equal(last({ period: 'yearly', month: 1, day: 2, hour: 8 }, '2027-01-01T12:00:00Z'), '2026-01-02T13:00:00.000Z');
  // Midnight EST is 5:00 UTC the same day.
  assert.equal(last({ period: 'monthly', day: 15, hour: 0 }, sunday), '2026-11-15T05:00:00.000Z');
});

test('dueAt: once per occurrence, never for one before the schedule was set', () => {
  const weekly = { period: 'weekly', weekday: 1, hour: 7, timezone: 'America/Toronto' };
  const occurrence = at('2026-11-16T12:00:00Z'); // Monday 7:00 EST
  const now = at('2026-11-16T12:01:00Z');
  const created = at('2026-11-10T00:00:00Z');
  assert.equal(schedule.dueAt({ ...weekly, createdAt: created, updatedAt: created }, now), occurrence);
  assert.equal(schedule.dueAt({ ...weekly, createdAt: created, updatedAt: created, lastRunAt: occurrence }, now), null);
  assert.equal(schedule.dueAt({ ...weekly, createdAt: created, updatedAt: at('2026-11-16T12:00:30Z') }, now), null);
  // Missed runs: one report, for the latest occurrence.
  assert.equal(schedule.dueAt({ ...weekly, createdAt: created, updatedAt: created }, at('2026-11-20T00:00:00Z')), occurrence);
});

test('JSON store: not configured, then configured (also with no report)', async () => {
  const db = { users: {} };
  let saves = 0;
  let clock = 1000;
  const store = createReportScheduleStore({ db, saveDb: () => { saves += 1; }, connectionString: '', now: () => clock });
  assert.equal(store.kind, 'json');
  assert.deepEqual((await store.get('ana')).configured, false);

  const saved = await store.set('ana', schedule.validate([{ period: 'weekly', weekday: 5, hour: 17 }]));
  assert.equal(saved.configured, true);
  assert.equal(saved.schedules[0].label, 'Rapport hebdomadaire, chaque vendredi à 17 h');
  assert.equal(saved.schedules[0].updatedAt, 1000);
  assert.equal(saves, 1);

  db.reportSchedules.ana.schedules[0].lastRunAt = 900;
  clock = 2000;
  const kept = await store.set('ana', schedule.validate([{ period: 'weekly', weekday: 1, hour: 7 }, { period: 'daily', hour: 18 }]));
  const weekly = kept.schedules.find((s) => s.period === 'weekly');
  assert.equal(weekly.lastRunAt, 900);
  assert.equal(weekly.createdAt, 1000);
  assert.equal(weekly.updatedAt, 2000);

  const none = await store.set('ana', []);
  assert.equal(none.configured, true);
  assert.deepEqual(none.schedules, []);
  assert.equal((await store.get('bob')).configured, false);
});

function fakeServices({ schedules, fail = {} }) {
  const written = [];
  const claimed = new Set();
  const released = [];
  return {
    written,
    released,
    schedules: {
      async all() { return schedules; },
      async claim(username, period, occurrence) {
        const key = `${username}|${period}|${occurrence}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
      async release(...args) { released.push(args); },
    },
    generator: {
      async generate(username, period, { scheduledFor }) {
        if (fail[username]) {
          const err = new Error(fail[username].message);
          err.status = fail[username].status;
          throw err;
        }
        written.push({ username, period, scheduledFor });
        return { id: `${username}-${period}` };
      },
    },
    async close() { this.closed = true; },
  };
}

test('job writes the due reports only, skips users without a portfolio, and gives back the failed ones', async () => {
  const base = { timezone: 'America/Toronto', createdAt: at('2026-11-01T00:00:00Z'), updatedAt: at('2026-11-01T00:00:00Z') };
  const services = fakeServices({
    schedules: [
      { ...base, username: 'ana', period: 'weekly', weekday: 1, hour: 7 }, // due
      { ...base, username: 'ana', period: 'daily', hour: 18 }, // done last Friday
      { ...base, username: 'bob', period: 'weekly', weekday: 1, hour: 7, lastRunAt: at('2026-11-09T12:00:00Z') }, // due
      { ...base, username: 'cy', period: 'monthly', day: 1, hour: 8 }, // no portfolio
    ].map((s) => (s.period === 'daily' ? { ...s, lastRunAt: at('2026-11-13T23:00:00Z') } : s)),
    fail: { bob: { status: 502, message: 'agent down' }, cy: { status: 409, message: 'no portfolio' } },
  });
  const code = await job.main(['--now', '2026-11-16T12:05:00Z'], { log: quietLog, services });
  assert.equal(code, 0);
  assert.deepEqual(services.written, [{ username: 'ana', period: 'weekly', scheduledFor: at('2026-11-16T12:00:00Z') }]);
  assert.deepEqual(services.released, [['bob', 'weekly', at('2026-11-16T12:00:00Z'), at('2026-11-09T12:00:00Z')]]);
  assert.ok(services.closed);
});

test('job dry run writes nothing; exit 1 when every report failed', async () => {
  const base = { timezone: 'America/Toronto', createdAt: 0, updatedAt: 0, username: 'ana', period: 'daily', hour: 18 };
  const dry = fakeServices({ schedules: [base] });
  assert.equal(await job.main(['--dry-run', '--now', '2026-11-16T23:05:00Z'], { log: quietLog, services: dry }), 0);
  assert.deepEqual(dry.written, []);

  const down = fakeServices({ schedules: [base], fail: { ana: { status: 502, message: 'down' } } });
  assert.equal(await job.main(['--now', '2026-11-16T23:05:00Z'], { log: quietLog, services: down }), 1);
});

test('job uses DATABASE_URL as is when set', async () => {
  assert.equal(await job.databaseUrl({ DATABASE_URL: 'postgres://local' }), 'postgres://local');
});
