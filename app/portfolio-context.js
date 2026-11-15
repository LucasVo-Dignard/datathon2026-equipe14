'use strict';
// ---------------------------------------------------------------------------
// The client's portfolio, prepared for the agents (bot.js).
//
// The positions (portfolio.js: CAD values, gains, weights) are joined with the
// environment's database (company_profiles: sector, industry, country) to
// compute the breakdowns and check the investor profile's guardrails
// (largest sector, number of assets, crypto share, excluded activities).
//
//   - summary(...): a compact text, added to the agent's system prompt on
//     every message, so the agent always knows what the client holds;
//   - details(...): the full view, returned by the get_portfolio_details tool.
//
// Always the portfolio of the user logged in on the server: nothing here takes
// a username from the model.
// ---------------------------------------------------------------------------

let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  }
  return pool;
}

// Excluded activities of the investor profile -> industries of the database.
const EXCLUSION_INDUSTRIES = {
  fossil: { label: 'combustibles fossiles', test: (i) => /^Oil & Gas|Thermal Coal|Regulated Gas/.test(i) },
  weapons: { label: 'armement', test: (i) => i === 'Aerospace & Defense', note: 'aéronautique et défense, à vérifier : inclut l\'aéronautique civile' },
  tobacco: { label: 'tabac', test: (i) => i === 'Tobacco' },
};

const pct = (x) => `${(Math.round(x * 1000) / 10).toLocaleString('fr-CA')} %`;
const cad = (x) => `${Math.round(x).toLocaleString('fr-CA')} $`;
const isCrypto = (symbol) => /-(USD|CAD|EUR)$/.test(symbol);

// Sector, industry and country of each held symbol (also tried with and
// without the Canadian exchange suffix: RY.TO <-> RY).
async function companyProfiles(symbols) {
  if (!process.env.DATABASE_URL || !symbols.length) return new Map();
  const variants = new Set();
  for (const s of symbols) {
    variants.add(s);
    variants.add(s.replace(/\.(TO|V|NE)$/, ''));
    if (!s.includes('.')) variants.add(`${s}.TO`);
  }
  const { rows } = await getPool().query(
    'SELECT symbol, name, sector, industry, country FROM company_profiles WHERE symbol = ANY($1::text[])',
    [[...variants]],
  );
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const out = new Map();
  for (const s of symbols) {
    const hit = bySymbol.get(s) || bySymbol.get(s.replace(/\.(TO|V|NE)$/, '')) || bySymbol.get(`${s}.TO`);
    if (hit) out.set(s, hit);
  }
  return out;
}

function breakdown(holdings, key, invested) {
  const totals = new Map();
  for (const h of holdings) {
    const k = h[key] || 'inconnu';
    totals.set(k, (totals.get(k) || 0) + h.marketValue);
  }
  return [...totals]
    .map(([name, value]) => ({ name, value: Math.round(value), share: invested ? value / invested : 0 }))
    .sort((a, b) => b.value - a.value);
}

function performance(history) {
  if (!history?.length) return null;
  const last = history[history.length - 1];
  const at = (days) => {
    const target = new Date(last.date);
    target.setUTCDate(target.getUTCDate() - days);
    const iso = target.toISOString().slice(0, 10);
    return history.find((p) => p.date >= iso) || history[0];
  };
  const change = (p) => (p.value ? last.value / p.value - 1 : 0);
  return { oneMonth: change(at(31)), threeMonths: change(at(92)), oneYear: change(at(366)) };
}

/**
 * Full view of the portfolio for the agents, or null if the client has not
 * created one yet.
 */
async function details({ portfolio, profile }) {
  if (!portfolio) return null;
  const held = portfolio.holdings.filter((h) => h.quantity > 0);
  let profiles = new Map();
  let databaseError = null;
  try {
    profiles = await companyProfiles(held.map((h) => h.symbol));
  } catch (err) {
    databaseError = err.message;
    console.error('portfolio context (database):', err.message);
  }

  const holdings = held.map((h) => {
    const p = profiles.get(h.symbol);
    return {
      symbol: h.symbol,
      name: p?.name || h.name,
      quantity: h.quantity,
      priceCAD: h.price,
      marketValue: h.marketValue,
      weight: h.weight,
      gain: h.gain,
      gainPct: h.gainPct,
      dayChangePct: h.dayChangePct,
      listingCurrency: h.currency,
      sector: p?.sector || h.sector || null,
      industry: p?.industry || null,
      country: p?.country || null,
      crypto: isCrypto(h.symbol),
      priceAvailable: h.available !== false,
    };
  });

  const s = portfolio.summary;
  const invested = s.investedValue;
  const bySector = breakdown(holdings, 'sector', invested);
  const g = profile?.guardrails;

  const checks = [];
  if (g) {
    const top = bySector[0];
    checks.push({
      rule: 'Part maximale d\'un secteur',
      limit: `${g.maxSingleSectorShare} %`,
      actual: top ? `${top.name} : ${pct(top.share)}` : 'aucune position',
      status: top && top.share * 100 > g.maxSingleSectorShare ? 'dépassé' : 'respecté',
    });
    checks.push({
      rule: 'Nombre minimal d\'actifs',
      limit: String(g.minDiversifiedAssets),
      actual: String(holdings.length),
      status: holdings.length < g.minDiversifiedAssets ? 'non atteint' : 'respecté',
    });
    const crypto = holdings.filter((h) => h.crypto).reduce((sum, h) => sum + h.marketValue, 0);
    checks.push({
      rule: 'Part maximale de cryptoactifs',
      limit: `${g.maxCryptoShare} %`,
      actual: pct(s.totalValue ? crypto / s.totalValue : 0),
      status: s.totalValue && (crypto / s.totalValue) * 100 > g.maxCryptoShare ? 'dépassé' : 'respecté',
    });
    for (const code of g.excludedActivities || []) {
      const rule = EXCLUSION_INDUSTRIES[code];
      if (!rule) {
        checks.push({ rule: `Exclusion : ${code}`, status: 'non vérifiable avec la base de données' });
        continue;
      }
      const hits = holdings.filter((h) => h.industry && rule.test(h.industry));
      checks.push({
        rule: `Exclusion : ${rule.label}`,
        actual: hits.length ? hits.map((h) => `${h.symbol} (${h.industry})`).join(', ') : 'aucune position concernée',
        status: hits.length ? 'à revoir' : 'respecté',
        ...(rule.note && hits.length ? { note: rule.note } : {}),
      });
    }
    checks.push({
      rule: 'Volatilité annuelle maximale',
      limit: `${g.maxAnnualVolatility} %`,
      status: 'non calculée (historique de performance fictif)',
    });
  }

  return {
    currency: portfolio.currency,
    asOf: portfolio.asOf,
    summary: {
      totalValue: s.totalValue, investedValue: invested, cash: s.cash,
      gain: s.gain, gainPct: s.gainPct, dayChange: s.dayChange, dayChangePct: s.dayChangePct,
      positions: holdings.length,
    },
    holdings,
    breakdowns: {
      bySector,
      byIndustry: breakdown(holdings, 'industry', invested),
      byCountry: breakdown(holdings, 'country', invested),
      byListingCurrency: breakdown(holdings, 'listingCurrency', invested),
    },
    guardrailChecks: profile ? checks : 'Profil investisseur non renseigné : garde-fous inconnus.',
    performance: { ...performance(portfolio.history), note: 'Historique de performance fictif (prototype) : ne pas le présenter comme réel.' },
    notes: [
      'Valeurs en CAD (converties au taux du jour). Les parts sectorielles sont calculées sur la valeur investie (hors liquidités).',
      ...(databaseError ? [`Base de données indisponible (${databaseError}) : secteurs incomplets.`] : []),
      ...(holdings.some((h) => !h.priceAvailable) ? ['Certaines positions n\'ont pas de cours disponible (valeur 0).'] : []),
    ],
  };
}

/** Compact text for the system prompt (a few hundred tokens). */
function summary(view) {
  if (!view) {
    return "Portefeuille du client : pas encore créé. S'il pose une question sur son portefeuille, invite-le à le créer dans l'onglet Portefeuille.";
  }
  const s = view.summary;
  const lines = [
    `Portefeuille du client (en CAD, au ${view.asOf}) : valeur totale ${cad(s.totalValue)}, dont ${cad(s.cash)} de liquidités ; `
      + `gain non réalisé ${cad(s.gain)} (${pct(s.gainPct)}) ; ${s.positions} position(s).`,
    `Positions : ${view.holdings.map((h) => `${h.symbol} ${h.name} ${pct(h.weight)}${h.sector ? ` [${h.sector}${h.country ? `, ${h.country}` : ''}]` : ''}`).join(' ; ') || 'aucune'}.`,
    `Secteurs (part de la valeur investie) : ${view.breakdowns.bySector.map((b) => `${b.name} ${pct(b.share)}`).join(', ') || 'aucun'}.`,
  ];
  if (Array.isArray(view.guardrailChecks)) {
    const issues = view.guardrailChecks.filter((c) => !['respecté'].includes(c.status) && !String(c.status).startsWith('non calculée'));
    lines.push(issues.length
      ? `Garde-fous à signaler : ${issues.map((c) => `${c.rule} (${c.actual || ''}${c.limit ? ` ; limite ${c.limit}` : ''}) : ${c.status}`).join(' ; ')}.`
      : 'Garde-fous du profil : tous respectés (hors volatilité, non calculée).');
  }
  lines.push('Détail (industries, pays, devises, gains par position, vérification des garde-fous) : outil get_portfolio_details.');
  return lines.join('\n');
}

module.exports = { details, summary };
