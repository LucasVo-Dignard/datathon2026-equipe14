'use strict';
// Pure tests always run. The Postgres tests need TEST_DATABASE_URL pointing to a
// THROWAWAY database with db/migrations V1..V5 applied (they delete rows).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNotifications, thresholdFor, asciiSubject, normalizeEmail, NotificationError, THRESHOLDS,
} = require('../app/notifications');

test('threshold follows the risk level, cautious profiles get earlier alerts', () => {
  assert.equal(thresholdFor({ level: { id: 'faible' } }), 2);
  assert.equal(thresholdFor({ level: { id: 'eleve' } }), 7);
  assert.equal(thresholdFor(null), 4);
  const ordered = ['faible', 'faible-modere', 'modere', 'modere-eleve', 'eleve'].map((id) => THRESHOLDS[id]);
  assert.deepEqual([...ordered].sort((a, b) => a - b), ordered);
});

test('SNS subjects are ASCII and short', () => {
  const s = asciiSubject('Alerte prix : RY.TO −5,2 % aujourd’hui, « élevé » '.repeat(5));
  assert.match(s, /^[\x20-\x7E]*$/);
  assert.ok(s.length < 100);
  assert.ok(s.startsWith("Alerte prix : RY.TO -5,2 % aujourd'hui"));
});

test('emails are validated and normalized', () => {
  assert.equal(normalizeEmail('  Youcef@Poly.CA '), 'youcef@poly.ca');
  for (const bad of ['', 'x', 'a@b', 'a b@c.d', '@c.d', null, 42]) {
    assert.throws(() => normalizeEmail(bad), NotificationError, String(bad));
  }
});

test('disabled without a database or a topic', async () => {
  const n = createNotifications({});
  assert.equal(n.enabled, false);
  assert.deepEqual(await n.get('x'), { enabled: false, status: 'none', thresholdPct: 4 });
  await assert.rejects(n.subscribe('x', 'a@b.cd', { symbols: [] }), (e) => e.status === 503);
});

// Fake SNS: email subscriptions start pending until confirm(arn).
function fakeSns() {
  const subs = new Map();
  const calls = [];
  let n = 0;
  return {
    calls,
    subs,
    confirm: (arn) => { subs.get(arn).pending = false; },
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      const i = cmd.input;
      if (name === 'SubscribeCommand') {
        for (const s of subs.values()) {
          if (s.email === i.Endpoint && s.filter !== i.Attributes.FilterPolicy) {
            throw Object.assign(new Error('Invalid parameter: Attributes Reason: Subscription already exists with different attributes'), { name: 'InvalidParameterException' });
          }
        }
        const arn = `arn:aws:sns:us-east-1:1:t:${++n}`;
        subs.set(arn, { email: i.Endpoint, filter: i.Attributes.FilterPolicy, pending: true });
        return { SubscriptionArn: arn };
      }
      if (name === 'GetSubscriptionAttributesCommand') {
        const s = subs.get(i.SubscriptionArn);
        if (!s) throw Object.assign(new Error('not found'), { name: 'NotFoundException' });
        return { Attributes: { PendingConfirmation: String(s.pending) } };
      }
      if (name === 'UnsubscribeCommand') { subs.delete(i.SubscriptionArn); return {}; }
      if (name === 'PublishCommand') return { MessageId: 'm-1' };
      throw new Error(`unexpected ${name}`);
    },
  };
}

test('Postgres: subscribe, confirm, test email, threshold update, unsubscribe', {
  skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set',
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query("DELETE FROM notification_subscriptions WHERE username LIKE 'test-%'");
  await pool.query("DELETE FROM tracked_symbols WHERE symbol = 'ZZZ.TO'");
  const sns = fakeSns();
  const n = createNotifications({ pool, sns, topicArn: 'arn:aws:sns:us-east-1:1:t', appUrl: 'http://app' });
  const modere = { level: { id: 'modere', label: 'Modéré' } };
  try {
    assert.equal((await n.get('test-a', { profile: modere })).thresholdPct, 4);

    let st = await n.subscribe('test-a', ' A@Example.com ', { profile: modere, symbols: ['RY.TO', 'ZZZ.TO', 'RY.TO'] });
    assert.equal(st.status, 'pending');
    assert.equal(st.email, 'a@example.com');
    assert.deepEqual(st.symbols, ['RY.TO', 'ZZZ.TO']);
    const sub = sns.calls.find((c) => c.name === 'SubscribeCommand').input;
    assert.equal(sub.Protocol, 'email');
    assert.deepEqual(JSON.parse(sub.Attributes.FilterPolicy), { username: ['test-a'] });
    assert.equal(sub.Attributes.FilterPolicyScope, 'MessageAttributes');
    const tracked = await pool.query("SELECT 1 FROM tracked_symbols WHERE symbol = 'ZZZ.TO'");
    assert.equal(tracked.rowCount, 1, 'portfolio symbols become tracked');

    await assert.rejects(n.sendTest('test-a', { profile: modere }), (e) => e.status === 409 && /Confirmez/.test(e.message));

    const arn = [...sns.subs.keys()][0];
    sns.confirm(arn);
    assert.equal((await n.get('test-a')).status, 'confirmed');

    const sent = await n.sendTest('test-a', { profile: modere });
    assert.equal(sent.sent, true);
    const pub = sns.calls.find((c) => c.name === 'PublishCommand').input;
    assert.deepEqual(pub.MessageAttributes.username, { DataType: 'String', StringValue: 'test-a' });
    assert.match(pub.Subject, /^[\x20-\x7E]+$/);
    assert.match(pub.Message, /4 % ou plus/);
    assert.match(pub.Message, /Modéré/);

    // Same email already used by another user's filter.
    await assert.rejects(n.subscribe('test-b', 'a@example.com', { symbols: [] }), (e) => e.status === 409);

    await n.updateThreshold('test-a', { level: { id: 'eleve' } });
    assert.equal((await n.get('test-a')).thresholdPct, 7);

    // Unsubscribed from the email link: the row is cleaned up on next read.
    sns.subs.delete(arn);
    assert.equal((await n.get('test-a')).status, 'none');
    assert.equal((await pool.query("SELECT 1 FROM notification_subscriptions WHERE username = 'test-a'")).rowCount, 0);

    await n.subscribe('test-a', 'a@example.com', { profile: modere, symbols: ['RY.TO'] });
    assert.equal((await n.unsubscribe('test-a')).status, 'none');
    assert.equal(sns.subs.size, 0);
  } finally {
    await pool.query("DELETE FROM notification_subscriptions WHERE username LIKE 'test-%'");
    await pool.query("DELETE FROM tracked_symbols WHERE symbol = 'ZZZ.TO'");
    await pool.end();
  }
});
