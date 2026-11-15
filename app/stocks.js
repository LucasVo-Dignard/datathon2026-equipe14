'use strict';
// ---------------------------------------------------------------------------
// Fiche rapide d'un titre (barre de recherche).
//
//   - DATABASE_URL défini -> lit company_profiles / price_bars. Si le titre est
//     absent ou périmé (STALE_MS), le charge d'abord depuis Yahoo et l'enregistre
//     (profil, métriques, cible des analystes, cours, recommandations).
//   - sinon -> interroge Yahoo directement, sans rien enregistrer.
//
// Infos volontairement limitées pour l'instant : nom, bourse, devise, dernier
// cours et variation du jour.
// ---------------------------------------------------------------------------

const marketdata = require('../src/marketdata');
const { repo } = marketdata.db;
const { DateRange } = marketdata;
const { LOOKBACK_DAYS } = marketdata.refresh;

const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;
const STALE_MS = 60 * 60 * 1000;
// Premier chargement d'un titre : un an de cours (une seule requête Yahoo).
const FIRST_LOAD_DAYS = 365;

function normalizeSymbol(value) {
  const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

// Sans base de données, le portefeuille aléatoire pioche dans cette liste
// (la liste de départ de tracked_symbols, migration V3).
const FALLBACK_SYMBOLS = [
  'RY.TO', 'TD.TO', 'BNS.TO', 'BMO.TO', 'CM.TO', 'NA.TO', 'MFC.TO', 'SLF.TO', 'ENB.TO', 'TRP.TO',
  'CNQ.TO', 'SU.TO', 'CP.TO', 'CNR.TO', 'SHOP.TO', 'CSU.TO', 'ATD.TO', 'BCE.TO', 'T.TO', 'ABX.TO',
  'NTR.TO', 'WCN.TO', 'BN.TO', 'L.TO', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META',
];

function shuffled(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toQuote({ symbol, name, exchange, currency, country, sector, price, prevClose, asOf, provider }) {
  const change = prevClose == null ? null : price - prevClose;
  return {
    symbol,
    name,
    exchange: exchange || null,
    currency: currency || null,
    country: country || null,
    sector: sector || null,
    price,
    change,
    changePct: change == null || !prevClose ? null : change / prevClose,
    asOf,
    source: provider,
  };
}

function createDbLookup({ connectionString, yahooClient, now, log }) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 3 });
  pool.on('error', (err) => log.error('postgres pool error (stocks):', err.message));
  const loading = new Map(); // symbol -> promise, pour ne pas charger deux fois en parallèle

  async function load(symbol, firstLoad) {
    const steps = marketdata.refresh.yahooSteps(yahooClient, { priceDays: firstLoad ? FIRST_LOAD_DAYS : LOOKBACK_DAYS });
    const client = await pool.connect();
    try {
      await marketdata.refresh.refresh(client, [symbol], steps, { log, track: false });
    } finally {
      client.release();
    }
  }

  // maxAgeMs: Infinity accepte n'importe quel cours en base (le portefeuille
  // s'en contente : les titres suivis sont rafraîchis chaque jour par le batch).
  async function lookup(symbol, { maxAgeMs = STALE_MS } = {}) {
    const cached = await repo.latestQuote(pool, symbol);
    if (cached && now() - cached.fetchedAt.getTime() < maxAgeMs) return toQuote(cached);

    if (!loading.has(symbol)) {
      loading.set(symbol, load(symbol, !cached).finally(() => loading.delete(symbol)));
    }
    try {
      await loading.get(symbol);
    } catch (err) {
      // Yahoo ou la base indisponible : des données un peu vieilles valent mieux que rien.
      log.error(`stock load error (${symbol}):`, err.message);
      if (cached) return toQuote(cached);
      throw err;
    }
    const fresh = await repo.latestQuote(pool, symbol);
    return fresh ? toQuote(fresh) : null;
  }

  // Titres suivis au hasard : d'abord ceux qui ont déjà un cours en base (pas
  // d'appel à Yahoo pour les valoriser), en CAD ou USD de préférence.
  async function randomSymbols(count) {
    const { rows } = await pool.query(
      `SELECT t.symbol
         FROM tracked_symbols t
         LEFT JOIN LATERAL (SELECT currency FROM price_bars p WHERE p.symbol = t.symbol
                             ORDER BY date DESC LIMIT 1) last ON true
        WHERE t.active
        ORDER BY (last.currency IS NOT NULL) DESC, (last.currency IN ('CAD', 'USD')) DESC, random()
        LIMIT $1`, [count]);
    return rows.length ? rows.map((r) => r.symbol) : shuffled(FALLBACK_SYMBOLS).slice(0, count);
  }

  return { lookup, randomSymbols, close: () => pool.end() };
}

function createLiveLookup({ yahooClient }) {
  const profiles = new marketdata.yahoo.YahooProfileFetcher(yahooClient);
  const history = new marketdata.yahoo.YahooPriceHistoryFetcher(yahooClient);

  async function lookup(symbol) {
    let profile;
    try {
      profile = await profiles.fetch(symbol);
    } catch (err) {
      if (err instanceof marketdata.SymbolNotFoundError) return null;
      throw err;
    }
    const bars = await history.fetch(symbol, DateRange.lastDays(LOOKBACK_DAYS));
    if (!bars.length) return null;
    const [prev, last] = bars.slice(-2).length === 2 ? bars.slice(-2) : [null, bars.at(-1)];
    return toQuote({
      symbol,
      name: profile.name,
      exchange: profile.exchange,
      currency: last.currency || profile.currency,
      country: profile.country,
      sector: profile.sector,
      price: last.close,
      prevClose: prev?.close ?? null,
      asOf: last.date,
      provider: last.provider,
    });
  }

  return {
    lookup,
    randomSymbols: async (count) => shuffled(FALLBACK_SYMBOLS).slice(0, count),
    close: async () => {},
  };
}

function createStockLookup({
  connectionString = process.env.DATABASE_URL,
  yahooClient = marketdata.refresh.newYahooClient(),
  now = Date.now,
  log = console,
} = {}) {
  return connectionString
    ? createDbLookup({ connectionString, yahooClient, now, log })
    : createLiveLookup({ yahooClient });
}

module.exports = { createStockLookup, normalizeSymbol, STALE_MS };
