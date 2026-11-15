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

const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);
const lastClose = (portfolio) => portfolio.history?.at(-1)?.date || portfolio.asOf;

// Date (ISO) each stock's move is measured from: `days` calendar days before
// the last close. Null for a daily report (the day change is already known).
function periodFrom(portfolio, period) {
  const { days } = PERIODS[period];
  const end = lastClose(portfolio);
  return days > 1 && end ? addDays(end, -days) : null;
}

// Everything the report says, computed once. `changes` is { symbol -> { from,
// to, change } | null } from stocks.changeSince (period reports only).
function analyze({ period, portfolio, changes = {} }) {
  const p = PERIODS[period];
  const daily = p.days <= 1;
  const s = portfolio.summary;
  const history = portfolio.history || [];
  const end = history.at(-1) || null;
  const start = periodStart(history, p.days);
  const result = { p, daily, end, start, periodReturn: null, high: null, low: null, fromHigh: null };
  if (start && end && start.value) {
    result.periodReturn = end.value / start.value - 1;
    if (!daily) {
      const window = history.filter((h) => h.date >= start.date);
      const high = window.reduce((a, b) => (b.value > a.value ? b : a));
      const low = window.reduce((a, b) => (b.value < a.value ? b : a));
      result.high = { date: high.date, change: high.value / start.value - 1 };
      result.low = { date: low.date, change: low.value / start.value - 1 };
      result.fromHigh = end.value / high.value - 1;
    }
  } else if (daily) {
    result.periodReturn = s.dayChangePct;
  }

  const ex = exposures(portfolio);
  const invested = s.investedValue || 0;
  const countryOf = new Map(ex.located.map(({ h, country }) => [h.symbol, countryLabel(country)[0]]));
  result.positions = portfolio.holdings.map((h) => {
    const weight = h.available && invested ? h.marketValue / invested : 0;
    const move = !h.available ? null : daily ? h.dayChangePct : changes[h.symbol]?.change ?? null;
    return { h, weight, country: countryOf.get(h.symbol) || 'Inconnu', move, contribution: move == null ? null : weight * move };
  });
  result.movers = result.positions.filter((x) => x.move != null).sort((a, b) => b.move - a.move);
  result.exposures = ex;
  result.cashShare = s.totalValue ? s.cash / s.totalValue : 0;
  return result;
}

// Key figures shown above the report (tiles), percentages and dates only.
function highlights(a) {
  const tone = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
  const tiles = [];
  if (a.periodReturn != null) {
    tiles.push({
      label: a.daily ? 'Dernière séance' : `Rendement ${a.p.label}`,
      value: pct(a.periodReturn),
      tone: tone(a.periodReturn),
      detail: a.daily ? (a.end ? formatDate(a.end.date) : '') : `du ${formatDate(a.start.date)} au ${formatDate(a.end.date)}`,
    });
  }
  const best = a.movers[0];
  const worst = a.movers.at(-1);
  if (best) tiles.push({ label: 'Meilleur titre', value: pct(best.move), tone: tone(best.move), detail: best.h.symbol });
  if (worst && worst !== best) tiles.push({ label: 'Plus faible', value: pct(worst.move), tone: tone(worst.move), detail: worst.h.symbol });
  const region = a.exposures.regions[0];
  if (region) tiles.push({ label: 'Région principale', value: share(region[1]), tone: 'flat', detail: region[0] });
  return tiles;
}

function buildBrief({ period, portfolio, profile, changes = {}, now = Date.now() }) {
  const a = analyze({ period, portfolio, changes });
  const { p, daily, end, start } = a;
  const s = portfolio.summary;
  const lines = [
    `Période : rapport ${p.label}${end ? `, données à la dernière clôture du ${formatDate(end.date)} (marchés fermés les fins de semaine et jours fériés)` : ''}.`,
    'Fiche en pourcentages et en dates uniquement : aucun montant.',
    daily
      ? 'Rapport quotidien : il porte sur la dernière séance.'
      : `Rapport ${p.label} : il porte sur toute la période. La fiche ne contient volontairement pas la variation de la dernière séance.`,
    '',
    `## PERFORMANCE DU PORTEFEUILLE (historique simulé)`,
  ];

  if (a.periodReturn != null && start && end) {
    lines.push(`- ${daily ? 'Dernière séance' : 'Sur la période'}, du ${formatDate(start.date)} au ${formatDate(end.date)} : ${pct(a.periodReturn)}.`);
  } else if (a.periodReturn != null) {
    lines.push(`- Dernière séance : ${pct(a.periodReturn)}.`);
  } else {
    lines.push('- Historique indisponible pour la période.');
  }
  if (a.high) {
    lines.push(`- Plus haut de la période le ${formatDate(a.high.date)} : ${pct(a.high.change)} depuis le début de la période.`);
    lines.push(`- Plus bas de la période le ${formatDate(a.low.date)} : ${pct(a.low.change)} depuis le début de la période.`);
    lines.push(`- Écart entre la fin de la période et le plus haut : ${pct(a.fromHigh)}.`);
  }
  lines.push(`- Gain ou perte non réalisé depuis l'achat (titres) : ${pct(s.gainPct)}.`);
  lines.push(`- Liquidités : ${share(a.cashShare)} du portefeuille.`);

  const moveLabel = daily ? 'variation de la dernière séance' : 'variation du cours sur la période';
  lines.push('', `## POSITIONS (${portfolio.holdings.length} titres ; symbole ; nom ; secteur ; pays de l'émetteur ; devise ; poids dans les titres ; ${moveLabel} ; gain/perte depuis l'achat)`);
  if (!daily) lines.push('- Variation du cours en devise de cotation, hors effet de change, entre la dernière clôture avant le début de la période et la dernière clôture.');
  if (!portfolio.holdings.length) lines.push('- Aucun titre.');
  for (const x of a.positions) {
    const { h } = x;
    if (!h.available) {
      lines.push(`- ${h.symbol} ; cours indisponible`);
      continue;
    }
    lines.push(`- ${h.symbol} ; ${h.name} ; ${h.sector || 'secteur inconnu'} ; ${x.country} ; ${h.currency || 'devise inconnue'} ; `
      + `${share(x.weight)} ; ${x.move == null ? 'variation indisponible' : pct(x.move)} ; ${pct(h.gainPct)}`);
  }

  if (a.movers.length) {
    lines.push('', `## CONTRIBUTIONS (${daily ? 'dernière séance' : 'période'} ; poids actuel × variation, en points de pourcentage des titres, approximatif)`);
    for (const x of [...a.movers].sort((m, n) => n.contribution - m.contribution)) {
      lines.push(`- ${x.h.symbol} : ${pct(x.contribution)}`);
    }
  }

  const ex = a.exposures;
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

module.exports = { PERIODS, buildBrief, analyze, highlights, periodFrom, periodStart, exposures, issuerCountry };
