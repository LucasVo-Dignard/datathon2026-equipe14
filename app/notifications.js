'use strict';
// ---------------------------------------------------------------------------
// Alertes de prix par courriel (Amazon SNS).
//
// Un seul topic SNS par environnement (infra/sns.tf). Chaque abonnement
// courriel porte un filtre { username: [<utilisateur>] } : un message publié
// avec l'attribut username n'arrive qu'à cette personne.
//
//   - l'app abonne / désabonne et envoie le courriel de test (ce fichier) ;
//   - le job quotidien (src/marketdata/jobs/price_alerts.py) envoie les vraies
//     alertes, à partir de la table notification_subscriptions (V5).
//
// Nécessite Postgres (DATABASE_URL) et NOTIFICATIONS_TOPIC_ARN ; sinon la
// fonctionnalité est simplement désactivée (enabled = false).
// ---------------------------------------------------------------------------

const {
  SNSClient, SubscribeCommand, UnsubscribeCommand, PublishCommand, GetSubscriptionAttributesCommand,
} = require('@aws-sdk/client-sns');

// Seuil de variation journalière (%) selon le niveau de risque du profil :
// un profil prudent est averti plus tôt. Hypothèses du prototype.
const THRESHOLDS = { faible: 2, 'faible-modere': 3, modere: 4, 'modere-eleve': 5, eleve: 7 };
const DEFAULT_THRESHOLD = 4; // sans profil
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_EMAIL = 254;

class NotificationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const thresholdFor = (profileResult) => THRESHOLDS[profileResult?.level?.id] ?? DEFAULT_THRESHOLD;

// SNS exige un objet ASCII de moins de 100 caractères (sans accents).
function asciiSubject(text) {
  return text
    .replace(/[\u2212\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u00ab\u00bb\u201c\u201d]/g, '"')
    .replace(/[\u00a0\u202f]/g, ' ')
    .normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7E]/g, '').slice(0, 99);
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
  pool, sns, topicArn, appUrl = '',
} = {}) {
  const enabled = Boolean(pool && sns && topicArn);

  function requireEnabled() {
    if (!enabled) {
      throw new NotificationError(503, 'Alertes indisponibles dans cet environnement (base de données ou SNS non configurés)');
    }
  }

  async function row(username) {
    const { rows } = await pool.query(
      'SELECT email, subscription_arn, threshold_pct, symbols FROM notification_subscriptions WHERE username = $1',
      [username],
    );
    return rows[0] || null;
  }

  // 'pending' (lien de confirmation pas encore cliqué), 'confirmed', ou null si
  // l'abonnement n'existe plus (désabonné par le lien du courriel, ou demande
  // non confirmée expirée après 3 jours).
  async function snsStatus(subscriptionArn) {
    try {
      const { Attributes: a = {} } = await sns.send(new GetSubscriptionAttributesCommand({ SubscriptionArn: subscriptionArn }));
      return a.PendingConfirmation === 'true' ? 'pending' : 'confirmed';
    } catch (err) {
      if (['NotFoundException', 'NotFound', 'InvalidParameterException', 'InvalidParameter'].includes(errName(err))) return null;
      throw err;
    }
  }

  async function forget(username) {
    await pool.query('DELETE FROM notification_subscriptions WHERE username = $1', [username]);
  }

  // profile : pour afficher le seuil qui s'appliquerait avant l'abonnement.
  async function get(username, { profile } = {}) {
    const none = { enabled, status: 'none', thresholdPct: thresholdFor(profile) };
    if (!enabled) return none;
    const r = await row(username);
    if (!r) return none;
    const status = await snsStatus(r.subscription_arn);
    if (!status) {
      await forget(username);
      return none;
    }
    return {
      enabled: true, status, email: r.email, thresholdPct: Number(r.threshold_pct), symbols: r.symbols,
    };
  }

  async function subscribe(username, rawEmail, { profile, symbols }) {
    requireEnabled();
    const email = normalizeEmail(rawEmail);
    const threshold = thresholdFor(profile);
    const tickers = [...new Set(symbols)].filter(Boolean);
    const current = await row(username);

    let subscriptionArn = current?.subscription_arn;
    if (!current || current.email !== email || !(await snsStatus(current.subscription_arn))) {
      if (current) await sns.send(new UnsubscribeCommand({ SubscriptionArn: current.subscription_arn })).catch(() => {});
      try {
        ({ SubscriptionArn: subscriptionArn } = await sns.send(new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: 'email',
          Endpoint: email,
          ReturnSubscriptionArn: true,
          Attributes: {
            FilterPolicyScope: 'MessageAttributes',
            FilterPolicy: JSON.stringify({ username: [username] }),
          },
        })));
      } catch (err) {
        // Même courriel déjà abonné avec le filtre d'un autre utilisateur.
        if (/already exists with different attributes/i.test(err?.message || '')) {
          throw new NotificationError(409, 'Ce courriel est déjà utilisé pour les alertes d’un autre utilisateur');
        }
        throw err;
      }
    }

    await pool.query(
      `INSERT INTO notification_subscriptions (username, email, subscription_arn, threshold_pct, symbols)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO UPDATE
         SET email = EXCLUDED.email, subscription_arn = EXCLUDED.subscription_arn,
             threshold_pct = EXCLUDED.threshold_pct, symbols = EXCLUDED.symbols, updated_at = now()`,
      [username, email, subscriptionArn, threshold, tickers],
    );
    // Le job quotidien ne met à jour que les titres suivis : on y ajoute ceux du portefeuille.
    if (tickers.length) {
      await pool.query(
        'INSERT INTO tracked_symbols (symbol) SELECT unnest($1::text[]) ON CONFLICT (symbol) DO NOTHING',
        [tickers],
      );
    }
    return get(username, { profile });
  }

  async function unsubscribe(username) {
    requireEnabled();
    const r = await row(username);
    if (!r) return get(username);
    // Une demande pas encore confirmée ne peut pas être annulée par l'API :
    // elle expire seule après 3 jours, et le job ne lui écrit plus.
    await sns.send(new UnsubscribeCommand({ SubscriptionArn: r.subscription_arn })).catch(() => {});
    await forget(username);
    return get(username);
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
    const state = await get(username);
    if (state.status === 'none') throw new NotificationError(409, 'Abonnez-vous d’abord aux alertes');
    if (state.status === 'pending') {
      throw new NotificationError(409, 'Confirmez d’abord votre abonnement avec le lien reçu par courriel');
    }
    const level = profile?.level?.label;
    const message = [
      'Bonjour,',
      '',
      'Ceci est une notification de test : vos alertes de prix fonctionnent.',
      '',
      `Vous serez averti par courriel quand un titre de votre portefeuille varie de ${state.thresholdPct} % ou plus `
        + 'en une journée de bourse, après la mise à jour quotidienne des données (en semaine, en soirée).',
      level ? `Ce seuil découle de votre profil investisseur (niveau de risque : ${level}).` : 'Seuil par défaut (profil investisseur non rempli).',
      '',
      `Titres suivis : ${state.symbols.join(', ') || 'aucun'}.`,
      appUrl ? `\nVoir votre portefeuille : ${appUrl}` : '',
      '',
      '—',
      'Simulation éducative (prototype du Datathon 2026) : ceci n’est pas un conseil financier personnalisé.',
    ].join('\n');

    const { MessageId } = await sns.send(new PublishCommand({
      TopicArn: topicArn,
      Subject: asciiSubject('Test - vos alertes de prix sont actives'),
      Message: message,
      MessageAttributes: { username: { DataType: 'String', StringValue: username } },
    }));
    return { sent: true, messageId: MessageId, email: state.email };
  }

  return {
    enabled, get, subscribe, unsubscribe, sendTest, updateThreshold,
  };
}

// Configuration depuis l'environnement du conteneur (voir infra/user_data.sh.tftpl).
function createNotificationsFromEnv({ pool, env = process.env } = {}) {
  const topicArn = env.NOTIFICATIONS_TOPIC_ARN;
  if (!pool || !topicArn) return createNotifications({});
  const region = topicArn.split(':')[3] || env.AWS_REGION;
  return createNotifications({
    pool, sns: new SNSClient({ region }), topicArn, appUrl: env.APP_URL || '',
  });
}

module.exports = {
  createNotifications, createNotificationsFromEnv, thresholdFor, asciiSubject, normalizeEmail,
  NotificationError, THRESHOLDS,
};
