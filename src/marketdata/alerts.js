'use strict';
// Shared by the web app (app/notifications.js) and the daily job
// (jobs/price-alerts.js): alert thresholds and the email format.

// Daily move (%) that triggers an alert, by risk level of the investor profile:
// a cautious profile is warned earlier. Prototype assumptions.
const THRESHOLDS = { faible: 2, 'faible-modere': 3, modere: 4, 'modere-eleve': 5, eleve: 7 };
const DEFAULT_THRESHOLD = 4; // no profile

const thresholdFor = (profileResult) => THRESHOLDS[profileResult?.level?.id] ?? DEFAULT_THRESHOLD;

const FOOTER = 'Simulation éducative (prototype du Datathon 2026) : ce message n’est pas un conseil financier personnalisé.';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const unsubscribeUrl = (appUrl, username, token) => `${appUrl}/desabonnement?u=${encodeURIComponent(username)}&t=${token}`;

// Text + HTML email. paragraphs, after: strings shown before and after the table;
// table: optional [{ text, cells: [..], color }] rows (text for the plain-text
// part, cells for HTML); appUrl: optional link to the app; unsubscribe: URL
// (unsubscribeUrl()), in the footer and the List-Unsubscribe header.
function emailContent({ subject, paragraphs, table = null, after = [], appUrl, unsubscribe }) {
  const text = [
    ...paragraphs.flatMap((p) => [p, '']),
    ...(table ? [...table.map((r) => `  ${r.text}`), ''] : []),
    ...after.flatMap((p) => [p, '']),
    appUrl ? `Voir votre portefeuille et demander une explication à l’assistant : ${appUrl}` : null,
    '',
    '—',
    FOOTER,
    `Ne plus recevoir ces alertes : ${unsubscribe}`,
  ].filter((l) => l !== null).join('\n');

  const p = (t) => `<p>${escapeHtml(t)}</p>`;
  const rows = table ? `<table>${table.map((r) => `<tr>${r.cells.map((c, i) => `<td style="padding:4px 12px 4px 0;${
    i === 0 ? 'font-weight:600' : ''}${i === 1 ? `font-weight:600;color:${r.color}` : ''}${i === 2 ? 'color:#52514e' : ''}">${
    escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</table>` : '';
  const html = '<!doctype html><html lang="fr"><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;'
    + 'color:#0b0b0b;line-height:1.5;max-width:600px">'
    + paragraphs.map(p).join('') + rows + after.map(p).join('')
    + (appUrl ? `<p><a href="${escapeHtml(appUrl)}">Voir votre portefeuille et demander une explication à l’assistant</a></p>` : '')
    + '<hr style="border:0;border-top:1px solid #e1e0d9">'
    + `<p style="font-size:12px;color:#52514e">${escapeHtml(FOOTER)}<br>`
    + `<a href="${escapeHtml(unsubscribe)}" style="color:#52514e">Ne plus recevoir ces alertes</a></p></body></html>`;
  return { subject, text, html, unsubscribe };
}

// SES v2 SendEmail request for an emailContent() result.
function sesRequest({ sender, to, configurationSet, content }) {
  return {
    FromEmailAddress: sender,
    Destination: { ToAddresses: [to] },
    ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
    Content: {
      Simple: {
        Subject: { Data: content.subject, Charset: 'UTF-8' },
        Body: { Text: { Data: content.text, Charset: 'UTF-8' }, Html: { Data: content.html, Charset: 'UTF-8' } },
        Headers: [{ Name: 'List-Unsubscribe', Value: `<${content.unsubscribe}>` }],
      },
    },
  };
}

module.exports = {
  THRESHOLDS, DEFAULT_THRESHOLD, thresholdFor, escapeHtml, unsubscribeUrl, emailContent, sesRequest,
};
