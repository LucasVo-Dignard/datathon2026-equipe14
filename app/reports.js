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
  // A fund's listing says nothing about where its holdings are (XEQT.TO is global).
  if (h.fund) return { country: null, inferred: false, fund: true };
  const suffix = h.symbol.includes('.') ? h.symbol.split('.').pop().toUpperCase() : null;
  if (suffix && SUFFIX_COUNTRY[suffix]) return { country: SUFFIX_COUNTRY[suffix], inferred: true };
  if (!suffix && h.currency === 'USD') return { country: 'United States', inferred: true };
  return { country: null, inferred: true };
}

const FUND_REGION = 'FNB (répartition géographique non publiée)';

function countryLabel(country, fund = false) {
  if (fund) return [FUND_REGION, FUND_REGION];
  if (!country) return ['Inconnu', 'Inconnue'];
  return COUNTRIES[country] || [country, 'Autres'];
}

// Yahoo sector names (company profiles and fund weights) in French.
const SECTORS_FR = {
  Technology: 'Technologie',
  'Communication Services': 'Communications',
  'Financial Services': 'Services financiers',
  Healthcare: 'Santé',
  Energy: 'Énergie',
  Industrials: 'Industrie',
  'Consumer Cyclical': 'Consommation discrétionnaire',
  'Consumer Defensive': 'Consommation de base',
  'Basic Materials': 'Matériaux',
  'Real Estate': 'Immobilier',
  Utilities: 'Services publics',
};
const sectorFr = (s) => SECTORS_FR[s] || s;

// Profile sector choices (profile.js, question "sectors") -> Yahoo sectors.
const PROFILE_SECTORS = {
  tech: ['Technology', 'Communication Services'],
  health: ['Healthcare'],
  energy: ['Energy'],
  finance: ['Financial Services'],
  consumer: ['Consumer Cyclical', 'Consumer Defensive'],
  industry: ['Industrials'],
  realEstate: ['Real Estate'],
  gold: ['Basic Materials'],
};
const PROFILE_SECTOR_LABELS = {
  tech: 'Technologies', health: 'Santé', energy: 'Énergie', finance: 'Banques et assurances', consumer: 'Consommation',
  industry: 'Industrie et transport', realEstate: 'Immobilier', gold: 'Or et matières premières',
};
// Excluded activities (question "exclusions"): by sector when there is one,
// else by keywords in the fund's name, category and top holdings (sectors
// can't tell a defense company from another industrial).
const EXCLUDED_ACTIVITIES = {
  fossil: { label: 'combustibles fossiles', sectors: ['Energy'] },
  weapons: {
    label: 'armement',
    keywords: /defen[cs]e|d[ée]fense|aerospace|a[ée]rospatial|armement|lockheed|raytheon|\brtx\b|northrop|general dynamics|bae systems|l3harris|rheinmetall|huntington ingalls/i,
  },
  tobacco: { label: 'tabac', keywords: /tobacco|tabac|philip morris|altria|british american tobacco|imperial brands|japan tobacco/i },
};
// A fund is flagged when an unwanted sector weighs at least this much in it.
const FLAG_MIN_FUND_SHARE = 0.10;
const sumSectors = (weights, sectors) => sectors.reduce((s, name) => s + (weights[name] || 0), 0);

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

// A holding's sector split, as [{ sector, value }] in CAD: a stock is one
// sector; an ETF is looked through with its published weights (equity part),
// the rest being bonds, cash or unclassified.
function sectorParts(h) {
  if (!h.fund) return [{ sector: h.sector ? sectorFr(h.sector) : 'Inconnu', value: h.marketValue }];
  const weights = Object.entries(h.fund.sectorWeights || {});
  if (!weights.length) return [{ sector: 'FNB non détaillé', value: h.marketValue }];
  const equity = h.fund.stockPosition ?? 1;
  const total = weights.reduce((s, [, w]) => s + w, 0) || 1;
  const parts = weights.map(([sector, w]) => ({ sector: sectorFr(sector), value: h.marketValue * equity * (w / total) }));
  const bonds = h.fund.bondPosition || 0;
  const rest = Math.max(0, 1 - equity - bonds);
  if (bonds > 0) parts.push({ sector: 'Obligations (dans les FNB)', value: h.marketValue * bonds });
  if (rest > 0.005) parts.push({ sector: 'Liquidités et autres (dans les FNB)', value: h.marketValue * rest });
  return parts;
}

// Exposures, as shares of the invested part (stocks and ETFs) except
// currencies, which include cash (held in CAD). Sectors look through ETFs.
function exposures(portfolio) {
  const held = portfolio.holdings.filter((h) => h.available && h.marketValue > 0);
  const invested = held.reduce((s, h) => s + h.marketValue, 0);
  const located = held.map((h) => ({ h, ...issuerCountry(h) }));
  const total = invested + (portfolio.summary.cash || 0);
  return {
    sectors: breakdown(held.flatMap(sectorParts).map(({ sector, value }) => ({ key: sector, value })), invested),
    countries: breakdown(located.map(({ h, country, fund }) => ({ key: countryLabel(country, fund)[0], value: h.marketValue })), invested),
    regions: breakdown(located.map(({ h, country, fund }) => ({ key: countryLabel(country, fund)[1], value: h.marketValue })), invested),
    currencies: breakdown([
      ...held.map((h) => ({ key: h.currency || 'Inconnue', value: h.marketValue })),
      ...(portfolio.summary.cash > 0 ? [{ key: 'CAD', value: portfolio.summary.cash }] : []),
    ], total),
    inferred: located.filter((l) => l.inferred && l.country).map((l) => l.h.symbol),
    funds: held.filter((h) => h.fund).map((h) => h.symbol),
    located,
  };
}

// Holdings at odds with the profile: sectors the user wants to avoid
// (question "sectors", second click) and excluded activities. Stocks count
// fully; ETFs when the unwanted part weighs FLAG_MIN_FUND_SHARE or more of
// the fund. Each flag: { symbol, name, fund, reason, fundShare, portfolioShare,
// holdings } with shares of the invested part; largest exposure first.
function preferenceFlags(portfolio, profile) {
  const g = profile?.guardrails;
  if (!g) return [];
  const rules = [
    ...(g.avoidedSectors || []).filter((id) => PROFILE_SECTORS[id]).map((id) => ({
      reason: `secteur à éviter : ${PROFILE_SECTOR_LABELS[id]}`, sectors: PROFILE_SECTORS[id],
    })),
    ...(g.excludedActivities || []).filter((id) => EXCLUDED_ACTIVITIES[id]).map((id) => ({
      reason: `activité exclue : ${EXCLUDED_ACTIVITIES[id].label}`, ...EXCLUDED_ACTIVITIES[id],
    })),
  ];
  const held = portfolio.holdings.filter((h) => h.available && h.marketValue > 0);
  const invested = held.reduce((s, h) => s + h.marketValue, 0);
  const flags = [];
  for (const h of held) {
    const weight = invested ? h.marketValue / invested : 0;
    for (const rule of rules) {
      let fundShare = 0;
      let holdings = [];
      if (rule.sectors) {
        fundShare = h.fund ? sumSectors(h.fund.sectorWeights || {}, rule.sectors) * (h.fund.stockPosition ?? 1)
          : rule.sectors.includes(h.sector) ? 1 : 0;
      }
      if (rule.keywords) {
        if (h.fund) {
          holdings = (h.fund.topHoldings || []).filter((x) => rule.keywords.test(`${x.name} ${x.symbol}`));
          const themed = rule.keywords.test(`${h.name} ${h.fund.category || ''}`);
          fundShare = Math.max(fundShare, themed ? 1 : holdings.reduce((s, x) => s + x.weight, 0));
        } else if (rule.keywords.test(h.name)) {
          fundShare = 1;
        }
      }
      if (h.fund ? fundShare >= FLAG_MIN_FUND_SHARE : fundShare > 0) {
        flags.push({ symbol: h.symbol, name: h.name, fund: Boolean(h.fund), reason: rule.reason,
          fundShare: Math.min(1, fundShare), portfolioShare: weight * Math.min(1, fundShare), holdings });
      }
    }
  }
  return flags.sort((a, b) => b.portfolioShare - a.portfolioShare);
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
function analyze({ period, portfolio, changes = {}, profile = null }) {
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
  const countryOf = new Map(ex.located.map(({ h, country, fund }) => [h.symbol, countryLabel(country, fund)[0]]));
  result.positions = portfolio.holdings.map((h) => {
    const weight = h.available && invested ? h.marketValue / invested : 0;
    const move = !h.available ? null : daily ? h.dayChangePct : changes[h.symbol]?.change ?? null;
    return { h, weight, country: countryOf.get(h.symbol) || 'Inconnu', move, contribution: move == null ? null : weight * move };
  });
  result.movers = result.positions.filter((x) => x.move != null).sort((a, b) => b.move - a.move);
  result.exposures = ex;
  result.flags = preferenceFlags(portfolio, profile);
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
  const region = a.exposures.regions.find(([name]) => name !== FUND_REGION);
  if (region) tiles.push({ label: 'Région principale', value: share(region[1]), tone: 'flat',
    detail: a.exposures.funds.length ? `${region[0]} (hors FNB)` : region[0] });
  if (a.flags.length) {
    // One holding can break several preferences: count its exposure once, at its largest.
    const bySymbol = new Map();
    for (const f of a.flags) bySymbol.set(f.symbol, Math.max(bySymbol.get(f.symbol) || 0, f.portfolioShare));
    const exposure = [...bySymbol.values()].reduce((s, x) => s + x, 0);
    tiles.push({ label: 'Hors de vos préférences', value: share(exposure), tone: 'down',
      detail: [...bySymbol.keys()].slice(0, 3).join(', ') + (bySymbol.size > 3 ? '…' : '') });
  }
  return tiles;
}

function buildBrief({ period, portfolio, profile, changes = {}, now = Date.now() }) {
  const a = analyze({ period, portfolio, changes, profile });
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
  lines.push('', `## POSITIONS (${portfolio.holdings.length} titres ; symbole ; nom ; type ; secteur ; pays de l'émetteur ; devise ; poids dans les titres ; ${moveLabel} ; gain/perte depuis l'achat)`);
  if (!daily) lines.push('- Variation du cours en devise de cotation, hors effet de change, entre la dernière clôture avant le début de la période et la dernière clôture.');
  if (!portfolio.holdings.length) lines.push('- Aucun titre.');
  for (const x of a.positions) {
    const { h } = x;
    if (!h.available) {
      lines.push(`- ${h.symbol} ; cours indisponible`);
      continue;
    }
    const sector = h.fund ? 'plusieurs (voir composition des FNB)' : h.sector ? sectorFr(h.sector) : 'secteur inconnu';
    lines.push(`- ${h.symbol} ; ${h.name} ; ${h.fund ? 'FNB' : 'action'} ; ${sector} ; ${x.country} ; ${h.currency || 'devise inconnue'} ; `
      + `${share(x.weight)} ; ${x.move == null ? 'variation indisponible' : pct(x.move)} ; ${pct(h.gainPct)}`);
  }

  const funds = a.positions.filter((x) => x.h.available && x.h.fund);
  if (funds.length) {
    lines.push('', '## COMPOSITION DES FNB (publiée par le fonds ; parts du FNB)');
    for (const { h } of funds) {
      const f = h.fund;
      const sectors = Object.entries(f.sectorWeights || {}).sort((m, n) => n[1] - m[1]).slice(0, 6)
        .map(([sec, w]) => `${sectorFr(sec)} ${share(w)}`).join(', ');
      const top = (f.topHoldings || []).slice(0, 5).map((t) => `${t.name || t.symbol} ${share(t.weight)}`).join(', ');
      const mix = [f.stockPosition != null && `actions ${share(f.stockPosition)}`, f.bondPosition > 0 && `obligations ${share(f.bondPosition)}`,
        f.cashPosition > 0.005 && `liquidités ${share(f.cashPosition)}`].filter(Boolean).join(', ');
      lines.push(`- ${h.symbol} (${h.name}${f.family ? `, ${f.family}` : ''}) : ${mix || 'répartition par classe d\'actifs non publiée'}.`);
      lines.push(`  - Secteurs : ${sectors || 'non publiés'}.`);
      lines.push(`  - Principaux titres : ${top || 'non publiés'}.`);
    }
    lines.push('- Les FNB sont décomposés dans l\'exposition sectorielle ; leur répartition géographique n\'est pas publiée.');
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
  table('EXPOSITION PAR SECTEUR (part des titres, FNB décomposés selon leur composition)', ex.sectors);

  lines.push('', '## CONFLITS AVEC LES PRÉFÉRENCES DU PROFIL (secteurs à éviter et activités exclues ; FNB signalés dès '
    + `${share(FLAG_MIN_FUND_SHARE)} du fonds ; part du portefeuille = part des titres)`);
  if (!profile) lines.push('- Profil non renseigné : aucune préférence à vérifier.');
  else if (!a.flags.length) lines.push('- Aucun titre ni FNB fortement exposé à un secteur à éviter ou à une activité exclue.');
  for (const f of a.flags) {
    const detail = f.holdings.length ? ` ; titres concernés : ${f.holdings.slice(0, 4).map((x) => `${x.name || x.symbol} ${share(x.weight)}`).join(', ')}` : '';
    lines.push(`- ${f.symbol} (${f.fund ? 'FNB' : 'action'}, ${f.name}) ; ${f.reason} ; ${f.fund ? `${share(f.fundShare)} du FNB` : 'titre entier'} ; `
      + `${share(f.portfolioShare)} du portefeuille${detail}`);
  }

  const cutoff = now - Math.max(p.days, 1) * 24 * 3600e3;
  const symbols = new Set(portfolio.holdings.map((h) => h.symbol.split('.')[0]));
  const ownSectors = new Set(ex.sectors.map(([sector]) => sector));
  // portfolio.news: { real, items } (app/news.js: real news, or the samples without a database).
  const newsBlock = Array.isArray(portfolio.news) ? { real: false, items: portfolio.news } : (portfolio.news || { items: [] });
  const news = (newsBlock.items || []).filter((n) => Date.parse(n.publishedAt) >= cutoff
    && (n.symbols.some((sym) => symbols.has(sym.split('.')[0])) || ownSectors.has(n.sector)));
  lines.push('', newsBlock.real
    ? '## ACTUALITÉS DE LA PÉRIODE (médias et Yahoo Finance, langue d\'origine ; ton détecté par Amazon Comprehend)'
    : '## ACTUALITÉS DE LA PÉRIODE (fictives, prototype)');
  if (!news.length) lines.push('- Aucune actualité liée au portefeuille sur la période.');
  for (const n of news) {
    const TONES = { POSITIVE: 'positif', NEGATIVE: 'négatif', NEUTRAL: 'neutre', MIXED: 'mitigé' };
    const tone = TONES[n.sentiment] ? ` ; ton ${TONES[n.sentiment]}` : '';
    lines.push(`- ${formatDate(n.publishedAt)} ; ${n.source}${tone} ; ${n.title}${n.summary ? ` : ${n.summary}` : ''}`);
  }

  lines.push('', '## PROFIL INVESTISSEUR', profileSummary(profile));
  return lines.join('\n');
}

module.exports = { PERIODS, buildBrief, analyze, highlights, periodFrom, periodStart, exposures, preferenceFlags, issuerCountry };
