# datathon2026-equipe14

Each developer has their own AWS environment (EC2, RDS, Batch), separate from
prod: see [ENVIRONMENTS.md](ENVIRONMENTS.md).

## `marketdata` package (`src/marketdata`, Node.js)

Fetchers for Yahoo Finance (through [`yahoo-finance2`](https://www.npmjs.com/package/yahoo-finance2))
and Finnhub that return provider-independent models (`src/marketdata/models.js`).
Data is loaded lazily: the app checks RDS first and only calls a fetcher when
the data is missing or stale (see `app/stocks.js`). The same code runs the
daily refresh job (`jobs/daily-refresh.js`, see `infra-batch/`).

```bash
npm install
npm test                                  # all tests (DB tests need TEST_DATABASE_URL)
node src/marketdata/cli.js NVDA --days 30 # try the fetchers
```

Finnhub needs an API key in `.env-finnhub` (gitignored by `.env*`):

```bash
echo 'FINNHUB_API_KEY=your-key' > .env-finnhub
set -a; source .env-finnhub; set +a
```

DB tests run against the local Docker Postgres with the migrations applied
(see `db/README.md`). They only touch rows of the fake symbol `ZZTEST.TO`:

```bash
TEST_DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata node --test tests/marketdata-db.test.js
```

### Design

| Layer | Where | Responsibility |
| --- | --- | --- |
| Models | `models.js` | Provider-independent data shapes, one per table |
| Interfaces | `fetchers/base.js` | One abstract class per kind of data (`ProfileFetcher`, `PriceHistoryFetcher`, `MetricsFetcher`, `NewsFetcher`, `EarningsFetcher`, `RecommendationFetcher`, `PriceTargetFetcher`, `RatingActionFetcher`) |
| Clients | `providers/*/client.js` | Transport only: auth, rate limit, retries, errors |
| Mappers | `providers/*/mappers.js` | Raw provider data → models, unit conversion |
| Fetchers | `providers/*/index.js` | One class per (provider, kind), e.g. `class FinnhubNewsFetcher extends NewsFetcher` |
| Storage | `db/` | Connection (local URL or Secrets Manager on AWS) and one save function per model |
| Refresh | `refresh.js` | Fetch + save steps, one transaction per (symbol, step) |

| Kind | Yahoo | Finnhub |
| --- | --- | --- |
| Profile | ✓ | ✓ |
| Metrics | ✓ | ✓ |
| Daily prices | ✓ | |
| Price target consensus | ✓ | |
| Analyst rating actions | ✓ | |
| News | | ✓ |
| Earnings | | ✓ |
| Analyst recommendations | | ✓ |

Dates are `"YYYY-MM-DD"` strings; instants (`fetchedAt`, `publishedAt`,
`gradedAt`) are `Date` objects. To add a provider, write a client and mappers,
then one class per kind it supports, extending the kind and setting
`static provider`.

### Macro data (World Bank)

`providers/worldbank` fetches yearly indicators (GDP growth, inflation,
unemployment, ...) from the free World Bank API (no key) into
`macro_observations` (migration V5). Values are as published: percentages stay
percentages (2.1 = 2.1%). Defaults are in `providers/worldbank/index.js`
(`DEFAULT_INDICATORS`, `DEFAULT_COUNTRIES`); indicator codes are listed at
<https://data.worldbank.org/indicator>.

```bash
node src/marketdata/jobs/macro-refresh.js --dry-run --countries CAN USA --years 5   # print only
DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata \
    node src/marketdata/jobs/macro-refresh.js                                     # save to the DB
```

The API is slow and sometimes answers 502; the client retries.

### Top companies by market cap

`providers/companiesmarketcap` downloads the global ranking published by
companiesmarketcap.com (one CSV, no key, market caps in USD, Yahoo-style
symbols). `jobs/populate-top-companies.js` takes the top N, saves each Yahoo
profile in `company_profiles` and adds the symbol to `tracked_symbols`.
Symbols Yahoo doesn't know are skipped.

```bash
node src/marketdata/jobs/populate-top-companies.js --dry-run              # print the list only
DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata \
    node src/marketdata/jobs/populate-top-companies.js [--limit 1000] [--skip-existing]
```

This job allows 60 Yahoo calls a minute (the daily job: 30), so 1000 companies
take about 17 minutes;
`--skip-existing` resumes an interrupted run.
