# Database migrations (Flyway)

The database schema is managed by [Flyway](https://documentation.red-gate.com/fd)
with plain SQL migration files in `migrations/`. Flyway runs in Docker
(`flyway/flyway:13`), so there is nothing to install besides Docker.

```
db/
├── flyway.toml           shared settings (no host, user or password)
├── docker-compose.yml    local Postgres 17 + Flyway
├── migrate.py            runs Flyway against an environment's RDS (see below)
└── migrations/
    ├── V1__create_market_data_tables.sql
    ├── ...
    └── V14__drop_macro_observations.sql
```

## Current schema

| Tables | Created by |
| --- | --- |
| `company_profiles`, `price_bars`, `financial_metrics`, `news_articles`, `earnings_events`, `recommendation_trends` (market data) | V1 |
| `price_target_consensus`, `analyst_rating_actions` | V2 |
| `tracked_symbols` | V3 |
| `investor_profiles` | V4 |
| `portfolios`, `portfolio_holdings` | V7 |
| `notification_subscriptions`, `price_alerts_sent` | V8 |
| `chats`, `chat_messages` | V9 |
| `news_items`, `news_item_symbols` | V10 |
| `fund_compositions` | V11 |
| `users`, `sessions` | V12 |
| `report_preferences`, `report_schedules` | V13 |

`macro_observations` (V5, V6) was dropped in V14. Comments in the older
migrations describe the schema at the time they were written; later
migrations may have changed it (V12, for example, links the user tables to
`users`).

## Writing a migration

- Name: `V<version>__<description>.sql`, e.g. `V15__add_fetch_log.sql`: one
  more than the highest version on `main` (check before picking a number).
  Two underscores. Versions only go up.
- **Never edit a migration that has been applied** to RDS. Flyway stores a
  checksum of each applied file and refuses to run if one changes. Fix
  mistakes with a new migration.
- One logical change per file. Keep the SQL PostgreSQL 17 compatible.
- `flyway clean` is disabled (`cleanDisabled = true`) so nobody can drop the
  schema by accident.

## Local development

```bash
cd db
docker compose up -d postgres                  # Postgres 17 on 127.0.0.1:5432
docker compose run --rm flyway migrate         # apply pending migrations
docker compose run --rm flyway info            # show applied / pending
docker compose down                            # stop (add -v to delete data)
```

In Git Bash, prefix the `run` commands with `MSYS_NO_PATHCONV=1` if Docker
complains about paths. The local password is a throwaway (`localdev`, or
`LOCAL_DB_PASSWORD`). It is not an AWS credential.

For the Postgres tests (`TEST_DATABASE_URL`, see `tests/`), use a separate
throwaway database rather than the one you develop with, e.g.:

```bash
docker compose exec postgres createdb -U bncd_admin marketdata_test
docker compose run --rm -e FLYWAY_URL=jdbc:postgresql://postgres:5432/marketdata_test flyway migrate
# then, from the repo root:
TEST_DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata_test npm test
```

## Running against RDS

From the repo root:

```bash
python db/migrate.py info       # show applied / pending, change nothing
python db/migrate.py            # apply pending migrations (same as `migrate`)
python db/migrate.py validate   # check applied files were not edited
python db/migrate.py repair     # accept the new checksum of an edited applied file
python db/migrate.py --env prod info   # another environment than $TF_WORKSPACE
```

The target environment comes from `--env` or `TF_WORKSPACE` (in `.env-dev`,
see `../ENVIRONMENTS.md`; `default` means prod); there is no default, so prod
is only migrated when named. Migrate your own environment; migrate prod only
when asked, from an up-to-date `main`.

`repair` is only for when `validate` (or `migrate`) fails on a checksum
mismatch because an applied file was edited anyway, typically a comment or
whitespace change: restore the file if you can, otherwise run `repair` after
checking the SQL itself did not change. It also removes failed migrations from
the history table.

The script needs Python 3.11 or later with boto3 (`pip install boto3`, e.g. in
a `.venv`). It reads the AWS credentials from `.env-aws` and `TF_WORKSPACE`
from `.env-dev` itself. The environment's web server must be running and its
RDS database `available` (the script checks both). When you add a migration:

1. Write `migrations/V<n>__<description>.sql`.
2. Test it locally, in `db/`: `docker compose run --rm flyway migrate`.
3. From the repo root, run `python db/migrate.py info`, then `python db/migrate.py`.
4. Commit the migration.

How it works: the database is private and only the web server can reach it.
The script uploads `flyway.toml` and `migrations/` to the environment's private bucket
`datathon2026-equipe14[-<env>]-migrations-<account>` (bundles expire after 7 days),
then uses AWS Systems Manager to run Flyway in Docker on the web server.
The server reads the DB password from Secrets Manager; it is never printed or
written to disk. No SSH and no open port are needed. It needs
`../infra` (server IAM role) and `../infra-db` (bucket and permissions) applied.

If two people run it at the same time, Flyway locks the schema history table,
so one waits for the other.
