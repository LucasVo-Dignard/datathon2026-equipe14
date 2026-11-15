# Infra: Batch jobs (AWS Batch on Fargate)

A third Terraform stack, with its own state. It runs three scheduled jobs,
all from the same image and job definition:

- **Daily refresh**, weekdays after the market close:
  `node src/marketdata/jobs/daily-refresh.js` (see `../src/marketdata/`),
  which refreshes every active symbol in the `tracked_symbols` table: profile,
  metrics, price targets, analyst rating actions, recent prices and, if
  a Finnhub key is configured, news, earnings and recommendations. Symbols
  that aren't tracked are still loaded on demand by the app.
- **News refresh**, every 2 hours (`src/marketdata/jobs/news-refresh.js`).
- **Scheduled reports**, every hour (`app/jobs/scheduled-reports.js`).

> **On in prod, off in dev environments.** `schedule_enabled` pauses the
> daily and news schedules, and the reports schedule too unless
> `reports_schedule_enabled` is set. `refresh_enabled` (daily refresh only)
> defaults to `true` in prod and `false` elsewhere: when off, the daily job
> starts, logs `REFRESH_ENABLED is off: doing nothing` and exits 0, without
> touching the database or any provider. Override with `-var ...`. The news
> job reads `NEWS_ENABLED`, which Terraform does not set (so it is always on
> when it runs); the reports job has no switch.
>
> Order of a daily run: the price-alert subscribers' holdings are refreshed
> first, then the alerts are emailed (`price-alerts.js`) in the middle of the
> run, then the other tracked symbols. With ~1 000 tracked symbols (top
> companies) at 60 Yahoo calls/min, a full run takes about 2 h 15, so alerts
> never wait for it.

It creates (`<prefix>` is `datathon2026-equipe14` in prod and
`datathon2026-equipe14-<name>` in dev, see `../ENVIRONMENTS.md`):

- a private **ECR repository** `<prefix>-batch` for the job
  image (`ecr.tf`, same setup as the app's in `../infra/ecr.tf`: scan on
  push, keeps 10 images)
- an **AWS Batch** Fargate compute environment (max 1 vCPU, so up to four
  0.25 vCPU jobs at once), job queue and
  job definition (0.25 vCPU, 1 GiB, 1 retry; timeout 4 h in prod, 30 min in
  dev, `job_timeout_seconds`)
- an **EventBridge Scheduler** schedule, **daily refresh**: weekdays 18:00 `America/Toronto`
- a second schedule, **news refresh**, every 2 hours from 7:00 to 23:00
  `America/Toronto` (9 runs a day, `news_schedule_expression`): same job definition, command
  `src/marketdata/jobs/news-refresh.js`; the job role may call Amazon
  Comprehend's batch detect APIs (sentiment, entities)
  (prod only by default; paused in developer environments)
- a third schedule, **scheduled reports**, every hour (`reports_schedule_expression`,
  `reports_schedule_enabled`): command `app/jobs/scheduled-reports.js`. It
  writes the reports users set up with the assistant (table `report_schedules`,
  V13) into the reports bucket of `../infra` (`REPORTS_BUCKET`). The job role
  may call Claude in Amazon Bedrock and read/write `reports/*` in that bucket.
  Manual run: `--container-overrides '{"command":["app/jobs/scheduled-reports.js","--dry-run"]}'`
- a **security group** for the job, plus one ingress rule on the DB security
  group that allows it
- three IAM roles: execution (pull from the batch ECR repo, write to this
  job's log group), job (DB secret, Comprehend, SES, Bedrock, reports bucket),
  scheduler (submit this job definition only, for the three schedules)
- a CloudWatch log group (14 days), shared by the three jobs (all log under
  the `daily-refresh` stream prefix, the job definition's name)

The VPC, public subnet, RDS instance, DB security group, web server's Elastic
IP, reports bucket and SSM parameters `/<prefix>/alerts` are looked up by
name, so **apply `../infra` and `../infra-db` first**, and **destroy this
stack first**.

## How the job reaches the database

- **Network:** the job's security group is allowed on the DB port by the DB
  security group (security group reference, no CIDR). The job runs in the
  public subnet with a public IP so it can reach Yahoo, the RSS feeds and
  the AWS APIs (ECR, Secrets Manager, Comprehend, SES, Bedrock, S3) without
  a NAT gateway.
- **Credentials:** the job role may call `secretsmanager:GetSecretValue` on
  the RDS master secret only. The code reads the user name and password at
  runtime (`src/marketdata/db/connection.js`) and connects with TLS
  (encrypted, but the server certificate is not verified). Nothing is stored in the image, the job definition or
  the Terraform state.

## Security rules this follows

- The job's security group has **no inbound rules**: nothing can connect to
  it. Outbound is limited to HTTPS (443) and the DB port to the DB security
  group.
- RDS stays private: the new rule references a security group, not an IP
  range.
- No credentials in Git, in the image (`Dockerfile.dockerignore` is an
  allowlist: only `package*.json`, `src/` and `app/` without `app/data/` and
  `app/public/`) or in Terraform.
- Modest resources: Fargate runs only while a job runs (about 2 h 15 for a
  full daily refresh, a few minutes for each of the 9 daily news runs, a few
  seconds for an hourly reports run with nothing due); no NAT gateway, no
  Elastic IP, no idle instance.

## State

`s3://datathon2026-equipe14-tfstate-779846826297/infra-batch/terraform.tfstate`
for prod; `env:/<name>/infra-batch/terraform.tfstate` in the same bucket for a
dev environment.

## Usage

The database must have all the migrations applied (see `../db/README.md`).
From the repo root, with `TF_WORKSPACE` set in `.env-dev` (see
`../ENVIRONMENTS.md`):

```bash
set -a; source .env-aws; source .env-dev; set +a
terraform -chdir=infra-batch init
terraform -chdir=infra-batch plan
terraform -chdir=infra-batch apply
./scripts/deploy-batch.sh   # build the image, push it to ECR
```

For prod, use `TF_WORKSPACE=default` and add `-var confirm_prod=true` to
`plan` and `apply`.

The image is built from `infra-batch/Dockerfile` with the repo root as
context (the root `Dockerfile` is the web app's). `deploy-batch.sh` tags it
with the git SHA and `latest`, like `deploy-app.sh`. Deploy again after every
change to `src/` or `app/`: the jobs always run `latest`, so there is nothing to
restart.

Build and try it locally:

```bash
docker build -f infra-batch/Dockerfile -t marketdata-job .
docker run --rm -e DATABASE_URL=postgres://bncd_admin:localdev@host.docker.internal:5432/marketdata marketdata-job
# or without Docker:
DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata node src/marketdata/jobs/daily-refresh.js --symbols RY.TO NVDA
```

### Run it now (without waiting for the schedule)

```bash
aws batch submit-job --job-name manual-refresh \
  --job-queue "$(terraform -chdir=infra-batch output -raw job_queue)" \
  --job-definition "$(terraform -chdir=infra-batch output -raw job_definition)"
```

Add `--container-overrides '{"command":["src/marketdata/jobs/news-refresh.js"]}'`
for the news job.

### Logs

```bash
aws logs tail "$(terraform -chdir=infra-batch output -raw log_group)" --since 1d
```

Per-symbol failures are logged and saved in `tracked_symbols.last_error`; the
job still exits 0. It exits 1 (and Batch retries once) only when nothing
succeeded.

### Choosing what is refreshed

```sql
INSERT INTO tracked_symbols (symbol) VALUES ('DOL.TO');        -- follow
UPDATE tracked_symbols SET active = false WHERE symbol = 'L.TO'; -- stop
```

## Pausing and cleaning up

- Pause: apply with `-var schedule_enabled=false` (daily, news and, unless
  `reports_schedule_enabled` is set, reports), or put it in a `<name>.tfvars`
  file passed with `-var-file`. Not in `terraform.tfvars`: Terraform loads it
  in every workspace, prod included.
- Remove everything: `terraform -chdir=infra-batch destroy` (also deletes the images in ECR and
  the DB ingress rule for the job).

## Not done yet

- **Finnhub on AWS:** the Finnhub steps run only if `FINNHUB_API_KEY` is set.
  To enable them, store the key in Secrets Manager and add it to the job
  definition's `secrets` (with read access for the job role).
- **App user:** the job uses the RDS master user. A dedicated user with
  write access to the market data tables only would be safer.
