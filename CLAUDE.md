# CLAUDE.md

## The project

This project is for a hackathon. We are using AWS to make a tool that users from Banque Nationale Courtage Direct can use. The primary goal is to give people with limited time or knowledge **information**. This information can be reports (weekly, monthly, yearly), notifications about news or fundamentals or changes and more.

## AWS security rules (mandatory)

These rules come from the datathon organizers. Never break them, even if a task
seems to require it. If a request conflicts with them, stop and ask.

1. **NE CRÉEZ PAS de bucket S3 sans restriction d'accès.** Gardez S3 Block
   Public Access activé, ce qui est le réglage par défaut.
   - Never disable Block Public Access, add public bucket policies or ACLs, or
     enable static website hosting on a bucket.
2. **NE CRÉEZ PAS d'instance EC2 avec un groupe de sécurité ouvert à Internet.**
   - No inbound rule with `0.0.0.0/0` or `::/0`, on any port.
   - Inbound traffic is allowed only from an explicit IP allowlist
     (`allowed_cidrs` in `infra/`). It currently allows the `132.207.0.0/16`
     network range, plus `/32` addresses for individual machines when needed.
     Any range narrower than `/0` is acceptable if the team asked for it.
   - Databases (`infra-db/`) have no CIDR rules at all: they accept traffic
     only from the web server's security group and the daily batch job's
     security group (rule owned by `infra-batch/`).
   - Outbound `0.0.0.0/0` is fine, since it doesn't allow anything in.
3. **NE CRÉEZ PAS d'instance RDS ni de cluster EMR avec l'accès public activé.**
   - `publicly_accessible = false` for RDS. Keep EMR in private subnets with
     no public master node.
4. **NE METTEZ PAS d'identifiants AWS dans un dépôt Git.** Si une clé d'accès se
   retrouve sur GitHub, considérez qu'elle est compromise en quelques minutes.
   - Credentials live only in `.env-aws` (gitignored by `.env*`). Never print
     their values, copy them into other files, or hardcode them in code or
     Terraform.
   - Also never commit `*.tfstate`, `*.tfvars` or `*.pem`. The Terraform state
     contains the generated SSH private key. It is stored only in the private
     S3 state bucket (see `infra/backend.tf`).
   - Before any commit, check that `git status` and the diff contain no secrets.
5. **LIMITEZ les ressources que vous lancez à ce dont votre projet a vraiment
   besoin, et arrêtez tout ce que vous n'utilisez pas.**
   - Keep instance and disk sizes modest: `t3.micro` and 8 GiB for EC2,
     `db.t4g.small` and 20 GiB for RDS. Don't go bigger without a reason.
     Skip extras that cost money while idle, such as Elastic IPs and NAT
     gateways, unless we actually need them.
   - Stop idle instances (`instance_running = false`) or `terraform destroy`.

Always ask before `terraform apply`, `terraform destroy`, or any command that
creates or deletes AWS resources.

## Using AWS from this repo

- Load credentials in Git Bash: `set -a; source .env-aws; set +a`
  (temporary session token: reload when it expires).
- Region: `us-east-1`.
- Infrastructure is Terraform, in three stacks with separate states:
  `infra/` (VPC, EC2 web server), `infra-db/` (private RDS) and
  `infra-batch/` (daily refresh job on AWS Batch Fargate). See each folder's
  README. Apply in that order; destroy in reverse (`infra-batch/` first).
- Environments (see `ENVIRONMENTS.md`): prod is the `default` Terraform
  workspace; each developer has their own (`lucas`, `andre`, `youcef`), with
  its own VPC, EC2, RDS and Batch job, selected by `TF_WORKSPACE` in
  `.env-dev`. Work in a dev environment by default. Prod needs
  `-var confirm_prod=true` (Terraform), `--env prod` (`db/migrate.py`) or
  `TF_WORKSPACE=default` (scripts): only touch it when asked.
- Terraform does not deploy app code. After changing the app (`app/`, `src/`,
  `package.json`, `Dockerfile`), redeploy it to the dev server with
  `./scripts/deploy-app.sh` (builds the image, pushes it to ECR and restarts
  the container on the EC2), then check it works. Batch job changes go
  through `./scripts/deploy-batch.sh`.
- Terraform state: S3 bucket `datathon2026-equipe14-tfstate-779846826297`
  (created by `infra/bootstrap-state-bucket.sh`, not by Terraform, so
  `terraform destroy` does not delete it).

## Database

- RDS PostgreSQL 17 (`infra-db/`). Data is loaded on demand: check the DB
  first, call a fetcher (`src/marketdata`, Node.js) only if data is missing or stale
  (the stock search does this in `app/stocks.js`).
  Exception: symbols in `tracked_symbols` are refreshed every weekday by the
  batch job (`src/marketdata/jobs/daily-refresh.js`, `infra-batch/`), so
  changes can be detected for notifications. Keep that list small. Scheduled
  work does not run on the EC2 web server.
- Schema changes go only through Flyway migrations in `db/migrations/`
  (`V<n>__<description>.sql`). Never edit a migration that has been applied;
  add a new one. See `db/README.md`.
- Test migrations locally first: `cd db && docker compose up -d postgres &&
  docker compose run --rm flyway migrate`.
- Apply them to RDS with `python db/migrate.py` (runs Flyway on the web
  server through SSM; `info` first to preview). No GitHub Actions: we don't
  have the credits.
