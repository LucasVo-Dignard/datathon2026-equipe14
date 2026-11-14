# Database migrations (Flyway)

The database schema is managed by [Flyway](https://documentation.red-gate.com/fd)
with plain SQL migration files in `migrations/`. Flyway runs in Docker
(`flyway/flyway:13`), so there is nothing to install besides Docker.

```
db/
├── flyway.toml           shared settings (no host, user or password)
├── docker-compose.yml    local Postgres 17 + Flyway
└── migrations/
    └── V1__create_market_data_tables.sql
```

## Writing a migration

- Name: `V<version>__<description>.sql`, e.g. `V2__add_fetch_log.sql`.
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

## Running against RDS

```bash
python db/migrate.py info       # show applied / pending, change nothing
python db/migrate.py            # apply pending migrations (same as `migrate`)
python db/migrate.py validate   # check applied files were not edited
```

Use the repo's `.venv` (`pip install -e ".[ops]"` installs boto3). The script
reads the AWS credentials from `.env-aws` itself. When you add a migration:

1. Write `migrations/V<n>__<description>.sql`.
2. Test it locally: `docker compose run --rm flyway migrate`.
3. Run `python db/migrate.py info`, then `python db/migrate.py`.
4. Commit the migration.

How it works: the database is private and only the web server can reach it.
The script uploads `flyway.toml` and `migrations/` to the private bucket
`datathon2026-equipe14-migrations-<account>` (bundles expire after 7 days),
then uses AWS Systems Manager to run Flyway in Docker on the web server.
The server reads the DB password from Secrets Manager; it is never printed or
written to disk. No SSH and no open port are needed. It needs
`../infra` (server IAM role) and `../infra-db` (bucket and permissions) applied.

If two people run it at the same time, Flyway locks the schema history table,
so one waits for the other.
