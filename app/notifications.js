'use strict';
// ---------------------------------------------------------------------------
// Alertes de prix par courriel (Amazon SES).
//
//   - l'app enregistre l'abonnement, fait vérifier l'adresse si besoin et
//     envoie le courriel de test (ce fichier) ;
//   - le job quotidien (src/marketdata/jobs/price-alerts.js) envoie les vraies
//     alertes : variations des titres du portefeuille (portfolio_holdings, V7)
//     des abonnés (notification_subscriptions, V8).
//
// Bac à sable SES : tant que le compte n'a pas l'accès « production », SES
// n'envoie qu'à des adresses vérifiées. À l'abonnement, on crée donc l'identité
// de l'adresse : SES envoie « Please verify your email address », et l'abonné
// est actif dès qu'il a cliqué. Une fois le compte en production, l'adresse est
// active tout de suite, sans clic.
//
// Chaque courriel contient un lien de désabonnement en un clic, sans connexion
// (GET /desabonnement?u=<username>&t=<token>).
//
// Nécessite Postgres (DATABASE_URL) et ALERTS_SENDER (adresse expéditrice
// vérifiée dans SES) ; sinon la fonctionnalité est désactivée (enabled = false).
// ---------------------------------------------------------------------------

const {
  SESv2Client, SendEmailCommand, GetAccountCommand, CreateEmailIdentityCommand, GetEmailIdentityCommand,
} = require('@aws-sdk/client-sesv2');
// Seuils et format des courriels, partagés avec le job quotidien.
const {
  THRESHOLDS, thresholdFor, escapeHtml, unsubscribeUrl, emailContent, sesRequest,
} = require('../src/marketdata/alerts');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_EMAIL = 254;
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_CACHE_MS = 10 * 60 * 1000;

class NotificationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    throw new NotificationError(400, 'Adresse courriel invalide');
  }
  return email;
}

const errName = (err) => err?.name || err?.Code || '';

function createNotifications({
  pool, ses, sender, configurationSet, appUrl = '', now = Date.now,
} = {}) {
  const enabled = Boolean(pool && ses && sender);
  let account = null; // { production, at }

  function requireEnabled() {
    if (!enabled) {
      throw new NotificationError(503, 'Alertes indisponibles dans cet environnement (base de données ou SES non configurés)');
    }
  }

  // Le compte SES est-il sorti du bac à sable ? (mis en cache 10 min)
  async function production() {
    if (!account || now() - account.at > ACCOUNT_CACHE_MS) {
      const res = await ses.send(new GetAccountCommand({}));
      account = { production: Boolean(res.ProductionAccessEnabled), at: now() };
    }
    return account.production;
  }

  // 'active' si SES peut écrire à cette adresse, sinon 'pending' (vérification
  // pas encore cliquée, ou identité absente).
  async function deliverability(email) {
    if (await production()) return 'active';
    try {
      const res = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: email }));
      return res.VerifiedForSendingStatus ? 'active' : 'pending';
    } catch (err) {
      if (errName(err) === 'NotFoundException') return 'pending';
      throw err;
    }
  }

  // Bac à sable : crée l'identité, ce qui envoie le courriel de vérification
  // d'AWS. Rien à faire en production ou si l'adresse est déjà vérifiée.
  async function requestVerification(email) {
    if (await production()) return;
    try {
      await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: email }));
    } catch (err) {
      if (errName(err) !== 'AlreadyExistsException') throw err;
    }
  }

  // Les titres suivis sont ceux du portefeuille de l'utilisateur (V7).
  async function row(username) {
    const { rows } = await pool.query(
      `SELECT n.email, n.threshold_pct, n.unsubscribe_token,
              coalesce(array_agg(h.symbol ORDER BY h.symbol) FILTER (WHERE h.symbol IS NOT NULL), '{}') AS symbols
         FROM notification_subscriptions n
         LEFT JOIN portfolio_holdings h ON h.username = n.username
        WHERE n.username = $1
        GROUP BY n.email, n.threshold_pct, n.unsubscribe_token`,
      [username],
    );
    return rows[0] || null;
  }

  // profile : pour afficher le seuil qui s'appliquerait avant l'abonnement.
  async function get(username, { profile } = {}) {
    const none = { enabled, status: 'none', thresholdPct: thresholdFor(profile) };
    if (!enabled) return none;
    const r = await row(username);
    if (!r) return none;
    return {
      enabled: true,
      status: await deliverability(r.email),
      email: r.email,
      thresholdPct: Number(r.threshold_pct),
      symbols: r.symbols,
      sandbox: !(await production()),
    };
  }

  async function subscribe(username, rawEmail, { profile } = {}) {
    requireEnabled();
    const email = normalizeEmail(rawEmail);
    const current = await row(username);
    await pool.query(
      `INSERT INTO notification_subscriptions (username, email, threshold_pct)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE
         SET email = EXCLUDED.email, threshold_pct = EXCLUDED.threshold_pct,
             -- nouvelle adresse : nouveau lien de désabonnement
             unsubscribe_token = CASE WHEN notification_subscriptions.email = EXCLUDED.email
                                      THEN notification_subscriptions.unsubscribe_token
                                      ELSE gen_random_uuid() END,
             updated_at = now()`,
      [username, email, thresholdFor(profile)],
    );
    if (!current || current.email !== email || (await deliverability(email)) === 'pending') {
      await requestVerification(email);
    }
    return get(username, { profile });
  }

  // Les identités SES vérifiées ne sont pas supprimées : elles sont partagées
  // entre environnements (même compte AWS). Sans abonnement, rien n'est envoyé.
  async function unsubscribe(username) {
    requireEnabled();
    await pool.query('DELETE FROM notification_subscriptions WHERE username = $1', [username]);
  }

  // Lien du courriel : pas de session, le jeton fait foi.
  async function unsubscribeWithToken(username, token) {
    if (!enabled || typeof username !== 'string' || !TOKEN_RE.test(String(token))) return false;
    const { rowCount } = await pool.query(
      'DELETE FROM notification_subscriptions WHERE username = $1 AND unsubscribe_token = $2',
      [username, token],
    );
    return rowCount > 0;
  }

  // Le seuil suit le niveau de risque : à recalculer quand le profil change.
  async function updateThreshold(username, profile) {
    if (!enabled) return;
    await pool.query(
      'UPDATE notification_subscriptions SET threshold_pct = $2, updated_at = now() WHERE username = $1',
      [username, thresholdFor(profile)],
    );
  }

  async function sendTest(username, { profile }) {
    requireEnabled();
    const r = await row(username);
    if (!r) throw new NotificationError(409, 'Abonnez-vous d’abord aux alertes');
    if ((await deliverability(r.email)) === 'pending') {
      throw new NotificationError(409, 'Vérifiez d’abord votre adresse avec le lien reçu par courriel');
    }
    const threshold = Number(r.threshold_pct);
    const level = profile?.level?.label;
    const unsubscribe = unsubscribeUrl(appUrl, username, r.unsubscribe_token);
    const content = emailContent({
      subject: 'Test : vos alertes de prix sont actives',
      appUrl,
      unsubscribe,
      paragraphs: [
        'Bonjour,',
        'Ceci est une notification de test : vos alertes de prix fonctionnent.',
        `Vous serez averti par courriel quand un titre de votre portefeuille varie de ${threshold} % ou plus `
          + 'en une journée de bourse, après la mise à jour quotidienne des données (en semaine, en soirée).',
        level ? `Ce seuil découle de votre profil investisseur (niveau de risque : ${level}).`
          : 'Seuil par défaut : votre profil investisseur n’est pas rempli.',
        `Titres suivis : ${r.symbols.join(', ') || 'aucun'}.`,
      ],
    });
    const { MessageId } = await ses.send(new SendEmailCommand(
      sesRequest({ sender, to: r.email, configurationSet, content }),
    ));
    return { sent: true, messageId: MessageId, email: r.email };
  }

  return {
    enabled, get, subscribe, unsubscribe, unsubscribeWithToken, sendTest, updateThreshold,
  };
}

// Configuration depuis l'environnement du conteneur (voir infra/user_data.sh.tftpl).
function createNotificationsFromEnv({ pool, env = process.env } = {}) {
  if (!pool || !env.ALERTS_SENDER) return createNotifications({});
  return createNotifications({
    pool,
    ses: new SESv2Client({ region: env.AWS_REGION }),
    sender: env.ALERTS_SENDER,
    configurationSet: env.SES_CONFIGURATION_SET,
    appUrl: env.APP_URL || '',
  });
}

module.exports = {
  createNotifications, createNotificationsFromEnv, thresholdFor, normalizeEmail, emailContent, escapeHtml,
  NotificationError, THRESHOLDS,
};
