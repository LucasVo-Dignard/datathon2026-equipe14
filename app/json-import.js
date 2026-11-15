'use strict';
// ---------------------------------------------------------------------------
// Copie le fichier JSON du prototype dans Postgres, au démarrage avec
// DATABASE_URL : utilisateurs, sessions, conversations, et les profils /
// portefeuilles écrits quand l'environnement n'avait pas encore de base.
// Ce qui existe déjà en base est gardé (ON CONFLICT DO NOTHING). Une seule
// transaction : en cas d'erreur, rien n'est importé.
// ---------------------------------------------------------------------------

const { SESSION_MAX_AGE_S } = require('./session-store');

const ms = (value) => (Number.isFinite(value) ? value : Date.now());

// Le fichier a-t-il quelque chose à importer ?
const hasJsonData = (data) => ['users', 'sessions', 'chats'].some((k) => Object.keys(data[k] || {}).length > 0);

async function importJson(pool, data) {
  const users = data.users || {};
  const sessions = data.sessions || {};
  const chats = Object.values(data.chats || {});
  const counts = { users: 0, sessions: 0, chats: 0, messages: 0, profiles: 0, portfolios: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const names = new Set([...Object.keys(users), ...Object.values(sessions), ...chats.map((c) => c.owner)]);
    for (const username of names) {
      // Garde la date de création la plus ancienne (V12 a pu créer l'utilisateur avec now()).
      const { rows: [r] } = await client.query(
        `INSERT INTO users (username, created_at) VALUES ($1, to_timestamp($2 / 1000.0))
         ON CONFLICT (username) DO UPDATE SET created_at = LEAST(users.created_at, EXCLUDED.created_at)
         RETURNING (xmax = 0) AS inserted`,
        [username, ms(users[username]?.createdAt)]);
      if (r.inserted) counts.users++;
    }

    for (const [token, username] of Object.entries(sessions)) {
      const { rowCount } = await client.query(
        `INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
         ON CONFLICT (token) DO NOTHING`, [token, username, SESSION_MAX_AGE_S]);
      counts.sessions += rowCount;
    }

    for (const chat of chats) {
      const { rowCount } = await client.query(
        `INSERT INTO chats (id, owner, title, created_at, updated_at)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))
         ON CONFLICT (id) DO NOTHING`,
        [chat.id, chat.owner, chat.title, ms(chat.createdAt), ms(chat.updatedAt)]);
      if (!rowCount) continue; // déjà importée : ses messages aussi
      counts.chats++;
      for (const m of chat.messages || []) {
        await client.query(
          'INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))',
          [chat.id, m.role, m.content, ms(m.at)]);
        counts.messages++;
      }
    }

    for (const [username, u] of Object.entries(users)) {
      if (u.profile?.result) {
        const { answers, result, updatedAt } = u.profile;
        const { rowCount } = await client.query(
          `INSERT INTO investor_profiles (username, answers, result, risk_level, score, updated_at)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
           ON CONFLICT (username) DO NOTHING`,
          [username, JSON.stringify(answers), JSON.stringify(result), result.level.id, result.score, ms(updatedAt)]);
        counts.profiles += rowCount;
      }
      if (u.portfolio) {
        const { source, cash, createdAt, holdings = [] } = u.portfolio;
        const { rowCount } = await client.query(
          `INSERT INTO portfolios (username, source, cash, created_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
           ON CONFLICT (username) DO NOTHING`, [username, source, cash, ms(createdAt)]);
        if (!rowCount) continue;
        counts.portfolios++;
        for (const h of holdings) {
          await client.query(
            'INSERT INTO portfolio_holdings (username, symbol, quantity, avg_cost) VALUES ($1, $2, $3, $4)',
            [username, h.symbol, h.quantity, h.avgCost]);
        }
      }
    }

    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { importJson, hasJsonData };
