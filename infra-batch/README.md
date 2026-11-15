# Infra: daily refresh job (AWS Batch on Fargate)

A third Terraform stack, with its own state. Once a day it runs
`node src/marketdata/jobs/daily-refresh.js` (see `../src/marketdata/`),
which refreshes every active symbol in the `tracked_symbols` table: profile,
metrics, price targets, analyst rating actions, recent prices and, if
a Finnhub key is configured, news, earnings and recommendations. Symbols
that aren't tracked are still loaded on demand by the app.

> **Currently disabled.** `refresh_enabled` defaults to `false`: the job
> starts, logs `REFRESH_ENABLED is off: doing nothing` and exits 0, without
> touching the database or any provider. Set `refresh_enabled = true` in
> `terraform.tfvars` and apply to turn it on.

It creates:

- a private **ECR repository** `datathon2026-equipe14-batch` for the job
  image (`ecr.tf`, same setup as the app's in `../infra/ecr.tf`: scan on
  push, keeps 10 images)
- an **AWS Batch** Fargate compute environment (max 1 vCPU), job queue and
  job definition (0.25 vCPU, 1 GiB, 30 min timeout, 1 retry)
- an **EventBridge Scheduler** schedule: weekdays 18:00 `America/Toronto`
  (prod only by default; paused in developer environments)
- a **security group** for the job, plus one ingress rule on the DB security
  group that allows it
- three IAM roles: execution (pull from the batch ECR repo, write to this
  job's log group), job (read the DB secret only), scheduler (submit this
  job only)
- a CloudWatch log group (14 days)

The VPC, public subnet, RDS instance and DB security group are looked up by
name, so **apply `../infra` and `../infra-db` first**, and **destroy this
stack first**.

## How the job reaches the database

- **Network:** the job's security group is allowed on the DB port by the DB
  security group (security group reference, no CIDR). The job runs in the
  public subnet with a public IP so it can reach Yahoo, ECR and Secrets
  Manager without a NAT gateway.
- **Credentials:** the job role may call `secretsmanager:GetSecretValue` on
  the RDS master secret only. The code reads the user name and password at
  runtime (`src/marketdata/db/connection.js`) and connects with TLS. Nothing is stored in the image, the job definition or
  the Terraform state.

## Security rules this follows

- The job's security group has **no inbound rules**: nothing can connect to
  it. Outbound is limited to HTTPS (443) and the DB port to the DB security
  group.
- RDS stays private: the new rule references a security group, not an IP
  range.
- No credentials in Git, in the image (`Dockerfile.dockerignore` is an
  allowlist: only `package*.json` and `src/`) or in Terraform.
- Modest resources: Fargate runs only while the job runs (a few minutes a
  day); no NAT gateway, no Elastic IP, no idle instance.

## State

`s3://datathon2026-equipe14-tfstate-779846826297/infra-batch/terraform.tfstate`

## Usage

The database must have migrations V1 to V3 applied (see `../db/README.md`).

```bash
set -a; source ../.env-aws; set +a
cd infra-batch
terraform init
terraform plan
terraform apply
cd .. && ./scripts/deploy-batch.sh   # build the image, push it to ECR
```

The image is built from `infra-batch/Dockerfile` with the repo root as
context (the root `Dockerfile` is the web app's). `deploy-batch.sh` tags it
with the git SHA and `latest`, like `deploy-app.sh`. Deploy again after every
change to `src/`: the job always runs `latest`, so there is nothing to
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
  --job-queue "$(terraform output -raw job_queue)" \
  --job-definition "$(terraform output -raw job_definition)"
```

### Logs

```bash
aws logs tail "$(terraform output -raw log_group)" --since 1d
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

- Pause: `schedule_enabled = false` in `terraform.tfvars`, then apply.
- Remove everything: `terraform destroy` (also deletes the images in ECR and
  the DB ingress rule for the job).

## Not done yet

- **Finnhub on AWS:** the Finnhub steps run only if `FINNHUB_API_KEY` is set.
  To enable them, store the key in Secrets Manager and add it to the job
  definition's `secrets` (with read access for the job role).
- **App user:** the job uses the RDS master user. A dedicated user with
  write access to the market data tables only would be safer.
