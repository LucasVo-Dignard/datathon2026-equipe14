'use strict';
// JSON backend always runs. Postgres backend runs only if TEST_DATABASE_URL is set,
// e.g. TEST_DATABASE_URL=postgres://localhost:5433/test npm test
// WARNING: it drops and recreates the investor_profiles table in that database,
// applying db/migrations/V4__create_investor_profiles.sql (what Flyway runs).
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProfileStore } = require('../app/profile-store');
const { validate, buildProfile, PERSONAS } = require('../app/profile');

const sample = (id) => {
  const answers = validate(PERSONAS.find((p) => p.id === id).answers);
  return { answers, result: buildProfile(answers), updatedAt: Date.now() };
};

async function exerciseStore(store) {
  await store.init();
  assert.equal(await store.get('nobody'), null);

  const saved = await store.save('alice', sample('robert'));
  assert.equal(saved.result.level.id, 'faible-modere');
  assert.equal(typeof saved.updatedAt, 'number');

  // Upsert: second save replaces the first.
  await store.save('alice', sample('amira'));
  const got = await store.get('alice');
  assert.equal(got.result.level.id, 'eleve');
  assert.deepEqual(got.answers, sample('amira').answers);

  // Profiles are per user.
  await store.save('bob', sample('mateo'));
  assert.equal((await store.get('bob')).result.level.id, 'modere');
  assert.equal((await store.get('alice')).result.level.id, 'eleve');
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
  await admin.query('DROP TABLE IF EXISTS investor_profiles');
  try {
    await assert.rejects(store.init(), /migrations Flyway/, 'init() reports a missing migration');
    await admin.query(fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', 'V4__create_investor_profiles.sql'), 'utf8'));
    await exerciseStore(store);
    const { rows } = await admin.query('SELECT username, risk_level, score FROM investor_profiles ORDER BY username');
    assert.deepEqual(rows.map((r) => [r.username, r.risk_level]), [['alice', 'eleve'], ['bob', 'modere']]);
    await assert.rejects(admin.query(
      "INSERT INTO investor_profiles (username, answers, result, risk_level, score) VALUES ('x', '{}', '{}', 'eleve', 150)"),
    /check constraint/);
  } finally {
    await admin.end();
    await store.close();
  }
});
