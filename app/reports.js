'use strict';
// ---------------------------------------------------------------------------
// Rapports simulés (quotidien, hebdomadaire, mensuel, annuel).
//
// buildBrief() prépare la fiche de données du rapport à partir du portefeuille
// (voir portfolio.js) et du profil investisseur ; bot.report() la rédige en
// Markdown. La fiche ne contient que des pourcentages et des dates, jamais de
// montants, de cours ni de quantités : le rapport ne peut donc pas en citer.
// L'historique de performance et les actualités du portefeuille sont encore
// fictifs (prototype) : le rapport l'est donc aussi.
// ---------------------------------------------------------------------------

const { profileSummary } = require('./profile');

const PERIODS = {
  daily: { label: 'quotidien', title: 'Rapport quotidien', days: 1 },
  weekly: { label: 'hebdomadaire', title: 'Rapport hebdomadaire', days: 7 },
  monthly: { label: 'mensuel', title: 'Rapport mensuel', days: 30 },
  yearly: { label: 'annuel', title: 'Rapport annuel', days: 365 },
};

// Issuer country as published by Yahoo (English) -> French name and region.
const COUNTRIES = {
  Canada: ['Canada', 'Amérique du Nord'],
  'United States': ['États-Unis', 'Amérique du Nord'],
  Mexico: ['Mexique', 'Amérique latine'],
  Brazil: ['Brésil', 'Amérique latine'],
  'United Kingdom': ['Royaume-Uni', 'Europe'],
  Ireland: ['Irlande', 'Europe'],
  France: ['France', 'Europe'],
  Germany: ['Allemagne', 'Europe'],
  Netherlands: ['Pays-Bas', 'Europe'],
  Switzerland: ['Suisse', 'Europe'],
  Denmark: ['Danemark', 'Europe'],
  Sweden: ['Suède', 'Europe'],
  Spain: ['Espagne', 'Europe'],
  Italy: ['Italie', 'Europe'],
  Belgium: ['Belgique', 'Europe'],
  Luxembourg: ['Luxembourg', 'Europe'],
  Japan: ['Japon', 'Asie-Pacifique'],
  China: ['Chine', 'Asie-Pacifique'],
  'Hong Kong': ['Hong Kong', 'Asie-Pacifique'],
  Taiwan: ['Taïwan', 'Asie-Pacifique'],
  'South Korea': ['Corée du Sud', 'Asie-Pacifique'],
  India: ['Inde', 'Asie-Pacifique'],
  Singapore: ['Singapour', 'Asie-Pacifique'],
  Australia: ['Australie', 'Asie-Pacifique'],
  Israel: ['Israël', 'Moyen-Orient'],
  Bermuda: ['Bermudes', 'Autres'],
};

// When the issuer's country is unknown, guess it from the listing: symbol
// suffix (Yahoo), else a plain US-dollar symbol is taken as a US listing.
const SUFFIX_COUNTRY = {
  TO: 'Canada', V: 'Canada', NE: 'Canada', CN: 'Canada', L: 'United Kingdom', PA: 'France',
  DE: 'Germany', F: 'Germany', AS: 'Netherlands', SW: 'Switzerland', MI: 'Italy', MC: 'Spain',
  T: 'Japan', HK: 'Hong Kong', SS: 'China', SZ: 'China', TW: 'Taiwan', KS: 'South Korea',
  NS: 'India', BO: 'India', AX: 'Australia', SA: 'Brazil', MX: 'Mexico',
};

function issuerCountry(h) {
  if (h.country) return { country: h.country, inferred: false };
  const suffix = h.symbol.includes('.') ? h.symbol.split('.').pop().toUpperCase() : null;
  if (suffix && SUFFIX_COUNTRY[suffix]) return { country: SUFFIX_COUNTRY[suffix], inferred: true };
  if (!suffix && h.currency === 'USD') return { country: 'United States', inferred: true };
  return { country: null, inferred: true };
}

function countryLabel(country) {
  if (!country) return ['Inconnu', 'Inconnue'];
  return COUNTRIES[country] || [country, 'Autres'];
}

const DATE = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long', timeZone: 'UTC' });
const formatDate = (iso) => DATE.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
const pct = (x) => {
  const v = Math.round(x * 1e4) / 100 || 0; // no "-0,00 %"
  return `${v > 0 ? '+' : ''}${v.toFixed(2).replace('.', ',')} %`;
};
const share = (x) => `${(x * 100).toFixed(1).replace('.', ',')} %`;

// Portfolio value at the start of the period: the last close on or before
// `days` days before the last close (or the previous close, for a daily report).
function periodStart(history, days) {
  if (history.length < 2) return null;
  if (days <= 1) return history[history.length - 2];
  const from = new Date(`${history[history.length - 1].date}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - days);
  const cutoff = from.toISOString().slice(0, 10);
  let start = history[0];
  for (const point of history) {
    if (point.date > cutoff) break;
    start = point;
  }
  return start;
}

// { key -> share } sorted by share, from [{ key, value }].
function breakdown(items, total) {
  const sums = new Map();
  for (const { key, value } of items) sums.set(key, (sums.get(key) || 0) + value);
  return [...sums].map(([key, value]) => [key, total ? value / total : 0]).sort((a, b) => b[1] - a[1]);
}

// Exposures, as shares of the invested part (stocks only) except currencies,
// which include cash (held in CAD).
function exposures(portfolio) {
  const held = portfolio.holdings.filter((h) => h.available && h.marketValue > 0);
  const invested = held.reduce((s, h) => s + h.marketValue, 0);
  const located = held.map((h) => ({ h, ...issuerCountry(h) }));
  const total = invested + (portfolio.summary.cash || 0);
  return {
    sectors: breakdown(held.map((h) => ({ key: h.sector || 'Inconnu', value: h.marketValue })), invested),
    countries: breakdown(located.map(({ h, country }) => ({ key: countryLabel(country)[0], value: h.marketValue })), invested),
    regions: breakdown(located.map(({ h, country }) => ({ key: countryLabel(country)[1], value: h.marketValue })), invested),
    currencies: breakdown([
      ...held.map((h) => ({ key: h.currency || 'Inconnue', value: h.marketValue })),
      ...(portfolio.summary.cash > 0 ? [{ key: 'CAD', value: portfolio.summary.cash }] : []),
    ], total),
    inferred: located.filter((l) => l.inferred && l.country).map((l) => l.h.symbol),
    located,
  };
}

function buildBrief({ period, portfolio, profile, now = Date.now() }) {
  const p = PERIODS[period];
  const s = portfolio.summary;
  const history = portfolio.history || [];
  const end = history[history.length - 1];
  const lines = [
    `Période : rapport ${p.label}${end ? `, données à la dernière clôture du ${formatDate(end.date)} (marchés fermés les fins de semaine et jours fériés)` : ''}.`,
    'Fiche en pourcentages et en dates uniquement : aucun montant.',
    '',
    '## PERFORMANCE (historique simulé)',
  ];

  const start = periodStart(history, p.days);
  if (start && end && start.value) {
    lines.push(`- Sur la période, du ${formatDate(start.date)} au ${formatDate(end.date)} : ${pct(end.value / start.value - 1)}.`);
    if (p.days > 1) {
      const window = history.filter((h) => h.date >= start.date);
      const high = window.reduce((a, b) => (b.value > a.value ? b : a));
      const low = window.reduce((a, b) => (b.value < a.value ? b : a));
      lines.push(`- Plus haut le ${formatDate(high.date)} (${pct(high.value / start.value - 1)} depuis le début de la période), plus bas le ${formatDate(low.date)} (${pct(low.value / start.value - 1)}).`);
      lines.push(`- Écart entre la dernière clôture et le plus haut de la période : ${pct(end.value / high.value - 1)}.`);
    }
  } else {
    lines.push('- Historique indisponible pour la période.');
  }
  lines.push(`- Dernière séance : ${pct(s.dayChangePct)}.`);
  lines.push(`- Gain ou perte non réalisé depuis l'achat (titres) : ${pct(s.gainPct)}.`);
  lines.push(`- Liquidités : ${s.totalValue ? share(s.cash / s.totalValue) : share(0)} du portefeuille.`);

  const ex = exposures(portfolio);
  const countryOf = new Map(ex.located.map(({ h, country }) => [h.symbol, countryLabel(country)[0]]));
  const invested = s.investedValue || 0;
  lines.push('', `## POSITIONS (${portfolio.holdings.length} titres ; symbole ; nom ; secteur ; pays de l'émetteur ; devise ; poids dans les titres ; gain/perte depuis l'achat ; dernière séance)`);
  if (!portfolio.holdings.length) lines.push('- Aucun titre.');
  for (const h of portfolio.holdings) {
    if (!h.available) {
      lines.push(`- ${h.symbol} ; cours indisponible`);
      continue;
    }
    lines.push(`- ${h.symbol} ; ${h.name} ; ${h.sector || 'secteur inconnu'} ; ${countryOf.get(h.symbol)} ; ${h.currency || 'devise inconnue'} ; `
      + `${share(invested ? h.marketValue / invested : 0)} ; ${pct(h.gainPct)} ; ${pct(h.dayChangePct)}`);
  }

  const table = (title, rows) => {
    if (!rows.length) return;
    lines.push('', `## ${title}`);
    for (const [key, w] of rows) lines.push(`- ${key} : ${share(w)}`);
  };
  table('EXPOSITION PAR RÉGION (part des titres, selon le pays de l\'émetteur)', ex.regions);
  table('EXPOSITION PAR PAYS (part des titres)', ex.countries);
  table('EXPOSITION PAR DEVISE (part du portefeuille, liquidités en CAD comprises)', ex.currencies);
  if (ex.inferred.length) {
    lines.push(`- Pays déduit de la place de cotation, faute de donnée sur l'émetteur : ${ex.inferred.join(', ')}.`);
  }
  table('EXPOSITION PAR SECTEUR (part des titres)', ex.sectors);

  const cutoff = now - Math.max(p.days, 1) * 24 * 3600e3;
  const symbols = new Set(portfolio.holdings.map((h) => h.symbol.split('.')[0]));
  const ownSectors = new Set(ex.sectors.map(([sector]) => sector));
  const news = (portfolio.news || []).filter((n) => Date.parse(n.publishedAt) >= cutoff
    && (n.symbols.some((sym) => symbols.has(sym)) || ownSectors.has(n.sector)));
  lines.push('', '## ACTUALITÉS DE LA PÉRIODE (fictives, prototype)');
  if (!news.length) lines.push('- Aucune actualité liée au portefeuille sur la période.');
  for (const n of news) lines.push(`- ${formatDate(n.publishedAt)} ; ${n.source} ; ${n.title} : ${n.summary}`);

  lines.push('', '## PROFIL INVESTISSEUR', profileSummary(profile));
  return lines.join('\n');
}

module.exports = { PERIODS, buildBrief, periodStart, exposures, issuerCountry };
