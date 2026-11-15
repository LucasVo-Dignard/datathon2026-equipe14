'use strict';
// ---------------------------------------------------------------------------
// Données macroéconomiques (page Macro, GET /api/macro).
//
//   - DATABASE_URL défini -> lit macro_observations.
//   - sinon -> garde en mémoire ce qui a été téléchargé.
//
// Les indicateurs absents ou périmés (STALE_MS) sont rechargés depuis la
// Banque mondiale en arrière-plan : l'API est lente (jusqu'à une minute par
// indicateur), donc la page affiche ce qu'on a et `loading` dit qu'un
// chargement est en cours. La page redemande tant que `loading` est vrai.
// ---------------------------------------------------------------------------

const marketdata = require('../src/marketdata');
const { repo } = marketdata.db;
const { worldbank, YearRange } = marketdata;

// Données annuelles : une fois par semaine suffit.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
// Après un échec (API en panne), on ne réessaie pas à chaque affichage.
const RETRY_MS = 10 * 60 * 1000;
const YEARS = 10;

const INDICATORS = Object.keys(worldbank.DEFAULT_INDICATORS);
const COUNTRIES = [...worldbank.DEFAULT_COUNTRIES];

// Indicateurs par défaut absents, sans provenance (enregistrés avant la
// migration V6, ou métadonnées indisponibles), ou dont le dernier chargement
// est trop vieux.
function staleIndicators(observations, now) {
  const latest = new Map();
  const unsourced = new Set();
  for (const o of observations) {
    latest.set(o.indicator, Math.max(latest.get(o.indicator) || 0, new Date(o.fetchedAt).getTime()));
    if (!o.dataset) unsourced.add(o.indicator);
  }
  return INDICATORS.filter((code) => !latest.has(code) || unsourced.has(code) || now - latest.get(code) > STALE_MS);
}

const rank = (list) => (code) => {
  const i = list.indexOf(code);
  return i < 0 ? list.length : i;
};

// Un tableau par indicateur : un pays par ligne, une valeur par année.
// Chaque valeur renvoie (`source`) à une entrée de `sources` : en général une
// seule par indicateur, mais rien ne l'impose.
function summarize(observations) {
  const byIndicator = new Map();
  for (const o of observations) {
    let ind = byIndicator.get(o.indicator);
    if (!ind) {
      ind = { code: o.indicator, name: o.indicatorName || o.indicator, sources: new Map(),
        years: new Set(), countries: new Map(), fetchedAt: 0 };
      byIndicator.set(o.indicator, ind);
    }
    ind.years.add(o.year);
    ind.fetchedAt = Math.max(ind.fetchedAt, new Date(o.fetchedAt).getTime());

    const source = {
      provider: o.provider,
      dataset: o.dataset ?? null,
      organization: o.sourceOrganization ?? null,
      updatedOn: o.sourceUpdatedOn ?? null,
    };
    const sourceKey = JSON.stringify(source);
    if (!ind.sources.has(sourceKey)) ind.sources.set(sourceKey, { id: ind.sources.size, ...source });

    let country = ind.countries.get(o.country);
    if (!country) {
      country = { code: o.country, name: o.countryName || o.country, url: o.sourceUrl ?? null, values: {} };
      ind.countries.set(o.country, country);
    }
    country.values[o.year] = { value: o.value, source: ind.sources.get(sourceKey).id };
  }

  const indicatorRank = rank(INDICATORS);
  const countryRank = rank(COUNTRIES);
  return [...byIndicator.values()]
    .sort((a, b) => indicatorRank(a.code) - indicatorRank(b.code) || a.code.localeCompare(b.code))
    .map((ind) => ({
      code: ind.code,
      name: ind.name,
      sources: [...ind.sources.values()],
      fetchedAt: new Date(ind.fetchedAt).toISOString(),
      years: [...ind.years].sort((a, b) => b - a),
      countries: [...ind.countries.values()]
        .sort((a, b) => countryRank(a.code) - countryRank(b.code) || a.name.localeCompare(b.name)),
    }));
}

function dbStore({ connectionString, fetcher, log }) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 2 });
  pool.on('error', (err) => log.error('postgres pool error (macro):', err.message));
  return {
    read: () => repo.macroObservations(pool),
    async load(indicators) {
      const client = await pool.connect();
      try {
        await marketdata.refresh.refreshMacro(client, fetcher, {
          indicators, countries: COUNTRIES, years: YearRange.lastYears(YEARS), log,
        });
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function memoryStore({ fetcher, log }) {
  const cache = new Map(); // indicateur -> observations
  return {
    read: async () => [...cache.values()].flat(),
    async load(indicators) {
      for (const code of indicators) {
        try {
          cache.set(code, await fetcher.fetch(code, COUNTRIES, YearRange.lastYears(YEARS)));
        } catch (err) {
          log.error(`macro load error (${code}):`, err.message);
        }
      }
    },
    close: async () => {},
  };
}

function createMacroLookup({
  connectionString = process.env.DATABASE_URL,
  fetcher = new worldbank.WorldBankIndicatorFetcher(new worldbank.WorldBankClient()),
  now = Date.now,
  log = console,
} = {}) {
  const store = connectionString ? dbStore({ connectionString, fetcher, log }) : memoryStore({ fetcher, log });
  let loading = null;
  let lastAttempt = -Infinity;

  async function overview() {
    const observations = await store.read();
    const stale = staleIndicators(observations, now());
    if (stale.length && !loading && now() - lastAttempt >= RETRY_MS) {
      lastAttempt = now();
      loading = store.load(stale)
        .catch((err) => log.error('macro load error:', err.message))
        .finally(() => { loading = null; });
    }
    return { indicators: summarize(observations), loading: loading !== null };
  }

  // Pour les tests : attendre la fin du chargement en cours.
  const settled = () => loading || Promise.resolve();

  return { overview, settled, close: store.close };
}

module.exports = { createMacroLookup, summarize, staleIndicators, STALE_MS };
