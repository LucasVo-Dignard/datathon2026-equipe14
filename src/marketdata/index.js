'use strict';
// Market data fetching for CourtIAge Direct.
//
// Layout:
// - models.js: provider-independent data shapes (one per table)
// - fetchers/base.js: abstract interfaces, one per kind of data
// - providers/yahoo: client, mappers and concrete fetchers;
//   providers/companiesmarketcap: top companies list
// - db/: connection and repositories (read/write the tables in db/migrations)
// - refresh.js: fetch + save steps, used by jobs/daily-refresh.js and the app
// - jobs/: daily refresh, price alerts, news refresh, top companies
// - news/: RSS feeds, Comprehend enrichment, company matching, blocked publishers
// - alerts.js: alert thresholds and email format (shared with the app)
// - values.js, parsing.js: dates, symbols and value parsing
// - http.js: rate limiting and retry policy
// - errors.js: error hierarchy

module.exports = {
  ...require('./values'),
  ...require('./errors'),
  models: require('./models'),
  fetchers: require('./fetchers/base'),
  yahoo: require('./providers/yahoo'),
  db: { ...require('./db/connection'), repo: require('./db/repositories') },
  refresh: require('./refresh'),
};
