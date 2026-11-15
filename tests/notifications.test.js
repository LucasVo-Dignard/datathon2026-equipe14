'use strict';
// Pure tests always run. The Postgres tests need TEST_DATABASE_URL pointing to a
// THROWAWAY database with db/migrations V1..V8 applied (they delete rows).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNotifications, thresholdFor, normalizeEmail, emailContent, NotificationError, THRESHOLDS,
} = require('../app/notifications');

test('threshold follows the risk level, cautious profiles get earlier alerts', () => {
  assert.equal(thresholdFor({ level: { id: 'faible' } }), 2);
  assert.equal(thresholdFor({ level: { id: 'eleve' } }), 7);
  assert.equal(thresholdFor(null), 4);
  const ordered = ['faible', 'faible-modere', 'modere', 'modere-eleve', 'eleve'].map((id) => THRESHOLDS[id]);
  assert.deepEqual([...ordered].sort((a, b) => a - b), ordered);
});

test('emails are validated and normalized', () => {
  assert.equal(normalizeEmail('  Youcef@Poly.CA '), 'youcef@poly.ca');
  for (const bad of ['', 'x', 'a@b', 'a b@c.d', '@c.d', null, 42]) {
    assert.throws(() => normalizeEmail(bad), NotificationError, String(bad));
  }
});

test('email content has text and escaped HTML, with the unsubscribe link', () => {
  const c = emailContent({
    subject: 's', paragraphs: ['<b>x</b> & y'], appUrl: 'http://app', unsubscribe: 'http://app/desabonnement?u=a&t=1',
  });
  assert.match(c.text, /<b>x<\/b> & y/);
  assert.match(c.text, /Ne plus recevoir ces alertes : http:\/\/app\/desabonnement\?u=a&t=1/);
  assert.match(c.html, /&lt;b&gt;x&lt;\/b&gt; &amp; y/);
  assert.match(c.html, /href="http:\/\/app\/desabonnement\?u=a&amp;t=1"/);
  assert.match(c.text, /pas un conseil financier/);
});

test('disabled without a database or a sender', async () => {
  const n = createNotifications({});
  assert.equal(n.enabled, false);
  assert.deepEqual(await n.get('x'), { enabled: false, status: 'none', thresholdPct: 4 });
  await assert.rejects(n.subscribe('x', 'a@b.cd', {}), (e) => e.status === 503);
  assert.equal(await n.unsubscribeWithToken('x', '00000000-0000-4000-8000-000000000000'), false);
});

// Fake SES: identities are pending until verify(email); `production` skips verification.
function fakeSes({ production = false } = {}) {
  const identities = new Map();
  const calls = [];
  return {
    calls,
    identities,
    verify: (email) => identities.set(email, true),
    async send(cmd) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      calls.push({ name, input: i });
      if (name === 'GetAccountCommand') return { ProductionAccessEnabled: production };
      if (name === 'CreateEmailIdentityCommand') {
        if (identities.has(i.EmailIdentity)) throw Object.assign(new Error('exists'), { name: 'AlreadyExistsException' });
        identities.set(i.EmailIdentity, false);
        return {};
      }
      if (name === 'GetEmailIdentityCommand') {
        if (!identities.has(i.EmailIdentity)) throw Object.assign(new Error('nf'), { name: 'NotFoundException' });
        return { VerifiedForSendingStatus: identities.get(i.EmailIdentity) };
      }
      if (name === 'SendEmailCommand') return { MessageId: 'm-1' };
      throw new Error(`unexpected ${name}`);
    },
  };
}

const needsDb = { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' };

async function withDb(fn) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const clean = () => pool.query("DELETE FROM notification_subscriptions WHERE username LIKE 'test-%'")
    .then(() => pool.query("DELETE FROM portfolios WHERE username LIKE 'test-%'"));
  await clean();
  try {
    await fn(pool);
  } finally {
    await clean();
    await pool.end();
  }
}

const modere = { level: { id: 'modere', label: 'Modéré' } };

test('Postgres, SES sandbox: verify, test email, threshold, unsubscribe link', needsDb, () => withDb(async (pool) => {
  const ses = fakeSes();
  const n = createNotifications({
    pool, ses, sender: 'alertes@example.com', configurationSet: 'cfg', appUrl: 'http://app',
  });
  assert.equal((await n.get('test-a', { profile: modere })).thresholdPct, 4);

  let st = await n.subscribe('test-a', ' A@Example.com ', { profile: modere });
  assert.equal(st.status, 'pending');
  assert.equal(st.sandbox, true);
  assert.equal(st.email, 'a@example.com');
  assert.deepEqual(st.symbols, [], 'no portfolio yet');
  assert.ok(ses.calls.some((c) => c.name === 'CreateEmailIdentityCommand' && c.input.EmailIdentity === 'a@example.com'),
    'sandbox: SES is asked to send its verification email');

  // The followed symbols are the user's holdings (V7), read live.
  await pool.query("INSERT INTO portfolios (username, source, cash) VALUES ('test-a', 'custom', 0)");
  await pool.query(`INSERT INTO portfolio_holdings (username, symbol, quantity, avg_cost)
                    VALUES ('test-a', 'TD.TO', 1, 1), ('test-a', 'RY.TO', 2, 1)`);
  assert.deepEqual((await n.get('test-a')).symbols, ['RY.TO', 'TD.TO']);

  await assert.rejects(n.sendTest('test-a', { profile: modere }), (e) => e.status === 409 && /Vérifiez/.test(e.message));

  // Subscribing again before verifying must not fail (identity already exists).
  st = await n.subscribe('test-a', 'a@example.com', { profile: modere });
  assert.equal(st.status, 'pending');

  ses.verify('a@example.com');
  assert.equal((await n.get('test-a')).status, 'active');

  const sent = await n.sendTest('test-a', { profile: modere });
  assert.equal(sent.sent, true);
  const mail = ses.calls.find((c) => c.name === 'SendEmailCommand').input;
  assert.equal(mail.FromEmailAddress, 'alertes@example.com');
  assert.deepEqual(mail.Destination, { ToAddresses: ['a@example.com'] });
  assert.equal(mail.ConfigurationSetName, 'cfg');
  const { Subject, Body, Headers } = mail.Content.Simple;
  assert.match(Subject.Data, /Test/);
  assert.match(Body.Text.Data, /4 % ou plus/);
  assert.match(Body.Text.Data, /Modéré/);
  assert.match(Body.Html.Data, /<html/);
  const { rows: [{ unsubscribe_token: token }] } = await pool.query(
    "SELECT unsubscribe_token FROM notification_subscriptions WHERE username = 'test-a'");
  assert.deepEqual(Headers, [{ Name: 'List-Unsubscribe', Value: `<http://app/desabonnement?u=test-a&t=${token}>` }]);
  assert.match(Body.Text.Data, new RegExp(`desabonnement\\?u=test-a&t=${token}`));

  await n.updateThreshold('test-a', { level: { id: 'eleve' } });
  assert.equal((await n.get('test-a')).thresholdPct, 7);

  // Unsubscribe link: wrong or malformed token does nothing, the right one works once.
  assert.equal(await n.unsubscribeWithToken('test-a', '00000000-0000-4000-8000-000000000000'), false);
  assert.equal(await n.unsubscribeWithToken('test-a', "x' OR '1'='1"), false);
  assert.equal(await n.unsubscribeWithToken('test-a', token), true);
  assert.equal(await n.unsubscribeWithToken('test-a', token), false);
  assert.equal((await n.get('test-a')).status, 'none');

  // A new subscription with another address gets a new token.
  await n.subscribe('test-a', 'a@example.com', { profile: modere });
  const t1 = (await pool.query("SELECT unsubscribe_token FROM notification_subscriptions WHERE username = 'test-a'")).rows[0].unsubscribe_token;
  await n.subscribe('test-a', 'b@example.com', { profile: modere });
  const t2 = (await pool.query("SELECT unsubscribe_token FROM notification_subscriptions WHERE username = 'test-a'")).rows[0].unsubscribe_token;
  assert.notEqual(t1, t2);

  await n.unsubscribe('test-a');
  assert.equal((await n.get('test-a')).status, 'none');
}));

test('Postgres, SES production access: active right away, no verification email', needsDb, () => withDb(async (pool) => {
  const ses = fakeSes({ production: true });
  const n = createNotifications({ pool, ses, sender: 'alertes@example.com', appUrl: 'http://app' });
  const st = await n.subscribe('test-p', 'p@example.com', { profile: modere });
  assert.equal(st.status, 'active');
  assert.equal(st.sandbox, false);
  assert.ok(!ses.calls.some((c) => c.name === 'CreateEmailIdentityCommand'));
  assert.equal((await n.sendTest('test-p', { profile: modere })).sent, true);
}));
