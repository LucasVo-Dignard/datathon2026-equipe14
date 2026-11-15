'use strict';
// Report storage: JSON file, and S3 with an in-memory fake client (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReportStore, MAX_REPORTS } = require('../app/reports-store');

function fakeS3() {
  const objects = new Map(); // key -> { body, at }
  let clock = 0;
  return {
    objects,
    async send(cmd) {
      const { Bucket, Key, Prefix, Body } = cmd.input;
      assert.equal(Bucket, 'bucket');
      switch (cmd.constructor.name) {
        case 'PutObjectCommand':
          objects.set(Key, { body: Body, at: new Date(++clock * 1000) });
          return {};
        case 'GetObjectCommand':
          return { Body: { transformToString: async () => objects.get(Key).body } };
        case 'DeleteObjectCommand':
          objects.delete(Key);
          return {};
        case 'ListObjectsV2Command':
          return {
            Contents: [...objects].filter(([k]) => k.startsWith(Prefix)).map(([k, o]) => ({ Key: k, LastModified: o.at })),
            IsTruncated: false,
          };
        default:
          throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    },
  };
}

const report = (owner, n) => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  owner, period: 'daily', title: 'Rapport quotidien', createdAt: n, content: `r${n}`,
});

function stores() {
  const db = { users: {} };
  const client = fakeS3();
  return [
    ['json', createReportStore({ db, saveDb: () => {}, bucket: '' }), null],
    ['s3', createReportStore({ db, saveDb: () => {}, bucket: 'bucket', client }), client],
  ];
}

for (const [kind, store, client] of stores()) {
  test(`${kind}: save, list newest first, per user, remove`, async () => {
    assert.equal(store.kind, kind);
    await store.save(report('alice', 1));
    await store.save(report('alice', 2));
    await store.save(report('bob', 3));
    assert.deepEqual((await store.list('alice')).map((r) => r.content), ['r2', 'r1']);
    assert.deepEqual((await store.list('bob')).map((r) => r.content), ['r3']);

    assert.equal(await store.remove('bob', report('alice', 1).id), false);
    assert.equal(await store.remove('alice', report('alice', 1).id), true);
    assert.deepEqual((await store.list('alice')).map((r) => r.content), ['r2']);
    if (client) assert.ok(client.objects.has(`reports/bob/${report('bob', 3).id}.json`));
  });

  test(`${kind}: keeps only the most recent reports`, async () => {
    for (let n = 10; n < 10 + MAX_REPORTS + 3; n++) await store.save(report('carol', n));
    const kept = await store.list('carol');
    assert.equal(kept.length, MAX_REPORTS);
    assert.equal(kept[0].createdAt, 10 + MAX_REPORTS + 2);
    assert.equal(kept.at(-1).createdAt, 13);
  });
}
