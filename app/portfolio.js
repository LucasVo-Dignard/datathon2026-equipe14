'use strict';
// ---------------------------------------------------------------------------
// Portefeuille simulé du client.
//
// À la création du compte, l'utilisateur choisit :
//   - 'random' : quelques titres tirés au hasard parmi ceux en base (tracked_symbols),
//   - 'custom' : un portefeuille vide qu'il remplit lui-même.
// Les positions (symbole, quantité, coût moyen) sont dans portfolio-store.js ;
// les cours viennent de stocks.js (base ou Yahoo). Tout est valorisé en CAD.
// L'historique de performance et les actualités restent fictifs (prototype).
// ---------------------------------------------------------------------------

const CURRENCY = 'CAD';
const RANDOM_SIZE = 8;
const MAX_QUANTITY = 1e7;
// Cours gardés en mémoire quelques minutes : le tableau de bord ne relit pas tout à chaque affichage.
const QUOTE_CACHE_MS = 5 * 60 * 1000;
// Taux de change : un cours de la veille suffit.
const FX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Devises cotées en centièmes par Yahoo (ex. GBp = pence).
const SUBUNITS = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };

// Fictional news (prototype), tied to the client's stocks or their sectors.
// hoursAgo keeps them recent relative to the current time.
const NEWS = [
  { hoursAgo: 2, sector: 'Finance', symbols: ['RY'], source: 'Fil financier',
    title: 'Banque Royale : résultats trimestriels au-dessus des attentes',
    summary: 'La banque profite de revenus de gestion de patrimoine en hausse et relève légèrement son dividende.' },
  { hoursAgo: 5, sector: 'Finance', symbols: ['RY', 'TD'], source: 'Économie Canada',
    title: 'La Banque du Canada maintient son taux directeur',
    summary: 'Les banques canadiennes réagissent peu ; les analystes surveillent la croissance du crédit hypothécaire.' },
  { hoursAgo: 9, sector: 'Technologie', symbols: ['SHOP'], source: 'Techno Hebdo',
    title: 'Shopify lance de nouveaux outils d’IA pour les marchands',
    summary: 'Les fonctions visent la rédaction de fiches produits et le service à la clientèle automatisé.' },
  { hoursAgo: 14, sector: 'Énergie', symbols: ['ENB'], source: 'Marchés de l’énergie',
    title: 'Le pétrole recule après une hausse des stocks américains',
    summary: 'Les sociétés de pipelines comme Enbridge restent moins exposées aux prix que les producteurs.' },
  { hoursAgo: 26, sector: 'Technologie', symbols: ['AAPL'], source: 'Techno Hebdo',
    title: 'Apple renouvelle sa gamme d’ordinateurs portables',
    summary: 'Nouvelles puces et autonomie accrue ; les précommandes ouvrent la semaine prochaine.' },
  { hoursAgo: 31, sector: 'Industrie', symbols: ['CNR'], source: 'Transport & logistique',
    title: 'CN investit dans son réseau ferroviaire de l’Ouest',
    summary: 'Le programme cible la capacité vers les ports du Pacifique pour les conteneurs et les céréales.' },
  { hoursAgo: 50, sector: 'Technologie', symbols: ['MSFT', 'AAPL', 'SHOP'], source: 'Marchés mondiaux',
    title: 'Les valeurs technologiques portées par l’infonuagique',
    summary: 'La demande des entreprises pour l’IA et le nuage soutient les grandes plateformes, dont Microsoft.' },
  { hoursAgo: 75, sector: 'FNB diversifié', symbols: ['XEQT'], source: 'Épargne & placements',
    title: 'Les FNB indiciels attirent toujours les épargnants canadiens',
    summary: 'Les portefeuilles tout-en-un à faibles frais continuent de recueillir des entrées nettes.' },
];

class PortfolioError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// Quantité saisie par l'utilisateur : nombre positif (fractions d'action permises).
function parseQuantity(value) {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_QUANTITY) {
    throw new PortfolioError(400, `Quantité invalide (nombre positif, au plus ${MAX_QUANTITY.toLocaleString('fr-CA')})`);
  }
  const q = round4(n);
  if (q <= 0) throw new PortfolioError(400, 'Quantité trop petite');
  return q;
}

// Deterministic PRNG so the fake history is the same on every request.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// One year of daily closing values (weekdays), ending today at `total`,
// with yesterday's close at `prevTotal`.
function fakeHistory(total, prevTotal) {
  if (!(total > 0)) return [];
  const rand = mulberry32(14);
  const days = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const start = new Date(d);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  for (; d >= start; d.setUTCDate(d.getUTCDate() - 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(isoDate(d));
  }
  // days[0] is today, going back in time.
  const values = [total, prevTotal];
  for (let i = 2; i < days.length; i++) {
    // Daily log return ~ drift + noise (Box-Muller), walked backwards.
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const r = 0.0006 + 0.0085 * z;
    values.push(values[i - 1] / Math.exp(r));
  }
  return days.map((date, i) => ({ date, value: round2(values[i]) })).reverse();
}

function createPortfolioService({ store, stocks, log = console, random = Math.random, now = Date.now }) {
  const quotes = new Map(); // `${symbol}|${maxAgeMs}` -> { at, promise }

  function quote(symbol, maxAgeMs = Infinity) {
    const key = `${symbol}|${maxAgeMs}`;
    const hit = quotes.get(key);
    if (hit && now() - hit.at < QUOTE_CACHE_MS) return hit.promise;
    const promise = stocks.lookup(symbol, { maxAgeMs });
    quotes.set(key, { at: now(), promise });
    promise.catch(() => quotes.delete(key));
    return promise;
  }

  // Combien de CAD vaut une unité de `currency`.
  async function cadRate(currency) {
    if (!currency) return 1;
    const [base, divisor] = SUBUNITS[currency] || [currency.toUpperCase(), 1];
    if (base === CURRENCY) return 1 / divisor;
    const fx = await quote(`${base}${CURRENCY}=X`, FX_MAX_AGE_MS);
    if (!fx?.price) throw new Error(`taux ${base}/${CURRENCY} indisponible`);
    return fx.price / divisor;
  }

  // Cours du titre converti en CAD, ou null s'il est introuvable.
  async function pricedQuote(symbol) {
    const q = await quote(symbol);
    if (!q || !(q.price > 0)) return null;
    return { ...q, rate: await cadRate(q.currency) };
  }

  // Composition if the symbol is a fund (ETF), else null. Never fails the valuation.
  async function fundOf(symbol) {
    if (!stocks.fund) return null;
    return stocks.fund(symbol).catch((err) => {
      log.error(`portfolio fund error (${symbol}):`, err.message);
      return null;
    });
  }

  async function value(record) {
    const [priced, funds] = await Promise.all([
      Promise.all(record.holdings.map((h) => pricedQuote(h.symbol).catch((err) => {
        log.error(`portfolio quote error (${h.symbol}):`, err.message);
        return null;
      }))),
      Promise.all(record.holdings.map((h) => fundOf(h.symbol))),
    ]);

    const holdings = record.holdings.map((h, i) => {
      const q = priced[i];
      if (!q) {
        return { symbol: h.symbol, name: h.symbol, sector: null, country: null, currency: null, quantity: h.quantity, available: false,
          fund: null, price: null, prevClose: null, avgCost: null, marketValue: 0, cost: 0, gain: 0, gainPct: 0, dayChange: 0, dayChangePct: 0 };
      }
      const price = q.price * q.rate;
      const prevClose = q.change == null ? price : (q.price - q.change) * q.rate;
      const avgCost = h.avgCost * q.rate;
      const marketValue = h.quantity * price;
      const cost = h.quantity * avgCost;
      return {
        symbol: h.symbol,
        name: q.name || h.symbol,
        sector: q.sector,
        country: q.country || null,
        currency: q.currency,
        // ETF composition (sector weights, top holdings), null for a stock.
        fund: funds[i],
        quantity: h.quantity,
        available: true,
        price: round2(price),
        prevClose: round2(prevClose),
        avgCost: round2(avgCost),
        marketValue: round2(marketValue),
        cost: round2(cost),
        gain: round2(marketValue - cost),
        gainPct: cost ? (marketValue - cost) / cost : 0,
        dayChange: round2(h.quantity * (price - prevClose)),
        dayChangePct: prevClose ? (price - prevClose) / prevClose : 0,
      };
    });

    const cash = record.cash;
    const invested = holdings.reduce((s, h) => s + h.marketValue, 0);
    const cost = holdings.reduce((s, h) => s + h.cost, 0);
    const dayChange = holdings.reduce((s, h) => s + h.dayChange, 0);
    const total = invested + cash;
    for (const h of holdings) h.weight = total ? h.marketValue / total : 0;

    return {
      currency: CURRENCY,
      source: record.source,
      asOf: isoDate(new Date(now())),
      summary: {
        totalValue: round2(total),
        investedValue: round2(invested),
        cash,
        cost: round2(cost),
        gain: round2(invested - cost),
        gainPct: cost ? (invested - cost) / cost : 0,
        dayChange: round2(dayChange),
        dayChangePct: total - dayChange ? dayChange / (total - dayChange) : 0,
      },
      holdings: holdings.sort((a, b) => b.marketValue - a.marketValue),
      history: fakeHistory(total, total - dayChange),
      news: NEWS.map(({ hoursAgo, ...n }) => ({
        ...n,
        publishedAt: new Date(now() - hoursAgo * 3600e3).toISOString(),
      })),
    };
  }

  // Quelques titres au hasard, chacun pour 1 500 à 8 000 $ environ, achetés
  // (fictivement) entre 25 % sous et 20 % au-dessus du cours actuel.
  async function randomHoldings() {
    const candidates = await stocks.randomSymbols(RANDOM_SIZE + 4);
    const priced = await Promise.all(candidates.map((s) => pricedQuote(s).catch((err) => {
      log.error(`portfolio quote error (${s}):`, err.message);
      return null;
    })));
    return priced.filter(Boolean).slice(0, RANDOM_SIZE).map((q) => {
      const target = 1500 + random() * 6500;
      return {
        symbol: q.symbol,
        quantity: Math.max(1, Math.round(target / (q.price * q.rate))),
        avgCost: round4(q.price * (0.75 + random() * 0.45)),
      };
    });
  }

  async function requireRecord(username) {
    return (await store.get(username))
      || store.create(username, { source: 'custom', cash: 0, holdings: [] });
  }

  return {
    // null tant que l'utilisateur n'a pas choisi comment démarrer.
    async get(username) {
      const record = await store.get(username);
      return record && value(record);
    },

    async create(username, mode) {
      if (mode === 'custom') {
        return value(await store.create(username, { source: 'custom', cash: 0, holdings: [] }));
      }
      if (mode !== 'random') throw new PortfolioError(400, 'Mode invalide (random ou custom)');
      const holdings = await randomHoldings();
      if (!holdings.length) throw new PortfolioError(502, 'Aucun cours disponible pour générer un portefeuille, réessayez plus tard');
      const cash = Math.round((500 + random() * 4500) / 10) * 10;
      return value(await store.create(username, { source: 'random', cash, holdings }));
    },

    // Ajoute le titre au cours actuel, ou change seulement sa quantité s'il y est déjà.
    async setQuantity(username, symbol, rawQuantity) {
      const quantity = parseQuantity(rawQuantity);
      const record = await requireRecord(username);
      const existing = record.holdings.find((h) => h.symbol === symbol);
      let avgCost = existing?.avgCost;
      if (!existing) {
        let q;
        try {
          q = await stocks.lookup(symbol);
        } catch (err) {
          log.error(`portfolio add error (${symbol}):`, err.message);
          throw new PortfolioError(502, 'Source de données indisponible, réessayez plus tard');
        }
        if (!q || !(q.price > 0)) throw new PortfolioError(404, `Aucune donnée pour ${symbol}`);
        avgCost = round4(q.price);
      }
      await store.setHolding(username, { symbol, quantity, avgCost });
      return this.get(username);
    },

    async remove(username, symbol) {
      await store.removeHolding(username, symbol);
      return this.get(username);
    },
  };
}

module.exports = { createPortfolioService, parseQuantity, PortfolioError, RANDOM_SIZE };
