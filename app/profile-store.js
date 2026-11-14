'use strict';
// ---------------------------------------------------------------------------
// Stockage des profils investisseurs.
//
//   - DATABASE_URL défini -> Postgres (table investor_profiles, créée par la
//                            migration Flyway db/migrations/V4__create_investor_profiles.sql)
//   - sinon               -> fichier JSON du prototype (db.users[username].profile)
//
// Un profil stocké a la forme { answers, result, updatedAt } (updatedAt en ms).
// Le reste de l'app ne passe que par get() / save() : changer de base ne touche
// que ce fichier.
// ---------------------------------------------------------------------------

function createJsonStore({ db, saveDb }) {
  return {
    kind: 'json',
    async init() {},
    async get(username) {
      return db.users[username]?.profile || null;
    },
    async save(username, profile) {
      db.users[username] = { ...db.users[username], profile };
      saveDb();
      return profile;
    },
    async close() {},
  };
}

function createPgStore({ connectionString }) {
  // Chargé seulement si une base est configurée : l'app tourne sans `pg` sinon.
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error:', err.message));

  const toProfile = (row) => row && {
    answers: row.answers,
    result: row.result,
    updatedAt: row.updated_at.getTime(),
  };

  return {
    kind: 'postgres',
    // Le schéma appartient à Flyway (db/migrations) : on vérifie seulement que la table existe.
    async init() {
      const { rows } = await pool.query("SELECT to_regclass('investor_profiles') AS t");
      if (!rows[0].t) {
        throw new Error('table investor_profiles absente : appliquez les migrations Flyway (voir db/README.md)');
      }
    },
    async get(username) {
      const { rows } = await pool.query(
        'SELECT answers, result, updated_at FROM investor_profiles WHERE username = $1', [username]);
      return toProfile(rows[0]) || null;
    },
    async save(username, { answers, result }) {
      const { rows } = await pool.query(
        `INSERT INTO investor_profiles (username, answers, result, risk_level, score)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (username) DO UPDATE
           SET answers = EXCLUDED.answers, result = EXCLUDED.result,
               risk_level = EXCLUDED.risk_level, score = EXCLUDED.score, updated_at = now()
         RETURNING answers, result, updated_at`,
        [username, JSON.stringify(answers), JSON.stringify(result), result.level.id, result.score]);
      return toProfile(rows[0]);
    },
    async close() {
      await pool.end();
    },
  };
}

function createProfileStore({ db, saveDb, connectionString = process.env.DATABASE_URL }) {
  return connectionString ? createPgStore({ connectionString }) : createJsonStore({ db, saveDb });
}

module.exports = { createProfileStore };
