'use strict';
// Price-move alerts by email (Amazon SES).
//
// Runs at the end of the daily refresh (daily-refresh.js) when ALERTS_SENDER
// is set, or on its own:
//
//     DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata \
//     ALERTS_SENDER=alertes@example.com node src/marketdata/jobs/price-alerts.js [--dry-run] [--today 2026-11-13]
//
// For every subscriber (notification_subscriptions, written by the web app),
// it compares the two latest daily closes of each symbol in the user's
// portfolio (portfolio_holdings). A move of threshold_pct or more (the
// threshold follows the risk level) becomes an alert. Each user gets at most
// one email per run, listing all their moves, with a one-click unsubscribe link.
//
// price_alerts_sent records what was sent, so a rerun or an AWS Batch retry
// never sends the same move twice. A failed send records nothing, so it is
// retried on the next run. While the SES account is in the sandbox, an
// address that has not been verified yet is rejected by SES and retried later.
//
// Environment: ALERTS_SENDER (verified SES identity), optional
// SES_CONFIGURATION_SET and APP_URL (links in the email).

const { parseArgs } = require('node:util');
const { connect, transaction } = require('../db/connection');
const { emailContent, sesRequest, unsubscribeUrl } = require('../alerts');

const PROVIDER = 'yahoo';
// Ignore bars older than this (weekend + a holiday): no alert on stale data.
const MAX_BAR_AGE_DAYS = 4;

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const isoDate = (d) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

// Latest bar of each held symbol and the one before it (adjusted closes, so
// dividends and splits don't look like moves), for subscribers' holdings only.
const FIND_ALERTS_SQL = `
WITH held AS (
    SELECT DISTINCT h.symbol
      FROM portfolio_holdings h JOIN notification_subscriptions n ON n.username = h.username
),
bars AS (
    SELECT b.symbol, b.date, b.adj_close,
           lag(b.date)      OVER w AS prev_date,
           lag(b.adj_close) OVER w AS prev_close,
           row_number()     OVER (PARTITION BY b.symbol ORDER BY b.date DESC) AS rn
      FROM price_bars b
      JOIN held ON held.symbol = b.symbol
     WHERE b.provider = $1
       AND b.date > $2::date - 30
    WINDOW w AS (PARTITION BY b.symbol ORDER BY b.date)
)
SELECT n.username, n.email, n.threshold_pct::float8 AS threshold_pct, n.unsubscribe_token::text AS token,
       b.symbol, to_char(b.date, 'YYYY-MM-DD') AS date, b.adj_close::float8 AS close,
       to_char(b.prev_date, 'YYYY-MM-DD') AS prev_date, b.prev_close::float8 AS prev_close
  FROM notification_subscriptions n
  JOIN portfolio_holdings h ON h.username = n.username
  JOIN bars b ON b.symbol = h.symbol AND b.rn = 1
 WHERE b.prev_close > 0
   AND b.date >= $2::date - $3::int
   AND abs(b.adj_close / b.prev_close - 1) * 100 >= n.threshold_pct
   AND NOT EXISTS (
       SELECT 1 FROM price_alerts_sent a
        WHERE a.username = n.username AND a.symbol = b.symbol AND a.bar_date = b.date)
 ORDER BY n.username, abs(b.adj_close / b.prev_close - 1) DESC, b.symbol`;

const changePct = (m) => (m.close / m.prevClose - 1) * 100;

async function findAlerts(db, today) {
  const { rows } = await db.query(FIND_ALERTS_SQL, [PROVIDER, isoDate(today), MAX_BAR_AGE_DAYS]);
  const alerts = new Map();
  for (const r of rows) {
    if (!alerts.has(r.username)) {
      alerts.set(r.username, {
        username: r.username, email: r.email, thresholdPct: r.threshold_pct, token: r.token, moves: [],
      });
    }
    alerts.get(r.username).moves.push({
      symbol: r.symbol, date: r.date, close: r.close, prevDate: r.prev_date, prevClose: r.prev_close,
    });
  }
  return [...alerts.values()];
}

// --- Message ------------------------------------------------------------------

const frNumber = (v, decimals = 2) => new Intl.NumberFormat('fr-CA', {
  minimumFractionDigits: decimals, maximumFractionDigits: decimals,
}).format(v).replace(/[\u00a0\u202f]/g, ' ');
const frPct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${frNumber(Math.abs(v), 1)} %`;
function frDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function compose(alert, appUrl = '') {
  const { moves } = alert;
  const single = moves.length === 1;
  const subject = single
    ? `Alerte de prix : ${moves[0].symbol} ${frPct(changePct(moves[0]))}`
    : `Alerte de prix : ${moves.length} titres ont fortement varié`;
  const intro = single
    ? `Un titre de votre portefeuille a fortement varié lors de la séance du ${frDate(moves[0].date)} :`
    : 'Plusieurs titres de votre portefeuille ont fortement varié lors de la dernière séance :';
  const threshold = frNumber(alert.thresholdPct, Number.isInteger(alert.thresholdPct) ? 0 : 1);
  const table = moves.map((m) => {
    const pct = changePct(m);
    const arrow = pct > 0 ? '▲' : '▼';
    const detail = `${frNumber(m.prevClose)} → ${frNumber(m.close)}, du ${frDate(m.prevDate)} au ${frDate(m.date)}`;
    return {
      cells: [m.symbol, `${arrow} ${frPct(pct)}`, detail],
      color: pct > 0 ? '#006300' : '#d03b3b',
      text: `${arrow} ${m.symbol.padEnd(9)} ${frPct(pct).padStart(9)}   (${detail})`,
    };
  });
  return emailContent({
    subject,
    appUrl,
    unsubscribe: unsubscribeUrl(appUrl, alert.username, alert.token),
    paragraphs: ['Bonjour,', intro],
    table,
    after: [
      `Pourquoi ce courriel : vous êtes averti dès qu’un titre de votre portefeuille varie de ${threshold} % ou plus `
        + 'en une journée. Ce seuil découle de votre niveau de risque dans votre profil investisseur '
        + '(plus le profil est prudent, plus l’alerte arrive tôt).',
      'Source : cours de clôture ajustés (dividendes et fractionnements) de Yahoo Finance, '
        + 'mis à jour par le job quotidien de l’application.',
      'À garder en tête : une variation d’une seule journée ne dit rien de la tendance à long terme, '
        + 'et vendre après une forte baisse fige souvent la perte. Comparez-la plutôt à votre horizon '
        + 'et à vos objectifs avant toute décision.',
    ],
  });
}

// --- Sending ------------------------------------------------------------------

async function sendAlerts(db, ses, alerts, { sender, appUrl = '', configurationSet = '', log = console } = {}) {
  const { SendEmailCommand } = require('@aws-sdk/client-sesv2');
  const report = { usersNotified: 0, movesSent: 0, failedUsers: [] };
  for (const alert of alerts) {
    const content = compose(alert, appUrl);
    try {
      await ses.send(new SendEmailCommand(sesRequest({ sender, to: alert.email, configurationSet, content })));
    } catch (err) { // one failure (e.g. unverified address in the sandbox) must not stop the others
      report.failedUsers.push(alert.username);
      log.warn(`email to ${alert.username} failed: ${err.message}`);
      continue;
    }
    await transaction(db, async (t) => {
      for (const m of alert.moves) {
        await t.query(
          `INSERT INTO price_alerts_sent (username, symbol, bar_date, change_pct)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [alert.username, m.symbol, m.date, Math.round(changePct(m) * 1000) / 1000],
        );
      }
    });
    report.usersNotified += 1;
    report.movesSent += alert.moves.length;
    log.info(`alert sent to ${alert.username}: ${alert.moves.map((m) => `${m.symbol} ${changePct(m).toFixed(1)}%`).join(', ')}`);
  }
  return report;
}

async function run(db, ses, { today = new Date(), sender, appUrl = '', configurationSet = '', dryRun = false, log = console } = {}) {
  const alerts = await findAlerts(db, today);
  log.info(`${alerts.length} user(s) with price moves to report`);
  if (dryRun) {
    for (const a of alerts) {
      const c = compose(a, appUrl);
      log.info(`[dry run] ${a.username}: ${c.subject}\n${c.text}`);
    }
    return { usersNotified: 0, movesSent: 0, failedUsers: [] };
  }
  return sendAlerts(db, ses, alerts, { sender, appUrl, configurationSet, log });
}

const sesClient = (env = process.env) => {
  const { SESv2Client } = require('@aws-sdk/client-sesv2');
  return new SESv2Client({ region: env.AWS_REGION || env.AWS_DEFAULT_REGION });
};

// Called by daily-refresh.js after the refresh. Best effort: never throws.
async function sendPriceAlerts(db, { env = process.env, log = console, ses } = {}) {
  if (!env.ALERTS_SENDER) {
    log.info('ALERTS_SENDER not set: no price alerts');
    return null;
  }
  try {
    const report = await run(db, ses || sesClient(env), {
      sender: env.ALERTS_SENDER, appUrl: env.APP_URL || '', configurationSet: env.SES_CONFIGURATION_SET || '', log,
    });
    log.info(`price alerts: ${report.usersNotified} user(s) notified, ${report.failedUsers.length} failure(s)`);
    return report;
  } catch (err) {
    log.warn(`price alerts failed: ${err.message}`);
    return null;
  }
}

// Subscribers' holdings, so daily-refresh.js keeps their prices fresh even
// when they are not in tracked_symbols (custom portfolios).
async function subscribedSymbols(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT h.symbol FROM portfolio_holdings h
       JOIN notification_subscriptions n ON n.username = h.username ORDER BY h.symbol`);
  return rows.map((r) => r.symbol);
}

async function main(argv = process.argv.slice(2), { env = process.env, log = console } = {}) {
  const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' }, today: { type: 'string' } } });
  const dryRun = Boolean(values['dry-run']);
  if (!env.ALERTS_SENDER && !dryRun) {
    log.error('ALERTS_SENDER is not set');
    return 1;
  }
  const db = await connect(env, { applicationName: 'marketdata-price-alerts' });
  try {
    const report = await run(db, dryRun ? null : sesClient(env), {
      today: values.today || new Date(), sender: env.ALERTS_SENDER, appUrl: env.APP_URL || '',
      configurationSet: env.SES_CONFIGURATION_SET || '', dryRun, log,
    });
    log.info(`alerts: ${report.usersNotified} user(s), ${report.movesSent} move(s), ${report.failedUsers.length} failure(s)`);
    return report.failedUsers.length && !report.usersNotified ? 1 : 0;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
}

module.exports = {
  findAlerts, compose, sendAlerts, run, sendPriceAlerts, subscribedSymbols, main, MAX_BAR_AGE_DAYS,
};
