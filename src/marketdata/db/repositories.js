'use strict';
// Write marketdata models to the tables created in db/migrations, and read
// back what the app needs.
//
// One save function per model. Snapshot tables (financial_metrics,
// price_target_consensus) get a new row on every save; the other tables are
// upserted on their primary key, so re-running a refresh never duplicates rows.
//
// Functions take an open connection (anything with `query(text, params)`) and
// don't commit: the caller decides the transaction boundary (see
// connection.transaction).

// INSERT many rows in one statement. `rows` are arrays in `columns` order.
async function insertMany(db, table, columns, rows, onConflict) {
  if (!rows.length) return;
  const params = [];
  const tuples = rows.map((row) => `(${row.map((value) => {
    params.push(value);
    return `$${params.length}`;
  }).join(', ')})`);
  await db.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ${onConflict}`, params);
}

const updateAll = (columns) => columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ');

// --- Tracked symbols ---------------------------------------------------------

async function activeSymbols(db) {
  const { rows } = await db.query('SELECT symbol FROM tracked_symbols WHERE active ORDER BY symbol');
  return rows.map((r) => r.symbol);
}

// Follow symbols (or follow them again if they were deactivated).
async function trackSymbols(db, symbols) {
  await insertMany(db, 'tracked_symbols', ['symbol'], [...new Set(symbols)].map((s) => [s]),
    'ON CONFLICT (symbol) DO UPDATE SET active = true');
}

// Symbols that already have a profile from `provider`.
async function profiledSymbols(db, provider) {
  const { rows } = await db.query('SELECT symbol FROM company_profiles WHERE provider = $1', [provider]);
  return new Set(rows.map((r) => r.symbol));
}

// Record the outcome of a refresh. last_refreshed_at moves only on success,
// so it always says how fresh the data really is.
async function markRefreshed(db, symbol, error = null) {
  await db.query(
    `UPDATE tracked_symbols
        SET last_refreshed_at = CASE WHEN $2::text IS NULL THEN $3 ELSE last_refreshed_at END,
            last_error = $2
      WHERE symbol = $1`,
    [symbol, error, new Date()]);
}

// --- Market data ---------------------------------------------------------------

const PROFILE_COLUMNS = ['name', 'exchange', 'currency', 'country', 'sector', 'industry', 'market_cap',
  'shares_outstanding', 'website', 'logo_url', 'ipo_date', 'description', 'fetched_at'];

async function saveProfile(db, p) {
  await insertMany(db, 'company_profiles', ['symbol', 'provider', ...PROFILE_COLUMNS],
    [[p.symbol, p.provider, p.name, p.exchange, p.currency, p.country, p.sector, p.industry, p.marketCap,
      p.sharesOutstanding, p.website, p.logoUrl, p.ipoDate, p.description, p.fetchedAt]],
    `ON CONFLICT (symbol, provider) DO UPDATE SET ${updateAll(PROFILE_COLUMNS)}`);
}

const BAR_COLUMNS = ['open', 'high', 'low', 'close', 'adj_close', 'volume', 'currency', 'fetched_at'];

async function savePriceBars(db, bars) {
  await insertMany(db, 'price_bars', ['symbol', 'provider', 'date', ...BAR_COLUMNS],
    bars.map((b) => [b.symbol, b.provider, b.date, b.open, b.high, b.low, b.close, b.adjClose, b.volume,
      b.currency, b.fetchedAt]),
    `ON CONFLICT (symbol, provider, date) DO UPDATE SET ${updateAll(BAR_COLUMNS)}`);
}

async function saveMetrics(db, m) {
  // JSON.stringify turns NaN and Infinity into null and dates into ISO strings.
  await insertMany(db, 'financial_metrics',
    ['symbol', 'provider', 'market_cap', 'pe_ttm', 'forward_pe', 'price_to_book', 'eps_ttm', 'dividend_yield',
      'beta', 'week52_high', 'week52_low', 'net_margin', 'return_on_equity', 'raw', 'fetched_at'],
    [[m.symbol, m.provider, m.marketCap, m.peTtm, m.forwardPe, m.priceToBook, m.epsTtm, m.dividendYield,
      m.beta, m.week52High, m.week52Low, m.netMargin, m.returnOnEquity, JSON.stringify(m.raw ?? {}), m.fetchedAt]],
    '');
}

async function savePriceTarget(db, t) {
  await insertMany(db, 'price_target_consensus',
    ['symbol', 'provider', 'currency', 'current_price', 'target_mean', 'target_median', 'target_high',
      'target_low', 'analyst_count', 'recommendation_mean', 'recommendation_key', 'fetched_at'],
    [[t.symbol, t.provider, t.currency, t.currentPrice, t.targetMean, t.targetMedian, t.targetHigh,
      t.targetLow, t.analystCount, t.recommendationMean, t.recommendationKey, t.fetchedAt]],
    '');
}

const ACTION_COLUMNS = ['action', 'from_grade', 'to_grade', 'price_target_action', 'price_target',
  'prior_price_target', 'fetched_at'];

async function saveRatingActions(db, actions) {
  // A firm can appear twice at the same instant in Yahoo's data; keep the
  // last one, since one statement can't upsert the same key twice.
  const unique = [...new Map(actions.map((a) => [`${a.gradedAt.getTime()}|${a.firm}`, a])).values()];
  await insertMany(db, 'analyst_rating_actions', ['symbol', 'provider', 'graded_at', 'firm', ...ACTION_COLUMNS],
    unique.map((a) => [a.symbol, a.provider, a.gradedAt, a.firm, a.action, a.fromGrade, a.toGrade,
      a.priceTargetAction, a.priceTarget, a.priorPriceTarget, a.fetchedAt]),
    `ON CONFLICT (symbol, provider, graded_at, firm) DO UPDATE SET ${updateAll(ACTION_COLUMNS)}`);
}

async function saveNews(db, articles) {
  const unique = [...new Map(articles.map((a) => [a.externalId, a])).values()];
  await insertMany(db, 'news_articles',
    ['provider', 'external_id', 'symbol', 'published_at', 'headline', 'url', 'summary', 'publisher',
      'image_url', 'category', 'fetched_at'],
    unique.map((a) => [a.provider, a.externalId, a.symbol, a.publishedAt, a.headline, a.url, a.summary,
      a.publisher, a.imageUrl, a.category, a.fetchedAt]),
    'ON CONFLICT (provider, external_id, symbol) DO NOTHING');
}

const EARNINGS_COLUMNS = ['fiscal_year', 'fiscal_quarter', 'hour', 'eps_estimate', 'eps_actual',
  'revenue_estimate', 'revenue_actual', 'fetched_at'];

async function saveEarnings(db, events) {
  const unique = [...new Map(events.map((e) => [e.date, e])).values()];
  await insertMany(db, 'earnings_events', ['symbol', 'provider', 'date', ...EARNINGS_COLUMNS],
    unique.map((e) => [e.symbol, e.provider, e.date, e.fiscalYear, e.fiscalQuarter, e.hour, e.epsEstimate,
      e.epsActual, e.revenueEstimate, e.revenueActual, e.fetchedAt]),
    `ON CONFLICT (symbol, provider, date) DO UPDATE SET ${updateAll(EARNINGS_COLUMNS)}`);
}

const TREND_COLUMNS = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell', 'fetched_at'];

async function saveRecommendations(db, trends) {
  const unique = [...new Map(trends.map((t) => [t.period, t])).values()];
  await insertMany(db, 'recommendation_trends', ['symbol', 'provider', 'period', ...TREND_COLUMNS],
    unique.map((t) => [t.symbol, t.provider, t.period, t.strongBuy, t.buy, t.hold, t.sell, t.strongSell,
      t.fetchedAt]),
    `ON CONFLICT (symbol, provider, period) DO UPDATE SET ${updateAll(TREND_COLUMNS)}`);
}

// --- Macro data --------------------------------------------------------------

const MACRO_COLUMNS = ['value', 'country_name', 'indicator_name', 'dataset', 'source_organization',
  'source_updated_on', 'source_url', 'fetched_at'];

async function saveMacroObservations(db, observations) {
  const key = (o) => `${o.country}|${o.indicator}|${o.provider}|${o.year}`;
  const unique = [...new Map(observations.map((o) => [key(o), o])).values()];
  await insertMany(db, 'macro_observations', ['country', 'indicator', 'provider', 'year', ...MACRO_COLUMNS],
    unique.map((o) => [o.country, o.indicator, o.provider, o.year, o.value, o.countryName, o.indicatorName,
      o.dataset, o.sourceOrganization, o.sourceUpdatedOn, o.sourceUrl, o.fetchedAt]),
    `ON CONFLICT (country, indicator, provider, year) DO UPDATE SET ${updateAll(MACRO_COLUMNS)}`);
}

// --- Reads -------------------------------------------------------------------

// Latest profile and the last two daily closes of a symbol, from any
// provider, or null if no price is cached. `fetchedAt` is when the latest bar
// was fetched, to decide whether the data is stale.
async function latestQuote(db, symbol) {
  const { rows: [profile] } = await db.query(
    `SELECT name, exchange, currency FROM company_profiles
      WHERE symbol = $1 ORDER BY fetched_at DESC LIMIT 1`, [symbol]);
  const { rows: bars } = await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, close::float8 AS close, currency, provider, fetched_at
       FROM price_bars WHERE symbol = $1 ORDER BY date DESC, fetched_at DESC LIMIT 2`, [symbol]);
  if (!bars.length) return null;
  return {
    symbol,
    name: profile?.name || symbol,
    exchange: profile?.exchange || null,
    currency: bars[0].currency || profile?.currency || null,
    price: bars[0].close,
    prevClose: bars[1]?.close ?? null,
    asOf: bars[0].date,
    provider: bars[0].provider,
    fetchedAt: bars[0].fetched_at,
  };
}

// Every macro observation, for the macro page. The table stays small (a few
// indicators x countries x years).
async function macroObservations(db) {
  const { rows } = await db.query(
    `SELECT country, indicator, provider, year, value, country_name, indicator_name, dataset,
            source_organization, to_char(source_updated_on, 'YYYY-MM-DD') AS source_updated_on, source_url,
            fetched_at
       FROM macro_observations ORDER BY indicator, country, year`);
  return rows.map((r) => ({
    country: r.country,
    indicator: r.indicator,
    provider: r.provider,
    year: r.year,
    value: r.value,
    countryName: r.country_name,
    indicatorName: r.indicator_name,
    dataset: r.dataset,
    sourceOrganization: r.source_organization,
    sourceUpdatedOn: r.source_updated_on,
    sourceUrl: r.source_url,
    fetchedAt: r.fetched_at,
  }));
}

module.exports = {
  activeSymbols,
  trackSymbols,
  profiledSymbols,
  markRefreshed,
  saveProfile,
  savePriceBars,
  saveMetrics,
  savePriceTarget,
  saveRatingActions,
  saveNews,
  saveEarnings,
  saveRecommendations,
  saveMacroObservations,
  macroObservations,
  latestQuote,
};
