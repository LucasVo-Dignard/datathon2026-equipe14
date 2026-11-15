'use strict';
// ---------------------------------------------------------------------------
// Stockage des utilisateurs et des sessions de connexion.
//
//   - DATABASE_URL défini -> Postgres (tables users / sessions, migration Flyway
//                            db/migrations/V12__create_users_sessions.sql)
//   - sinon               -> fichier JSON du prototype (db.users, db.sessions)
//
// La connexion se fait par nom d'utilisateur seulement (prototype). Une session
// est un jeton aléatoire (le cookie sid) ; en base, elle expire après
// SESSION_MAX_AGE_S, comme le cookie.
// ---------------------------------------------------------------------------

const SESSION_MAX_AGE_S = 30 * 24 * 3600;

function createJsonStore({ db, saveDb }) {
  return {
    kind: 'json',
    async init() {},
    // Crée l'utilisateur s'il n'existe pas, puis ouvre une session.
    async login(username, token) {
      if (!Object.hasOwn(db.users, username)) db.users[username] = { createdAt: Date.now() };
      db.sessions[token] = username;
      saveDb();
    },
    async user(token) {
      return token && Object.hasOwn(db.sessions, token) ? db.sessions[token] : null;
    },
    async logout(token) {
      if (!token || !Object.hasOwn(db.sessions, token)) return;
      delete db.sessions[token];
      saveDb();
    },
    async close() {},
  };
}

function createPgStore({ connectionString }) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error (sessions):', err.message));

  return {
    kind: 'postgres',
    pool, // utilisé par l'import du fichier JSON (json-import.js)
    async init() {
      const { rows: [r] } = await pool.query("SELECT to_regclass('users') AS u, to_regclass('sessions') AS s");
      if (!r.u || !r.s) {
        throw new Error('tables users / sessions absentes : appliquez les migrations Flyway (voir db/README.md)');
      }
    },
    async login(username, token) {
      await pool.query('INSERT INTO users (username) VALUES ($1) ON CONFLICT (username) DO NOTHING', [username]);
      await pool.query(
        'INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))',
        [token, username, SESSION_MAX_AGE_S]);
      await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    },
    async user(token) {
      if (!token) return null;
      const { rows: [s] } = await pool.query(
        'SELECT username FROM sessions WHERE token = $1 AND expires_at > now()', [token]);
      return s ? s.username : null;
    },
    async logout(token) {
      if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    },
    async close() {
      await pool.end();
    },
  };
}

function createSessionStore({ db, saveDb, connectionString = process.env.DATABASE_URL }) {
  return connectionString ? createPgStore({ connectionString }) : createJsonStore({ db, saveDb });
}

module.exports = { createSessionStore, SESSION_MAX_AGE_S };
