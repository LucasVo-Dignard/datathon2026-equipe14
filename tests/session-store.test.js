'use strict';
// Users and login sessions, and the JSON file import. JSON backend always runs.
// Postgres tests need TEST_DATABASE_URL on a THROWAWAY database with
// db/migrations V1..V12 applied (they delete the ss-* users).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionStore } = require('../app/session-store');
const { createChatStore } = require('../app/chat-store');
const { importJson, hasJsonData } = require('../app/json-import');
const { validate, buildProfile, PERSONAS } = require('../app/profile');

async function exerciseStore(store, prefix) {
  const alice = `${prefix}alice`;
  const bob = `${prefix}bob`;
  await store.init();

  assert.equal(await store.user('nope'), null);
  assert.equal(await store.user(null), null);
  await store.login(alice, `${prefix}t1`);
  await store.login(alice, `${prefix}t2`); // second device, same user
  await store.login(bob, `${prefix}t3`);
  assert.equal(await store.user(`${prefix}t1`), alice);
  assert.equal(await store.user(`${prefix}t3`), bob);

  await store.logout(`${prefix}t1`);
  await store.logout(`${prefix}t1`); // already closed: no error
  await store.logout(null);
  assert.equal(await store.user(`${prefix}t1`), null);
  assert.equal(await store.user(`${prefix}t2`), alice, 'other sessions stay open');
}

test('JSON store', async () => {
  const db = { users: { alice: { createdAt: 1, profile: {} } }, sessions: {}, chats: {} };
  let saves = 0;
  const store = createSessionStore({ db, saveDb: () => saves++, connectionString: '' });
  assert.equal(store.kind, 'json');
  await exerciseStore(store, '');
  assert.deepEqual(db.users.alice, { createdAt: 1, profile: {} }, 'login keeps an existing user');
  assert.deepEqual(Object.keys(db.users).sort(), ['alice', 'bob']);
  assert.ok(saves >= 4);
});

test('hasJsonData', () => {
  assert.equal(hasJsonData({}), false);
  assert.equal(hasJsonData({ users: {}, sessions: {}, chats: {}, reports: { r: {} } }), false, 'reports stay in the file');
  assert.equal(hasJsonData({ users: { a: {} } }), true);
});

const needsDb = { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' };

async function withPg(fn) {
  const store = createSessionStore({ connectionString: process.env.TEST_DATABASE_URL });
  // Cascades to sessions, chats, profiles and portfolios (V12).
  const clean = () => store.pool.query("DELETE FROM users WHERE username LIKE 'ss-%'");
  await clean();
  try {
    await fn(store);
  } finally {
    await clean();
    await store.close();
  }
}

test('Postgres store', needsDb, () => withPg(async (store) => {
  assert.equal(store.kind, 'postgres');
  await exerciseStore(store, 'ss-');

  // Expired sessions are refused, then removed at the next login.
  await store.pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token = 'ss-t3'");
  assert.equal(await store.user('ss-t3'), null);
  await store.login('ss-bob', 'ss-t4');
  assert.equal((await store.pool.query("SELECT 1 FROM sessions WHERE token = 'ss-t3'")).rowCount, 0);

  // Foreign keys (V12): no portfolio for an unknown user.
  await assert.rejects(store.pool.query(
    "INSERT INTO portfolios (username, source) VALUES ('ss-nobody', 'custom')"), /foreign key/);
}));

test('JSON file import into Postgres, idempotent', needsDb, () => withPg(async (store) => {
  const answers = validate(PERSONAS.find((p) => p.id === 'mateo').answers);
  const chatId = '11111111-2222-4333-8444-555555555555';
  const data = {
    users: {
      'ss-old': {
        createdAt: Date.parse('2026-01-02T03:04:05Z'),
        profile: { answers, result: buildProfile(answers), updatedAt: Date.now() },
        portfolio: { source: 'custom', cash: 10, createdAt: Date.now(), holdings: [{ symbol: 'RY.TO', quantity: 2, avgCost: 150 }] },
      },
    },
    sessions: { 'ss-old-token': 'ss-old' },
    chats: {
      [chatId]: {
        id: chatId, owner: 'ss-old', title: 'Ancienne', createdAt: 1, updatedAt: 2_000,
        messages: [{ role: 'user', content: 'q', at: 1_000 }, { role: 'assistant', content: 'r', at: 2_000 }],
      },
    },
  };
  const counts = await importJson(store.pool, data);
  assert.deepEqual(counts, { users: 1, sessions: 1, chats: 1, messages: 2, profiles: 1, portfolios: 1 });

  assert.equal(await store.user('ss-old-token'), 'ss-old', 'users stay logged in');
  const chats = createChatStore({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const chat = await chats.get('ss-old', chatId);
    assert.equal(chat.title, 'Ancienne');
    assert.deepEqual(chat.messages.map((m) => [m.content, m.at]), [['q', 1_000], ['r', 2_000]]);
  } finally {
    await chats.close();
  }
  const { rows: [u] } = await store.pool.query("SELECT created_at FROM users WHERE username = 'ss-old'");
  assert.equal(u.created_at.toISOString(), '2026-01-02T03:04:05.000Z');
  const { rows: [p] } = await store.pool.query("SELECT risk_level FROM investor_profiles WHERE username = 'ss-old'");
  assert.equal(p.risk_level, 'modere');
  const { rows: h } = await store.pool.query("SELECT symbol FROM portfolio_holdings WHERE username = 'ss-old'");
  assert.deepEqual(h.map((r) => r.symbol), ['RY.TO']);

  // Second run adds nothing.
  assert.deepEqual(await importJson(store.pool, data), { users: 0, sessions: 0, chats: 0, messages: 0, profiles: 0, portfolios: 0 });
  const { rows: [{ n }] } = await store.pool.query('SELECT count(*)::int AS n FROM chat_messages WHERE chat_id = $1', [chatId]);
  assert.equal(n, 2);
}));
