'use strict';
// ---------------------------------------------------------------------------
// Similar companies, from the environment's database (company_profiles:
// sector, industry, country, market cap of about 1,000 listed companies).
//
// Used by the agent (bot.js, tool find_similar_companies) BEFORE any detailed
// research, so that the companies it proposes really share the reference
// company's industry, sector and/or country, instead of being guessed.
//
// Needs DATABASE_URL (the app's Postgres); without it the tool is disabled.
// ---------------------------------------------------------------------------

const MAX_RESULTS = 15;

let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  }
  return pool;
}

const isEnabled = () => Boolean(process.env.DATABASE_URL);

const PROFILE_COLUMNS = 'symbol, name, exchange, currency, country, sector, industry, market_cap';

/**
 * Finds the reference company by ticker (also tried with Canadian suffixes,
 * e.g. CNR -> CNR.TO) or by name. When several match, the largest wins.
 */
async function findCompany({ ticker, company }) {
  const t = (ticker || '').trim().toUpperCase();
  const symbols = t ? [t, `${t}.TO`, `${t}.V`, `${t}.NE`] : [];
  const name = (company || '').trim();
  const { rows } = await getPool().query(
    `SELECT ${PROFILE_COLUMNS} FROM company_profiles
      WHERE sector IS NOT NULL
        AND (symbol = ANY($1::text[]) OR ($2 <> '' AND name ILIKE '%' || $2 || '%'))
      ORDER BY (symbol = $3) DESC, (symbol = ANY($1::text[])) DESC, market_cap DESC NULLS LAST
      LIMIT 1`,
    [symbols, name, t],
  );
  return rows[0] || null;
}

function toCompany(row) {
  return {
    symbol: row.symbol,
    // Ticker without the Canadian exchange suffix (TD.TO -> TD): the one to
    // pass to research_company (the knowledge base filters on it).
    ticker: row.symbol.replace(/\.(TO|V|NE)$/, ''),
    name: row.name,
    exchange: row.exchange,
    country: row.country,
    sector: row.sector,
    industry: row.industry,
    // In the listing's currency (CAD, USD, JPY...): compare within one currency only.
    marketCapBillions: row.market_cap == null ? null : Math.round(Number(row.market_cap) / 1e8) / 10,
    currency: row.currency,
    ...(row.match ? { match: row.match } : {}),
  };
}

/**
 * Returns { reference, candidates } for the given company. Candidates share
 * the reference's industry first, then its sector; same country ranks higher,
 * then the closest market cap. Optional filters: country, sector (exact
 * database values, e.g. "Canada", "Industrials"), sameCountryOnly.
 */
async function findSimilarCompanies({ company, ticker, country, sector, sameCountryOnly = false, limit = 8 }) {
  const reference = await findCompany({ ticker, company });
  if (!reference) return { reference: null, candidates: [] };

  const n = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || 8));
  const countryFilter = sameCountryOnly ? reference.country : (country || null);
  const { rows } = await getPool().query(
    `SELECT ${PROFILE_COLUMNS},
            CASE WHEN industry = $2 THEN 'same industry' ELSE 'same sector' END AS match,
            (industry = $2)::int * 4 + (sector = $3)::int * 2 + (country = $4)::int AS score
       FROM company_profiles
      WHERE symbol <> $1
        AND name <> $9
        AND (industry = $2 OR sector = COALESCE($6, $3))
        AND ($5::text IS NULL OR country = $5)
      ORDER BY score DESC,
               ABS(LN(GREATEST(COALESCE(market_cap, 1), 1) / GREATEST(COALESCE($7::numeric, 1), 1))) ASC
      LIMIT $8`,
    [reference.symbol, reference.industry, reference.sector, reference.country,
      countryFilter, sector || null, reference.market_cap, n * 2, reference.name],
  );
  // One line per company: drop the other listings of a company already listed.
  const seen = new Set();
  const candidates = rows.filter((row) => !seen.has(row.name) && seen.add(row.name)).slice(0, n);
  return { reference: toCompany(reference), candidates: candidates.map(toCompany) };
}

module.exports = { findSimilarCompanies, isEnabled };
