'use strict';
// ---------------------------------------------------------------------------
// Rapports simulés (quotidien, hebdomadaire, mensuel, annuel).
//
// buildBrief() met en forme, en texte, les chiffres du portefeuille sur la
// période (voir portfolio.js) et le profil investisseur ; bot.report() en
// fait un rapport rédigé. L'historique de performance et les actualités du
// portefeuille sont encore fictifs (prototype) : le rapport l'est donc aussi.
// ---------------------------------------------------------------------------

const { profileSummary } = require('./profile');

const PERIODS = {
  daily: { label: 'quotidien', title: 'Rapport quotidien', days: 1 },
  weekly: { label: 'hebdomadaire', title: 'Rapport hebdomadaire', days: 7 },
  monthly: { label: 'mensuel', title: 'Rapport mensuel', days: 30 },
  yearly: { label: 'annuel', title: 'Rapport annuel', days: 365 },
};

const money = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' });
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2).replace('.', ',')} %`;
const share = (x) => `${(x * 100).toFixed(1).replace('.', ',')} %`;

// Portfolio value at the start of the period: the last close on or before
// `days` days ago (or the previous close, for a daily report).
function periodStart(history, days, asOf) {
  if (history.length < 2) return null;
  if (days <= 1) return history[history.length - 2];
  const from = new Date(`${asOf}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - days);
  const cutoff = from.toISOString().slice(0, 10);
  let start = history[0];
  for (const point of history) {
    if (point.date > cutoff) break;
    start = point;
  }
  return start;
}

function buildBrief({ period, portfolio, profile, now = Date.now() }) {
  const p = PERIODS[period];
  const asOf = portfolio.asOf || new Date(now).toISOString().slice(0, 10);
  const s = portfolio.summary;
  const end = portfolio.history?.[portfolio.history.length - 1];
  const lines = [
    `Période : rapport ${p.label}${end ? `, données à la dernière clôture du ${end.date} (marchés fermés les fins de semaine et jours fériés)` : ''}. Montants en dollars canadiens.`,
    '',
  ];

  lines.push('PORTEFEUILLE');
  lines.push(`Valeur totale : ${money.format(s.totalValue)} (titres ${money.format(s.investedValue)}, liquidités ${money.format(s.cash)}${s.totalValue ? `, soit ${share(s.cash / s.totalValue)}` : ''}).`);
  lines.push(`Gain/perte non réalisé depuis l'achat : ${money.format(s.gain)} (${pct(s.gainPct)}).`);
  lines.push(`Variation du dernier jour : ${money.format(s.dayChange)} (${pct(s.dayChangePct)}).`);

  const start = periodStart(portfolio.history || [], p.days, asOf);
  if (start && end && start.value) {
    const change = end.value - start.value;
    lines.push(`Performance sur la période (historique simulé) : ${money.format(change)} (${pct(change / start.value)}), de ${money.format(start.value)} le ${start.date} à ${money.format(end.value)} le ${end.date}.`);
    if (p.days > 1) {
      const window = portfolio.history.filter((h) => h.date >= start.date);
      const high = window.reduce((a, b) => (b.value > a.value ? b : a));
      const low = window.reduce((a, b) => (b.value < a.value ? b : a));
      lines.push(`Plus haut : ${money.format(high.value)} le ${high.date}. Plus bas : ${money.format(low.value)} le ${low.date}.`);
    }
  } else {
    lines.push('Performance sur la période : historique indisponible.');
  }

  lines.push('', 'TITRES (symbole ; nom ; secteur ; quantité ; valeur ; poids ; gain/perte depuis l\'achat ; variation du jour)');
  if (!portfolio.holdings.length) lines.push('Aucun titre.');
  for (const h of portfolio.holdings) {
    if (!h.available) {
      lines.push(`- ${h.symbol} ; cours indisponible ; quantité ${h.quantity}`);
      continue;
    }
    lines.push(`- ${h.symbol} ; ${h.name} ; ${h.sector || 'secteur inconnu'} ; ${h.quantity} ; ${money.format(h.marketValue)} ; ${share(h.weight)} ; ${money.format(h.gain)} (${pct(h.gainPct)}) ; ${pct(h.dayChangePct)}`);
  }

  const sectors = new Map();
  for (const h of portfolio.holdings) {
    if (h.available) sectors.set(h.sector || 'Inconnu', (sectors.get(h.sector || 'Inconnu') || 0) + h.weight);
  }
  if (sectors.size) {
    lines.push('', 'RÉPARTITION PAR SECTEUR');
    for (const [sector, w] of [...sectors].sort((a, b) => b[1] - a[1])) lines.push(`- ${sector} : ${share(w)}`);
  }

  const cutoff = now - Math.max(p.days, 1) * 24 * 3600e3;
  const symbols = new Set(portfolio.holdings.map((h) => h.symbol.split('.')[0]));
  const ownSectors = new Set(sectors.keys());
  const news = (portfolio.news || []).filter((n) => Date.parse(n.publishedAt) >= cutoff
    && (n.symbols.some((sym) => symbols.has(sym)) || ownSectors.has(n.sector)));
  lines.push('', 'ACTUALITÉS DE LA PÉRIODE (fictives, prototype)');
  if (!news.length) lines.push('Aucune actualité liée au portefeuille sur la période.');
  for (const n of news) lines.push(`- ${n.publishedAt.slice(0, 10)} ; ${n.source} ; ${n.title} : ${n.summary}`);

  lines.push('', 'PROFIL INVESTISSEUR', profileSummary(profile));
  return lines.join('\n');
}

module.exports = { PERIODS, buildBrief, periodStart };
