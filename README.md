# datathon2026-equipe14

Each developer has their own AWS environment (EC2, RDS, Batch), separate from
prod: see [ENVIRONMENTS.md](ENVIRONMENTS.md).

## `marketdata` package (Python)

Fetchers for Yahoo Finance and Finnhub that return provider-independent models
(`src/marketdata/models.py`). Data is loaded lazily: the app checks RDS first and
only calls a fetcher when the data is missing or stale.

```bash
python -m venv .venv
.venv/Scripts/pip install -e ".[dev]"      # .venv/bin/pip on macOS/Linux
.venv/Scripts/python -m pytest
.venv/Scripts/python -m marketdata NVDA --days 30
```

Finnhub needs an API key in `.env-finnhub` (gitignored by `.env*`):

```bash
echo 'FINNHUB_API_KEY=your-key' > .env-finnhub
set -a; source .env-finnhub; set +a
```

### Design

| Layer | Where | Responsibility |
| --- | --- | --- |
| Models | `models.py` | Provider-independent data types, one per future table |
| Interfaces | `fetchers/base.py` | One abstract class per kind of data (`ProfileFetcher`, `PriceHistoryFetcher`, `MetricsFetcher`, `NewsFetcher`, `EarningsFetcher`, `RecommendationFetcher`) |
| Clients | `providers/*/client.py` | Transport only: auth, rate limit, retries, errors |
| Mappers | `providers/*/mappers.py` | Raw provider data → models, unit conversion |
| Fetchers | `providers/*/fetchers.py` | One class per (provider, kind), e.g. `FinnhubNewsFetcher(FinnhubFetcher, NewsFetcher)` |

| Kind | Yahoo | Finnhub |
| --- | --- | --- |
| Profile | ✓ | ✓ |
| Metrics | ✓ | ✓ |
| Daily prices | ✓ | |
| News | | ✓ |
| Earnings | | ✓ |
| Analyst recommendations | | ✓ |

To add a provider, write a client, mappers, and a `XFetcher(Fetcher)` base,
then subclass it with the kinds the provider supports.
