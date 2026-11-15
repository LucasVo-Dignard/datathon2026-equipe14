'use strict';
// ---------------------------------------------------------------------------
// Stockage des conversations du chat (historique des messages).
//
//   - DATABASE_URL défini -> Postgres (tables chats et chat_messages, créées par
//                            la migration Flyway db/migrations/V9__create_chats.sql)
//   - sinon               -> fichier JSON du prototype (db.chats), pour que l'app
//                            tourne en local sans base
//
// Une conversation a la forme { id, title, createdAt, updatedAt, messages }, un
// message { role: 'user' | 'assistant', content, at } (dates en ms).
// Toutes les méthodes prennent le propriétaire : une conversation d'un autre
// utilisateur se comporte comme une conversation inexistante (null / false).
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');

const summary = ({ id, title, updatedAt }) => ({ id, title, updatedAt });

function createJsonStore({ db, saveDb }) {
  const own = (owner, id) => {
    const chat = Object.hasOwn(db.chats, id) ? db.chats[id] : null;
    return chat && chat.owner === owner ? chat : null;
  };
  const view = ({ owner, ...chat }) => ({ ...chat, messages: chat.messages.map((m) => ({ ...m })) });

  return {
    kind: 'json',
    async init() {},
    async list(owner) {
      return Object.values(db.chats)
        .filter((c) => c.owner === owner)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summary);
    },
    async create(owner, title) {
      const now = Date.now();
      const chat = { id: crypto.randomUUID(), owner, title, createdAt: now, updatedAt: now, messages: [] };
      db.chats[chat.id] = chat;
      saveDb();
      return view(chat);
    },
    async get(owner, id) {
      const chat = own(owner, id);
      return chat && view(chat);
    },
    async rename(owner, id, title) {
      const chat = own(owner, id);
      if (!chat) return null;
      chat.title = title;
      saveDb();
      return summary(chat);
    },
    async remove(owner, id) {
      if (!own(owner, id)) return false;
      delete db.chats[id];
      saveDb();
      return true;
    },
    // Ajoute des messages à la fin ; change le titre si `title` est fourni.
    async append(owner, id, messages, { title } = {}) {
      const chat = own(owner, id);
      if (!chat) return null;
      chat.messages.push(...messages.map(({ role, content, at }) => ({ role, content, at })));
      if (title) chat.title = title;
      chat.updatedAt = Math.max(chat.updatedAt, ...messages.map((m) => m.at));
      saveDb();
      return summary(chat);
    },
    async close() {},
  };
}

function createPgStore({ connectionString }) {
  // Chargé seulement si une base est configurée : l'app tourne sans `pg` sinon.
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error:', err.message));

  const toSummary = (row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at.getTime() });
  const COLUMNS = 'id, title, created_at, updated_at';

  return {
    kind: 'postgres',
    // Le schéma appartient à Flyway (db/migrations) : on vérifie seulement que les tables existent.
    async init() {
      const { rows } = await pool.query(
        "SELECT to_regclass('chats') AS chats, to_regclass('chat_messages') AS messages");
      if (!rows[0].chats || !rows[0].messages) {
        throw new Error('tables chats / chat_messages absentes : appliquez les migrations Flyway (voir README.md)');
      }
    },
    async list(owner) {
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM chats WHERE owner = $1 ORDER BY updated_at DESC`, [owner]);
      return rows.map(toSummary);
    },
    async create(owner, title) {
      const { rows } = await pool.query(
        `INSERT INTO chats (id, owner, title) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [crypto.randomUUID(), owner, title]);
      return { ...toSummary(rows[0]), createdAt: rows[0].created_at.getTime(), messages: [] };
    },
    async get(owner, id) {
      const { rows } = await pool.query(`SELECT ${COLUMNS} FROM chats WHERE id = $1 AND owner = $2`, [id, owner]);
      if (!rows[0]) return null;
      const messages = await pool.query(
        'SELECT role, content, created_at FROM chat_messages WHERE chat_id = $1 ORDER BY id', [id]);
      return {
        ...toSummary(rows[0]),
        createdAt: rows[0].created_at.getTime(),
        messages: messages.rows.map((m) => ({ role: m.role, content: m.content, at: m.created_at.getTime() })),
      };
    },
    async rename(owner, id, title) {
      const { rows } = await pool.query(
        `UPDATE chats SET title = $3 WHERE id = $1 AND owner = $2 RETURNING ${COLUMNS}`, [id, owner, title]);
      return rows[0] ? toSummary(rows[0]) : null;
    },
    async remove(owner, id) {
      // Les messages partent avec la conversation (ON DELETE CASCADE).
      const { rowCount } = await pool.query('DELETE FROM chats WHERE id = $1 AND owner = $2', [id, owner]);
      return rowCount > 0;
    },
    async append(owner, id, messages, { title } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Verrouille la conversation : si elle a été supprimée entre-temps, on n'écrit rien.
        const last = Math.max(...messages.map((m) => m.at));
        const { rows } = await client.query(
          `UPDATE chats
              SET title = COALESCE($3, title),
                  updated_at = GREATEST(updated_at, to_timestamp($4 / 1000.0))
            WHERE id = $1 AND owner = $2
        RETURNING ${COLUMNS}`,
          [id, owner, title || null, last]);
        if (!rows[0]) {
          await client.query('ROLLBACK');
          return null;
        }
        for (const { role, content, at } of messages) {
          await client.query(
            'INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))',
            [id, role, content, at]);
        }
        await client.query('COMMIT');
        return toSummary(rows[0]);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

function createChatStore({ db, saveDb, connectionString = process.env.DATABASE_URL }) {
  return connectionString ? createPgStore({ connectionString }) : createJsonStore({ db, saveDb });
}

module.exports = { createChatStore };
