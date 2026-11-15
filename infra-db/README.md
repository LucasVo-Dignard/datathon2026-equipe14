# Infra: RDS database (private)

A separate Terraform stack for the database, with its own state, so the web
server (`../infra`) and the database can be applied or destroyed on their own.

It creates, inside the existing `../infra` VPC (`<prefix>` is
`datathon2026-equipe14` in prod and `datathon2026-equipe14-<name>` in dev, see
`../ENVIRONMENTS.md`):

- two private subnets (`10.0.101.0/24`, `10.0.102.0/24`) in two availability
  zones, with no route to the internet
- a DB subnet group (RDS requires two availability zones)
- a security group that allows the DB port **only from the web server's
  security group**: no CIDR rules at all. `../infra-batch` adds one more
  security-group rule for its Batch jobs, and removes it on destroy.
- one PostgreSQL 17 instance `<prefix>-db` (`db.t4g.small`, 20 GiB gp3, encrypted, single-AZ,
  `publicly_accessible = false`)
- a private S3 bucket `<prefix>-migrations-<account>` for the migration
  bundles of `../db/migrate.py` (`migrations.tf`, bundles expire after 7
  days; see `../db/README.md`)
- two policies on the web server's role: read the DB secret and the migration
  bundles (`migrations.tf`), and describe this DB and read its secret so the
  app can build its `DATABASE_URL` (`app-access.tf`)

The VPC, web security group and web server's IAM role are looked up by name
(`<prefix>-vpc`, `<prefix>-web`), so **`../infra` must
be applied first**. This stack never reads or changes `../infra`'s state.

## Security rules this follows

- **No public RDS.** `publicly_accessible = false`, private subnets only,
  and no inbound rule from any IP range.
- **No credentials in Git or in Terraform.** `manage_master_user_password = true`:
  RDS generates the master password and stores it in Secrets Manager. It is
  not in the code, the variables or the state.
- **Modest resources.** `db.t4g.small`, 20 GiB, single-AZ, no
  Performance Insights, no enhanced monitoring, Extended Support disabled.

## State

`s3://datathon2026-equipe14-tfstate-779846826297/infra-db/terraform.tfstate`
for prod, `env:/<name>/infra-db/terraform.tfstate` for a dev environment
(same private bucket as `../infra`, different key).

## Usage

From the repo root, with `.env-aws` and `.env-dev` (`TF_WORKSPACE`, see
`../ENVIRONMENTS.md`):

```bash
set -a; source .env-aws; source .env-dev; set +a
terraform -chdir=infra-db init
terraform -chdir=infra-db plan
terraform -chdir=infra-db apply    # creating the instance takes about 5-10 minutes
terraform -chdir=infra-db output
python db/migrate.py               # schema, see ../db/README.md
```

For prod, use `TF_WORKSPACE=default` and add `-var confirm_prod=true`.
Override the size etc. with `-var` or a `<name>.tfvars` file passed with
`-var-file` (see `terraform.tfvars.example`), not `terraform.tfvars`, which
Terraform loads in every workspace, prod included.

Only PostgreSQL is supported: the variable still accepts `engine = "mysql"`,
but the migrations (`../db`), the app and the Batch jobs are PostgreSQL-only.

## Getting the password

```bash
aws secretsmanager get-secret-value \
  --secret-id "$(terraform -chdir=infra-db output -raw master_secret_arn)" \
  --query SecretString --output text
```

Don't copy it into files in the repo. The web app reads it from Secrets
Manager at runtime: `app-access.tf` lets the web server describe this DB and
read this secret, and the server builds the app's `DATABASE_URL` before each
start (see `../infra/README.md`, "Deploying the app").

## Connecting

The database is reachable only from the web server (and anything else we add
to the DB security group later). From a laptop, go through the web server with
an SSH tunnel: apply `../infra` with `-var enable_ssh=true`, then:

```bash
ssh -i infra/<prefix>-key.pem -N \
  -L 5432:"$(terraform -chdir=infra-db output -raw endpoint)":5432 \
  ec2-user@"$(terraform -chdir=infra output -raw public_ip)"
# then connect to localhost:5432
```

Turn SSH off again when you are done (apply `../infra` without it).

## Stopping and cleaning up

- Pause: `aws rds stop-db-instance --db-instance-identifier <prefix>-db`
  (prod: `datathon2026-equipe14-db`).
  Storage is still billed, and AWS starts the instance again automatically
  after 7 days.
- Remove everything: `terraform -chdir=infra-db destroy`, after destroying
  `../infra-batch`. There is **no final snapshot**
  (`skip_final_snapshot = true`), so the data is lost. Destroy this stack
  before `../infra`, since it lives in that VPC.
