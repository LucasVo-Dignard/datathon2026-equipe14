'use strict';
// ---------------------------------------------------------------------------
// Stockage des rapports programmés (voir report-schedule.js).
//
//   - DATABASE_URL défini -> Postgres (tables report_preferences et
//                            report_schedules, migration V13)
//   - sinon               -> fichier JSON du prototype (db.reportSchedules) ;
//                            les horaires sont enregistrés mais le job horaire,
//                            qui lit Postgres, ne les exécute pas.
//
// get() retourne { configured, configuredAt, timezone, schedules: [...] } ;
// configured passe à true dès que l'utilisateur a répondu, même « aucun rapport ».
// ---------------------------------------------------------------------------

const { PERIODS, TIMEZONE, describe } = require('./report-schedule');

const ms = (d) => (d == null ? null : new Date(d).getTime());
const withLabel = (s) => ({ ...s, label: describe(s) });
const none = () => ({ configured: false, configuredAt: null, timezone: TIMEZONE, schedules: [] });

function createJsonStore({ db, saveDb, now = Date.now }) {
  db.reportSchedules ??= {};
  return {
    kind: 'json',
    async init() {},
    async get(username) {
      const entry = Object.hasOwn(db.reportSchedules, username) ? db.reportSchedules[username] : null;
      if (!entry) return none();
      return { configured: true, configuredAt: entry.configuredAt, timezone: TIMEZONE, schedules: entry.schedules.map(withLabel) };
    },
    // schedules : liste validée par report-schedule.validate().
    async set(username, schedules) {
      const at = now();
      const previous = db.reportSchedules[username]?.schedules || [];
      db.reportSchedules[username] = {
        configuredAt: at,
        schedules: schedules.map((s) => {
          const old = previous.find((p) => p.period === s.period);
          return { ...s, lastRunAt: old?.lastRunAt ?? null, createdAt: old?.createdAt ?? at, updatedAt: at };
        }),
      };
      saveDb();
      return this.get(username);
    },
    async close() {},
  };
}

const COLUMNS = `period, weekday, month_day, month, hour, timezone, last_run_at, created_at, updated_at`;
const toSchedule = (r) => ({
  period: r.period,
  weekday: r.weekday,
  day: r.month_day,
  month: r.month,
  hour: r.hour,
  timezone: r.timezone,
  lastRunAt: ms(r.last_run_at),
  createdAt: ms(r.created_at),
  updatedAt: ms(r.updated_at),
});

function createPgStore({ connectionString, pool: shared }) {
  let pool = shared;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString, max: 3 });
    pool.on('error', (err) => console.error('postgres pool error (report schedules):', err.message));
  }

  return {
    kind: 'postgres',
    async init() {
      const { rows } = await pool.query(
        "SELECT to_regclass('report_preferences') AS p, to_regclass('report_schedules') AS s");
      if (!rows[0].p || !rows[0].s) {
        throw new Error('tables report_preferences / report_schedules absentes : appliquez les migrations Flyway (voir README.md)');
      }
    },
    async get(username) {
      const { rows: [pref] } = await pool.query(
        'SELECT configured_at FROM report_preferences WHERE username = $1', [username]);
      if (!pref) return none();
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM report_schedules WHERE username = $1`, [username]);
      return {
        configured: true,
        configuredAt: ms(pref.configured_at),
        timezone: TIMEZONE,
        schedules: rows.map(toSchedule).map(withLabel)
          .sort((a, b) => PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period)),
      };
    },
    // Remplace la liste. last_run_at est gardé pour une période déjà programmée ;
    // updated_at repart de maintenant, donc une échéance déjà passée ne compte pas.
    async set(username, schedules) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO report_preferences (username) VALUES ($1)
           ON CONFLICT (username) DO UPDATE SET configured_at = now()`, [username]);
        await client.query(
          'DELETE FROM report_schedules WHERE username = $1 AND NOT (period = ANY($2::text[]))',
          [username, schedules.map((s) => s.period)]);
        for (const s of schedules) {
          await client.query(
            `INSERT INTO report_schedules (username, period, weekday, month_day, month, hour, timezone)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (username, period) DO UPDATE
               SET weekday = EXCLUDED.weekday, month_day = EXCLUDED.month_day, month = EXCLUDED.month,
                   hour = EXCLUDED.hour, timezone = EXCLUDED.timezone, updated_at = now()`,
            [username, s.period, s.weekday, s.day, s.month, s.hour, s.timezone || TIMEZONE]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      return this.get(username);
    },

    // --- Job horaire (jobs/scheduled-reports.js) -----------------------------
    async all() {
      const { rows } = await pool.query(`SELECT username, ${COLUMNS} FROM report_schedules ORDER BY username, period`);
      return rows.map((r) => ({ username: r.username, ...toSchedule(r) }));
    },
    // Réserve l'échéance : true si ce run l'a prise (pas un autre run en parallèle).
    async claim(username, period, occurrence) {
      const { rowCount } = await pool.query(
        `UPDATE report_schedules SET last_run_at = to_timestamp($3 / 1000.0)
          WHERE username = $1 AND period = $2
            AND (last_run_at IS NULL OR last_run_at < to_timestamp($3 / 1000.0))`,
        [username, period, occurrence]);
      return rowCount > 0;
    },
    // Échec de la rédaction : rend l'échéance, qui sera retentée au prochain run.
    async release(username, period, occurrence, previous) {
      await pool.query(
        `UPDATE report_schedules SET last_run_at = to_timestamp($4 / 1000.0)
          WHERE username = $1 AND period = $2 AND last_run_at = to_timestamp($3 / 1000.0)`,
        [username, period, occurrence, previous]);
    },
    async close() {
      if (!shared) await pool.end();
    },
  };
}

function createReportScheduleStore({ db, saveDb, connectionString = process.env.DATABASE_URL, pool, now } = {}) {
  return connectionString || pool ? createPgStore({ connectionString, pool }) : createJsonStore({ db, saveDb, now });
}

module.exports = { createReportScheduleStore };
