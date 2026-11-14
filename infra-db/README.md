# Infra: RDS database (private)

A separate Terraform stack for the database, with its own state, so the web
server (`../infra`) and the database can be applied or destroyed on their own.

It creates, inside the existing `../infra` VPC:

- two private subnets (`10.0.101.0/24`, `10.0.102.0/24`) in two availability
  zones, with no route to the internet
- a DB subnet group (RDS requires two availability zones)
- a security group that allows the DB port **only from the web server's
  security group**: no CIDR rules at all. `../infra-batch` adds one more
  security-group rule for the daily refresh job, and removes it on destroy.
- one PostgreSQL 17 instance (`db.t4g.small`, 20 GiB gp3, encrypted, single-AZ,
  `publicly_accessible = false`)

The VPC and web security group are looked up by name
(`datathon2026-equipe14-vpc`, `datathon2026-equipe14-web`), so **`../infra` must
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
(same private bucket as `../infra`, different key).

## Usage

```bash
set -a; source ../.env-aws; set +a
cd infra-db
cp terraform.tfvars.example terraform.tfvars   # optional: engine, size
terraform init
terraform plan
terraform apply          # creating the instance takes about 5-10 minutes
terraform output
```

To switch to MySQL, set `engine = "mysql"` before the first apply.

## Getting the password

```bash
aws secretsmanager get-secret-value \
  --secret-id "$(terraform output -raw master_secret_arn)" \
  --query SecretString --output text
```

Don't copy it into files in the repo. The web app reads it from Secrets
Manager at runtime: `app-access.tf` lets the web server describe this DB and
read this secret, and the server builds the app's `DATABASE_URL` before each
start (see `../infra/README.md`, "Deploying the app").

## Connecting

The database is reachable only from the web server (and anything else we add
to the DB security group later). From a laptop, go through the web server with
an SSH tunnel: set `enable_ssh = true` in `../infra/terraform.tfvars`, apply
`../infra`, then:

```bash
ssh -i ../infra/datathon2026-equipe14-<env>-key.pem -N \
  -L 5432:"$(terraform output -raw endpoint)":5432 \
  ec2-user@"$(terraform -chdir=../infra output -raw public_ip)"
# then connect to localhost:5432
```

Turn SSH off again when you are done.

## Stopping and cleaning up

- Pause: `aws rds stop-db-instance --db-instance-identifier datathon2026-equipe14-<env>-db`
  (prod: `datathon2026-equipe14-db`).
  Storage is still billed, and AWS starts the instance again automatically
  after 7 days.
- Remove everything: `terraform destroy`. There is **no final snapshot**
  (`skip_final_snapshot = true`), so the data is lost. Destroy this stack
  before `../infra`, since it lives in that VPC.
