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

// Well-known ETFs for random portfolios: Canadian all-in-one and index funds,
// US index funds, plus a few sector funds so preference checks have something to find.
const RANDOM_ETFS = [
  'XEQT.TO', 'VEQT.TO', 'XGRO.TO', 'VGRO.TO', 'XBAL.TO', 'XIC.TO', 'VCN.TO', 'ZCN.TO', 'VFV.TO', 'ZSP.TO',
  'XUS.TO', 'XEF.TO', 'XEC.TO', 'ZAG.TO', 'XBB.TO', 'ZEB.TO', 'XEG.TO', 'XIT.TO', 'ZWC.TO',
  'SPY', 'VOO', 'VTI', 'QQQ', 'VXUS', 'IEMG', 'BND', 'XLE', 'XLV', 'ITA', 'VNQ',
];

// North American listing: no suffix (US) or a Canadian exchange suffix.
const isNorthAmerican = (symbol) => !symbol.includes('.') || /\.(TO|V|NE|CN)$/i.test(symbol);
// About a quarter international, the rest North American (our clients are Canadian).
function mixListings(symbols, count) {
  const na = symbols.filter(isNorthAmerican);
  const intl = symbols.filter((s) => !isNorthAmerican(s));
  const intlCount = Math.min(intl.length, Math.round(count / 4));
  const picked = [...na.slice(0, count - intlCount), ...intl.slice(0, intlCount)];
  // Not enough North American listings: fill with international ones.
  picked.push(...intl.slice(intlCount, intlCount + count - picked.length));
  return shuffled(picked);
}

const randomFunds = async (count) => shuffled(RANDOM_ETFS).slice(0, count);

// A start close more than this before the requested date is a data gap, not a start.
const MAX_START_GAP_DAYS = 10;
// Fund holdings change slowly: re-fetch a composition once a week.
const FUND_STALE_MS = 7 * 24 * 60 * 60 * 1000;

// What the app needs from a FundComposition; null for anything but a fund.
function asFund(c) {
  if (!marketdata.models.isFund(c)) return null;
  return {
    type: c.quoteType,
    category: c.category || null,
    family: c.family || null,
    stockPosition: c.stockPosition ?? null,
    bondPosition: c.bondPosition ?? null,
    cashPosition: c.cashPosition ?? null,
    sectorWeights: c.sectorWeights || {},
    topHoldings: c.topHoldings || [],
  };
}

const daysBetween = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3;

// { from, to, change } between the last close on or before `fromDate` and the
// latest close, in the stock's own currency; null without a usable start.
function toChange(start, end, fromDate) {
  if (!start || !end || !(start.close > 0) || end.date <= start.date) return null;
  if (daysBetween(start.date, fromDate) > MAX_START_GAP_DAYS) return null;
  return { from: start.date, to: end.date, change: end.close / start.close - 1 };
}

// Same from Yahoo, nothing saved.
async function yahooChange(history, symbol, fromDate) {
  const range = new DateRange(DateRange.lastDays(MAX_START_GAP_DAYS + 1, fromDate).start, DateRange.lastDays(1).end);
  const bars = (await history.fetch(symbol, range)).filter((b) => b.close > 0);
  const start = bars.filter((b) => b.date <= fromDate).at(-1);
  return toChange(start, bars.at(-1), fromDate);
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

  // Titres suivis au hasard, parmi tous ceux de tracked_symbols (ceux sans
  // cours sont chargés depuis Yahoo à la valorisation, puis gardés en base).
  // Surtout des cotations canadiennes et américaines, avec un peu d'international.
  async function randomSymbols(count) {
    const { rows } = await pool.query(
      'SELECT symbol FROM tracked_symbols WHERE active ORDER BY random() LIMIT $1', [count * 4]);
    if (!rows.length) return shuffled(FALLBACK_SYMBOLS).slice(0, count);
    return mixListings(rows.map((r) => r.symbol), count);
  }

  // Price change since `fromDate` (ISO): from the stored bars, or from Yahoo
  // when they don't go back that far (symbols loaded with a short history).
  const history = new marketdata.yahoo.YahooPriceHistoryFetcher(yahooClient);
  async function changeSince(symbol, fromDate) {
    const [start, end] = await Promise.all([
      repo.closeOnOrBefore(pool, symbol, fromDate),
      repo.closeOnOrBefore(pool, symbol, '9999-12-31'),
    ]);
    return toChange(start, end, fromDate) || yahooChange(history, symbol, fromDate);
  }

  // Fund composition (null for a stock): stored, or fetched from Yahoo and
  // saved when missing or older than FUND_STALE_MS (a fund's holdings move slowly).
  const funds = new marketdata.yahoo.YahooFundCompositionFetcher(yahooClient);
  async function fund(symbol) {
    let cached = null;
    try {
      cached = await repo.fundComposition(pool, symbol);
    } catch (err) {
      // Table missing (migration V11 not applied yet): ask Yahoo, save nothing.
      log.error(`fund composition read error (${symbol}):`, err.message);
      return asFund(await funds.fetch(symbol));
    }
    if (cached && now() - cached.fetchedAt.getTime() < FUND_STALE_MS) return asFund(cached);
    try {
      const fresh = await funds.fetch(symbol);
      await repo.saveFundComposition(pool, fresh);
      return asFund(fresh);
    } catch (err) {
      log.error(`fund composition load error (${symbol}):`, err.message);
      if (cached) return asFund(cached);
      throw err;
    }
  }

  return { lookup, randomSymbols, randomFunds, changeSince, fund, close: () => pool.end() };
}

function createLiveLookup({ yahooClient, now }) {
  const profiles = new marketdata.yahoo.YahooProfileFetcher(yahooClient);
  const history = new marketdata.yahoo.YahooPriceHistoryFetcher(yahooClient);
  const funds = new marketdata.yahoo.YahooFundCompositionFetcher(yahooClient);
  const fundCache = new Map(); // symbol -> { at, promise }, nothing is saved without a database

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
    randomFunds,
    changeSince: (symbol, fromDate) => yahooChange(history, symbol, fromDate),
    fund(symbol) {
      const hit = fundCache.get(symbol);
      if (hit && now() - hit.at < FUND_STALE_MS) return hit.promise;
      const promise = funds.fetch(symbol).then(asFund);
      fundCache.set(symbol, { at: now(), promise });
      promise.catch(() => fundCache.delete(symbol));
      return promise;
    },
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
    : createLiveLookup({ yahooClient, now });
}

module.exports = { createStockLookup, normalizeSymbol, mixListings, RANDOM_ETFS, STALE_MS };
