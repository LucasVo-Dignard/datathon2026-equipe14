'use strict';
// Market data fetching for the BNCD info tool.
//
// Layout:
// - models.js: provider-independent data shapes (one per table)
// - fetchers/base.js: abstract interfaces, one per kind of data
// - providers/yahoo, providers/finnhub: client, mappers and concrete fetchers
// - db/: connection and repositories (read/write the tables in db/migrations)
// - refresh.js: fetch + save steps, used by jobs/daily-refresh.js and the app
// - http.js: rate limiting and retry policy
// - errors.js: error hierarchy

module.exports = {
  ...require('./values'),
  ...require('./errors'),
  models: require('./models'),
  fetchers: require('./fetchers/base'),
  yahoo: require('./providers/yahoo'),
  finnhub: require('./providers/finnhub'),
  db: { ...require('./db/connection'), repo: require('./db/repositories') },
  refresh: require('./refresh'),
};
