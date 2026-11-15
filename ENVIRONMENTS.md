# Environments

One AWS account, four environments. Each has its own VPC, EC2 web server
(with its own Elastic IP), RDS database, migrations bucket, reports bucket,
SES sender identity, ECR repositories and Batch jobs. The research agents
(AgentCore, see `agents/README.md`) exist only in `andre` and prod:

| Environment | Terraform workspace | Resource names |
| --- | --- | --- |
| prod | `default` | `datathon2026-equipe14-*` |
| Lucas | `lucas` | `datathon2026-equipe14-lucas-*` |
| André | `andre` | `datathon2026-equipe14-andre-*` |
| Youcef | `youcef` | `datathon2026-equipe14-youcef-*` |

The workspace is chosen by the `TF_WORKSPACE` environment variable, which
Terraform, `db/migrate.py` and `scripts/deploy-*.sh` all read. Each workspace
has its own state in the same bucket (`env:/<name>/<stack>/terraform.tfstate`;
prod keeps `<stack>/terraform.tfstate`). The naming rule and the guards are in
`infra*/env.tf`.

## Setup (once)

```bash
cp .env-dev.example .env-dev     # set TF_WORKSPACE=lucas (or andre, youcef)
```

`.env-dev` is gitignored. Load it with the AWS credentials, in Git Bash:

```bash
set -a; source .env-aws; source .env-dev; set +a
```

## Create your environment

Same order as always (infra, infra-db, infra-batch). The first `apply` of
`infra-db` takes about 5-10 minutes.

```bash
terraform -chdir=infra init && terraform -chdir=infra apply
terraform -chdir=infra-db init && terraform -chdir=infra-db apply
python db/migrate.py                  # schema on your RDS
./scripts/deploy-app.sh               # app image on your web server
terraform -chdir=infra-batch init && terraform -chdir=infra-batch apply
bash scripts/deploy-batch.sh          # job image
terraform -chdir=infra output url
```

Dev environments differ from prod only in their defaults:

- `allow_my_ip` is on: the IP of the machine running `terraform apply` is
  allowed, in addition to `allowed_cidrs` (Polytechnique). Apply `infra` again
  when you change network.
- All schedules (refresh, news, reports) are off (`schedule_enabled`), and so
  is `refresh_enabled`: a daily refresh run by hand does nothing unless
  `infra-batch` is applied with `-var refresh_enabled=true`. The news and
  reports jobs can be run by hand (see `infra-batch/README.md`).
- The database starts empty, apart from the migrations.

Override anything with `-var` or a `<name>.tfvars` file (gitignored) passed
with `-var-file`. Don't use `terraform.tfvars`: Terraform loads it in every
workspace, prod included.

## Working on prod

Prod is the `default` workspace. Terraform refuses to plan or apply it unless
asked by name:

```bash
TF_WORKSPACE=default terraform -chdir=infra plan -var confirm_prod=true
TF_WORKSPACE=default ./scripts/deploy-app.sh
python db/migrate.py --env prod info
```

Without `TF_WORKSPACE`, Terraform also selects `default` and fails on the
`confirm_prod` check, and the scripts refuse to run, so a forgotten `.env-dev`
never touches prod. An unknown name (a typo) is rejected too.

## Cost and cleanup

Left running, an environment costs about $37/month (RDS ~$26, EC2 ~$7.50,
Elastic IP ~$3.60). Stop what you don't use:

- EC2: `-var instance_running=false` on `infra` (the Elastic IP is still billed).
- RDS: `aws rds stop-db-instance --db-instance-identifier datathon2026-equipe14-<name>-db`
  (AWS restarts it after 7 days).
- Everything: `terraform destroy` in `infra-batch`, then `infra-db`, then `infra`.

Adding a developer: add the name to `dev_environments` in the three
`infra*/env.tf` and to `ENVIRONMENTS` in `db/migrate.py`.
