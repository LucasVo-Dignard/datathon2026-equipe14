'use strict';
// JSON backend always runs. Postgres tests need TEST_DATABASE_URL on a THROWAWAY
// database with all db/migrations applied (they create and delete the cs-* users).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatStore } = require('../app/chat-store');

async function exerciseStore(store, prefix = '') {
  const alice = `${prefix}alice`;
  const bob = `${prefix}bob`;
  await store.init();
  assert.deepEqual(await store.list(alice), []);

  const chat = await store.create(alice, 'Nouvelle conversation');
  assert.match(chat.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(chat.messages, []);
  assert.equal(typeof chat.updatedAt, 'number');

  const t = chat.updatedAt + 1000;
  const summary = await store.append(alice, chat.id, [
    { role: 'user', content: 'Bonjour', at: t },
    { role: 'assistant', content: 'Salut !', at: t + 500 },
  ], { title: 'Bonjour' });
  assert.deepEqual(summary, { id: chat.id, title: 'Bonjour', updatedAt: t + 500 });

  // No title: keeps the current one; messages stay in order.
  await store.append(alice, chat.id, [{ role: 'user', content: 'Encore', at: t + 2000 }]);
  const got = await store.get(alice, chat.id);
  assert.equal(got.title, 'Bonjour');
  assert.deepEqual(got.messages, [
    { role: 'user', content: 'Bonjour', at: t },
    { role: 'assistant', content: 'Salut !', at: t + 500 },
    { role: 'user', content: 'Encore', at: t + 2000 },
  ]);

  // Chats are per user: another owner sees nothing and changes nothing.
  assert.equal(await store.get(bob, chat.id), null);
  assert.equal(await store.rename(bob, chat.id, 'x'), null);
  assert.equal(await store.append(bob, chat.id, [{ role: 'user', content: 'x', at: t }]), null);
  assert.equal(await store.remove(bob, chat.id), false);
  assert.deepEqual(await store.list(bob), []);

  // Listing: most recent first.
  const other = await store.create(alice, 'Autre');
  await store.append(alice, other.id, [{ role: 'user', content: 'Plus récent', at: t + 5000 }]);
  assert.deepEqual((await store.list(alice)).map((c) => c.id), [other.id, chat.id]);

  assert.equal((await store.rename(alice, chat.id, 'Renommée')).title, 'Renommée');
  assert.equal(await store.remove(alice, chat.id), true);
  assert.equal(await store.get(alice, chat.id), null);
  assert.equal(await store.append(alice, chat.id, [{ role: 'user', content: 'x', at: t }]), null);
  assert.deepEqual((await store.list(alice)).map((c) => c.id), [other.id]);
}

test('JSON store', async () => {
  const db = { users: {}, sessions: {}, chats: {} };
  let saves = 0;
  const store = createChatStore({ db, saveDb: () => saves++, connectionString: '' });
  assert.equal(store.kind, 'json');
  await exerciseStore(store);
  assert.ok(saves >= 5);
});

test('Postgres store', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' }, async () => {
  const store = createChatStore({ connectionString: process.env.TEST_DATABASE_URL });
  assert.equal(store.kind, 'postgres');
  const { Client } = require('pg');
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  // Deleting the users cascades to their chats and messages (V12).
  const clean = () => admin.query("DELETE FROM users WHERE username LIKE 'cs-%'");
  await clean();
  try {
    await admin.query("INSERT INTO users (username) VALUES ('cs-alice'), ('cs-bob')");
    await exerciseStore(store, 'cs-');
    // Deleting a chat deleted its messages too (ON DELETE CASCADE): only the other chat's remain.
    const { rows } = await admin.query(
      "SELECT m.content FROM chat_messages m JOIN chats c ON c.id = m.chat_id WHERE c.owner = 'cs-alice'");
    assert.deepEqual(rows.map((r) => r.content), ['Plus récent']);
    await assert.rejects(admin.query(
      "INSERT INTO chat_messages (chat_id, role, content) SELECT id, 'system', 'x' FROM chats WHERE owner = 'cs-alice' LIMIT 1"),
    /check constraint/);
  } finally {
    await clean();
    await admin.end();
    await store.close();
  }
});
