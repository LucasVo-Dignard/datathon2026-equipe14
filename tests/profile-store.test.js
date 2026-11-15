'use strict';
// JSON backend always runs. Postgres tests need TEST_DATABASE_URL on a THROWAWAY
// database with all db/migrations applied (they create and delete the ps-* users).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProfileStore } = require('../app/profile-store');
const { validate, buildProfile, PERSONAS } = require('../app/profile');

const sample = (id) => {
  const answers = validate(PERSONAS.find((p) => p.id === id).answers);
  return { answers, result: buildProfile(answers), updatedAt: Date.now() };
};

async function exerciseStore(store, prefix = '') {
  const alice = `${prefix}alice`;
  const bob = `${prefix}bob`;
  await store.init();
  assert.equal(await store.get(`${prefix}nobody`), null);

  const saved = await store.save(alice, sample('robert'));
  assert.equal(saved.result.level.id, 'faible-modere');
  assert.equal(typeof saved.updatedAt, 'number');

  // Upsert: second save replaces the first.
  await store.save(alice, sample('amira'));
  const got = await store.get(alice);
  assert.equal(got.result.level.id, 'eleve');
  assert.deepEqual(got.answers, sample('amira').answers);

  // Profiles are per user.
  await store.save(bob, sample('mateo'));
  assert.equal((await store.get(bob)).result.level.id, 'modere');
  assert.equal((await store.get(alice)).result.level.id, 'eleve');
}

test('JSON store', async () => {
  const db = { users: { alice: { createdAt: 1 } }, sessions: {}, chats: {} };
  let saves = 0;
  const store = createProfileStore({ db, saveDb: () => saves++, connectionString: '' });
  assert.equal(store.kind, 'json');
  await exerciseStore(store);
  assert.equal(db.users.alice.createdAt, 1, 'keeps existing user fields');
  assert.ok(saves >= 3);
});

test('Postgres store', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' }, async () => {
  const store = createProfileStore({ connectionString: process.env.TEST_DATABASE_URL });
  assert.equal(store.kind, 'postgres');
  const { Client } = require('pg');
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  // Deleting the users cascades to their profiles (V12).
  const clean = () => admin.query("DELETE FROM users WHERE username LIKE 'ps-%'");
  await clean();
  try {
    await admin.query("INSERT INTO users (username) VALUES ('ps-alice'), ('ps-bob'), ('ps-x')");
    await exerciseStore(store, 'ps-');
    const { rows } = await admin.query(
      "SELECT username, risk_level FROM investor_profiles WHERE username LIKE 'ps-%' ORDER BY username");
    assert.deepEqual(rows.map((r) => [r.username, r.risk_level]), [['ps-alice', 'eleve'], ['ps-bob', 'modere']]);
    await assert.rejects(admin.query(
      "INSERT INTO investor_profiles (username, answers, result, risk_level, score) VALUES ('ps-x', '{}', '{}', 'eleve', 150)"),
    /check constraint/);
  } finally {
    await clean();
    await admin.end();
    await store.close();
  }
});
