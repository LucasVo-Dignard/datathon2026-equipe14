'use strict';
// Price-move alerts job (src/marketdata/jobs/price-alerts.js).
// Message tests always run. Database tests need TEST_DATABASE_URL on a
// THROWAWAY database with db/migrations V1..V8 applied (they delete rows).
const test = require('node:test');
const assert = require('node:assert/strict');
const alertsJob = require('../src/marketdata/jobs/price-alerts');
const { thresholdFor, THRESHOLDS } = require('../src/marketdata/alerts');

const TOKEN = '12345678-1234-4234-8234-123456789abc';
const move = (symbol, close, prevClose, date = '2026-11-13', prevDate = '2026-11-12') => ({
  symbol, date, close, prevDate, prevClose,
});
const alert = (username, thresholdPct, moves) => ({
  username, email: `${username}@example.com`, thresholdPct, token: TOKEN, moves,
});
const quietLog = { info() {}, warn() {}, error() {} };

test('shared thresholds: cautious profiles are warned earlier', () => {
  assert.equal(thresholdFor({ level: { id: 'faible' } }), 2);
  assert.equal(thresholdFor({ level: { id: 'eleve' } }), 7);
  assert.equal(thresholdFor(undefined), 4);
  assert.deepEqual(Object.values(THRESHOLDS), [2, 3, 4, 5, 7]);
});

test('single move email explains itself', () => {
  const c = alertsJob.compose(alert('ana', 4, [move('RY.TO', 162.35, 171.25)]), 'http://app');
  assert.equal(c.subject, 'Alerte de prix : RY.TO −5,2 %');
  for (const part of [c.text, c.html]) {
    assert.match(part, /−5,2 %/);
    assert.match(part, /171,25 → 162,35/);
    assert.match(part, /13 novembre 2026/);
    assert.match(part, /4 % ou plus/);
    assert.match(part, /niveau de risque/);
    assert.match(part, /Yahoo Finance/); // source
    assert.match(part, /pas un conseil financier/);
  }
  assert.equal(c.unsubscribe, `http://app/desabonnement?u=ana&t=${TOKEN}`);
  assert.ok(c.text.includes(c.unsubscribe));
  assert.ok(c.html.includes(`href="http://app/desabonnement?u=ana&amp;t=${TOKEN}"`));
});

test('several moves in one email; HTML is escaped; username is URL-encoded', () => {
  let c = alertsJob.compose(alert('ana', 2, [move('SHOP.TO', 160, 150), move('TD.TO', 77, 79.15)]));
  assert.equal(c.subject, 'Alerte de prix : 2 titres ont fortement varié');
  assert.match(c.text, /▲ SHOP\.TO.*\+6,7 %/);
  assert.match(c.text, /▼ TD\.TO/);
  assert.doesNotMatch(c.text, /Voir votre portefeuille/); // no app URL given
  c = alertsJob.compose(alert('a&b <x>', 4, [move('<b>', 90, 100)]), 'http://app');
  assert.match(c.unsubscribe, /u=a%26b%20%3Cx%3E/);
  assert.doesNotMatch(c.html, /<b>|<x>/);
});

test('alerts are skipped without a sender', async () => {
  const logs = [];
  const r = await alertsJob.sendPriceAlerts(null, { env: {}, log: { info: (m) => logs.push(m) } });
  assert.equal(r, null);
  assert.match(logs.join(), /no price alerts/);
});

// --- Database -----------------------------------------------------------------

const needsDb = { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL not set' };

function fakeSes({ reject = [] } = {}) {
  const sent = [];
  return {
    sent,
    async send(cmd) {
      const to = cmd.input.Destination.ToAddresses[0];
      if (reject.includes(to)) throw new Error('MessageRejected: Email address is not verified');
      sent.push(cmd.input);
      return { MessageId: String(sent.length) };
    },
  };
}

async function withDb(fn) {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const clean = async () => {
    await db.query("DELETE FROM notification_subscriptions WHERE username LIKE 'pa-%'");
    await db.query("DELETE FROM portfolios WHERE username LIKE 'pa-%'");
    await db.query("DELETE FROM price_bars WHERE symbol LIKE 'PA%'");
  };
  await clean();
  try {
    await fn(db);
  } finally {
    await clean();
    await db.end();
  }
}

const bar = (db, symbol, date, close) => db.query(
  `INSERT INTO price_bars (symbol, provider, date, open, high, low, close, adj_close, volume, fetched_at)
   VALUES ($1, 'yahoo', $2, $3, $3, $3, $3, $3, 1000, now())`, [symbol, date, close]);

async function subscriber(db, username, threshold, symbols) {
  await db.query('INSERT INTO notification_subscriptions (username, email, threshold_pct) VALUES ($1, $2, $3)',
    [username, `${username}@example.com`, threshold]);
  await db.query("INSERT INTO portfolios (username, source, cash) VALUES ($1, 'custom', 0)", [username]);
  for (const s of symbols) {
    await db.query('INSERT INTO portfolio_holdings (username, symbol, quantity, avg_cost) VALUES ($1, $2, 1, 1)', [username, s]);
  }
}

test('threshold, freshness, holdings, dedup and failures', needsDb, () => withDb(async (db) => {
  await bar(db, 'PABIG', '2026-11-12', 100); await bar(db, 'PABIG', '2026-11-13', 95); // -5 %
  await bar(db, 'PASMALL', '2026-11-12', 100); await bar(db, 'PASMALL', '2026-11-13', 97); // -3 %
  await bar(db, 'PAOLD', '2026-11-02', 100); await bar(db, 'PAOLD', '2026-11-03', 80); // -20 %, stale

  await subscriber(db, 'pa-cautious', 2, ['PABIG', 'PASMALL', 'PAOLD']); // Faible: 2 %
  await subscriber(db, 'pa-bold', 7, ['PABIG']); // Élevé: 7 %
  await subscriber(db, 'pa-unverified', 4, ['PABIG']); // SES rejects (sandbox)
  // A portfolio without a subscription is never alerted.
  await db.query("INSERT INTO portfolios (username, source, cash) VALUES ('pa-nosub', 'custom', 0)");
  await db.query("INSERT INTO portfolio_holdings (username, symbol, quantity, avg_cost) VALUES ('pa-nosub', 'PABIG', 1, 1)");

  const today = '2026-11-13';
  const found = Object.fromEntries((await alertsJob.findAlerts(db, today)).map((a) => [a.username, a]));
  assert.deepEqual(Object.keys(found).sort(), ['pa-cautious', 'pa-unverified'], 'pa-bold: -5 % is under 7 %');
  assert.deepEqual(found['pa-cautious'].moves.map((m) => m.symbol), ['PABIG', 'PASMALL'], 'largest first, stale PAOLD ignored');
  assert.equal(found['pa-cautious'].moves[0].prevDate, '2026-11-12');
  assert.match(found['pa-cautious'].token, /^[0-9a-f-]{36}$/);

  assert.ok((await alertsJob.subscribedSymbols(db)).includes('PAOLD'), 'subscribers\' holdings are refreshed too');
  assert.ok(!(await alertsJob.subscribedSymbols(db)).includes('PANOPE'));

  const ses = fakeSes({ reject: ['pa-unverified@example.com'] });
  const report = await alertsJob.sendAlerts(db, ses, Object.values(found), {
    sender: 'alertes@example.com', appUrl: 'http://app', configurationSet: 'cfg', log: quietLog,
  });
  assert.equal(report.usersNotified, 1);
  assert.equal(report.movesSent, 2);
  assert.deepEqual(report.failedUsers, ['pa-unverified']);
  const [mail] = ses.sent;
  assert.equal(mail.FromEmailAddress, 'alertes@example.com');
  assert.deepEqual(mail.Destination, { ToAddresses: ['pa-cautious@example.com'] });
  assert.equal(mail.ConfigurationSetName, 'cfg');
  assert.equal(mail.Content.Simple.Subject.Data, 'Alerte de prix : 2 titres ont fortement varié');
  assert.match(mail.Content.Simple.Headers[0].Value, /^<http:\/\/app\/desabonnement\?u=pa-cautious&t=/);

  // Rerun: already sent for pa-cautious, still pending for pa-unverified.
  assert.deepEqual((await alertsJob.findAlerts(db, today)).map((a) => a.username), ['pa-unverified']);

  // A new trading day with a new move alerts again.
  await bar(db, 'PABIG', '2026-11-16', 85); // Monday, -10.5 %
  const later = Object.fromEntries((await alertsJob.findAlerts(db, '2026-11-16')).map((a) => [a.username, a]));
  assert.deepEqual(Object.keys(later).sort(), ['pa-bold', 'pa-cautious', 'pa-unverified']);
  assert.deepEqual(later['pa-cautious'].moves.map((m) => m.symbol), ['PABIG']);

  // Selling the stock stops its alerts.
  await db.query("DELETE FROM portfolio_holdings WHERE username = 'pa-bold'");
  assert.ok(!(await alertsJob.findAlerts(db, '2026-11-16')).some((a) => a.username === 'pa-bold'));
}));

test('dry run sends and records nothing; daily refresh calls the alerts', needsDb, () => withDb(async (db) => {
  // Relative to the real clock: daily-refresh.js uses today's date.
  const day = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);
  await bar(db, 'PABIG', day(-1), 100); await bar(db, 'PABIG', day(0), 90);
  await subscriber(db, 'pa-dry', 4, ['PABIG']);
  const r = await alertsJob.run(db, null, { today: day(0), dryRun: true, log: quietLog });
  assert.equal(r.usersNotified, 0);
  assert.deepEqual((await alertsJob.findAlerts(db, day(0))).map((a) => a.username), ['pa-dry']);

  // daily-refresh.js: alerts run after the refresh, with the subscribers' holdings refreshed.
  const ses = fakeSes();
  const { main } = require('../src/marketdata/jobs/daily-refresh');
  const seen = [];
  const original = alertsJob.sendPriceAlerts;
  alertsJob.sendPriceAlerts = (conn, opts) => original(conn, { ...opts, ses });
  try {
    const code = await main([], {
      env: { DATABASE_URL: process.env.TEST_DATABASE_URL, ALERTS_SENDER: 'alertes@example.com' },
      log: quietLog,
      steps: [['test.step', async (_db, symbol) => { seen.push(symbol); }]],
    });
    assert.equal(code, 0);
  } finally {
    alertsJob.sendPriceAlerts = original;
  }
  assert.ok(seen.includes('PABIG'), 'subscriber holding refreshed');
  assert.deepEqual(ses.sent.map((m) => m.Destination.ToAddresses[0]), ['pa-dry@example.com'], 'alert sent after the refresh');
}));
