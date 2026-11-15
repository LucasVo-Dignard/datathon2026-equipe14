# Infra: EC2 web server (IP-restricted)

Terraform that creates (`<prefix>` is `datathon2026-equipe14` in prod and
`datathon2026-equipe14-<name>` in dev, see `../ENVIRONMENTS.md`):

- a VPC, a public subnet, an internet gateway and a route table
- a security group that allows inbound traffic **only from an IP allowlist**:
  `allowed_cidrs` (default: the Polytechnique network, `132.207.0.0/16`),
  plus the IP of the machine running `terraform apply` when `allow_my_ip` is
  on (default: on in dev environments, off in prod)
- a `t3.micro` Amazon Linux 2023 instance with an 8 GiB encrypted disk,
  IMDSv2 enforced, running the app container (`../app`, Node.js) on port 80
- a private ECR repository for the app image (`ecr.tf`), with pull access for
  the instance only and a lifecycle policy keeping the 10 latest images
- an Elastic IP, so the public IP never changes
- a generated SSH key (SSH stays closed unless `enable_ssh = true`)
- a private S3 bucket for the simulated reports (`reports.tf`), read and written
  by the web server only under `reports/`
- the web server's IAM role (`iam.tf`): SSM managed instance
  (`AmazonSSMManagedInstanceCore`, for deploys and migrations without SSH),
  ECR pull, the reports bucket, `bedrock-mantle:CreateInference` for the
  agent, and the AgentCore research/reviewer harnesses, research gateway and
  earnings knowledge base (created with the AWS CLI, see `../agents/README.md`)
- price alerts by email (`ses.tf`, unless `alerts_enabled = false`): an SES
  email identity, a configuration set `<prefix>-alerts`, the SSM parameter
  `/<prefix>/alerts/sender` read by `../infra-batch`, and the send permission
  for the web server

This stack creates no database: RDS is in `../infra-db`.

## Security rules this follows

- **No security group open to the internet.** `0.0.0.0/0` (or any `/0`) is
  rejected by variable validation and a precondition.
- **No credentials in Git.** `.env-aws`, `*.tfvars`, `*.pem` and
  `*.tfstate` are gitignored. The state contains the generated private key,
  so it lives only in the private S3 bucket (see below), never in Git.
- **Private S3 only.** Both buckets of this stack (Terraform state, reports) have all four Block
  Public Access settings on, encryption, and a policy that denies non-HTTPS
  access (the state bucket also has versioning). No RDS (that is
  `../infra-db`) and no EMR.
- **Minimal resources.** One small instance. Stop it or destroy it when idle.

## Remote state

State is stored in `s3://datathon2026-equipe14-tfstate-779846826297/infra/terraform.tfstate`
for prod, and `env:/<name>/infra/terraform.tfstate` for each developer's
environment (see `../ENVIRONMENTS.md`), as configured in `backend.tf`. The
other stacks use the same bucket. S3-native locking prevents two people from
applying at once. Anyone with the team's AWS credentials can run Terraform from their
own machine; there is no local state file to pass around.

The bucket was created once with `infra/bootstrap-state-bucket.sh` (safe to
re-run). It is not managed by Terraform and is **not** removed by
`terraform destroy`. Delete it manually at the end of the datathon, after
destroying everything else.

## Prerequisites

- Terraform >= 1.10 (`winget install Hashicorp.Terraform`)
- For the deploy scripts: a recent AWS CLI v2 (with the
  `bedrock-agentcore-control` commands; `winget install Amazon.AWSCLI`) and
  Docker with buildx

## Credentials

The AWS provider and CLI read the `AWS_*` variables in `.env-aws` (repo root),
and Terraform and the scripts read `TF_WORKSPACE` in `.env-dev` (see
`../ENVIRONMENTS.md`). Load both into your shell (Git Bash, from the repo
root) before running anything:

```bash
set -a; source .env-aws; source .env-dev; set +a
aws sts get-caller-identity   # sanity check
```

The session token is temporary. Reload `.env-aws` when it expires.

## Usage

```bash
terraform -chdir=infra init
terraform -chdir=infra plan
terraform -chdir=infra apply
terraform -chdir=infra output url
```

Override variables (teammates' IPs, etc.) with `-var`, or in a `<name>.tfvars`
file (gitignored, see `terraform.tfvars.example`) passed with
`-var-file=<name>.tfvars`. Don't use `terraform.tfvars`: Terraform loads it in
every workspace, prod included. For prod, use `TF_WORKSPACE=default` and add
`-var confirm_prod=true`.

The chatbot needs a minute or two after boot to come up. Only the allowlisted IPs can
open the URL. If your IP changes (new network) in a dev environment, run
`terraform -chdir=infra apply` again.

## Stopping and cleaning up

- Pause: apply with `-var instance_running=false`. The disk and the Elastic
  IP are kept. The Elastic IP
  is still billed (about $0.005/h) while the instance is stopped.
- Remove everything: `terraform -chdir=infra destroy`, after destroying
  `../infra-batch` and then `../infra-db`.

## Deploying the app

The app ships as a Docker image (`../Dockerfile`) in ECR. `user_data` only
installs Docker and a systemd unit (`chatbot.service`) that logs in to ECR,
pulls the image and runs it, so `user_data` stays small whatever the app's size.

```bash
./scripts/deploy-app.sh        # from the repo root, .env-aws and .env-dev loaded
```

The script builds the image for `linux/amd64` (on a
Mac, `colima start --vm-type vz --vz-rosetta` works), pushes it with the git
SHA and `latest` tags, then restarts the service through SSM (no SSH). The
instance is **not** recreated, so the files in `/var/lib/chatbot` (the app's
JSON fallback data when there is no database, and the Bigdata.com usage and
market files) are kept.

- Roll back: rerun the script from an older commit, or set `app_image_tag` to
  an older SHA and apply (that one recreates the instance).
- Database: before each start, `/usr/local/bin/chatbot-db-env` looks up this
  environment's RDS (`<prefix>-db`) and its master secret, and writes
  `DATABASE_URL` (TLS, certificate and hostname verified) to `/run/chatbot/db.env`
  (tmpfs, root only). No database yet: the app uses its JSON file. The
  permissions come from `../infra-db/app-access.tf`, so apply `infra-db` first,
  then restart the service (`./scripts/deploy-app.sh`).
- Other environment for the container goes in `/etc/chatbot.env` on the
  instance, never in Git.
- Right after a fresh instance boots, the service retries every 15 s until an
  image exists in ECR, so the order of apply and first deploy doesn't matter.

Changing `user_data.sh.tftpl` or `app_image_tag`, a new Amazon Linux 2023
AMI (the AMI is `most_recent`, so a plain apply can pick a newer one), or a
change to `alerts_enabled` / `alerts_sender_email` (they are in `user_data`)
recreates the instance: same Elastic IP, but `/var/lib/chatbot` is reset and
`/etc/chatbot.env` loses `REPORTS_BUCKET` and the `RESEARCH_*` settings, which
only `deploy-app.sh` writes. Run `./scripts/deploy-app.sh` after a replacement.
Check `plan` for `must be replaced` on `aws_instance.web` before applying.

## Price alerts by email (SES)

`ses.tf` sends the price-move alerts with Amazon SES, from the team mailbox:
`datathon2026.equipe14@gmail.com` in prod, `datathon2026.equipe14+<env>@gmail.com`
in the dev environments (one SES identity per environment, one inbox).

- After the first apply in an environment, SES emails a verification link to
  that address: someone with access to the team mailbox clicks it once, or
  nothing is sent. Check with
  `aws sesv2 get-email-identity --email-identity <address>`.
- Then apply `../infra-batch` (it reads the sender from SSM
  `/<prefix>/alerts/sender`), apply migration V8 and redeploy the app and the job.
- **SES sandbox**: while the account has no production access, SES only sends
  to verified addresses. The app handles it: on subscription it asks SES to
  verify the recipient (one click, AWS email). Once production access is
  granted (SES console, "Request production access"), recipients are active
  right away.
- Every email has a one-click unsubscribe link (`/desabonnement`, no login)
  and a `List-Unsubscribe` header. Bounces and complaints go to the SES
  suppression list (configuration set `<prefix>-alerts`, TLS required).
- `-var alerts_enabled=false` turns alerts off; `-var alerts_sender_email=...`
  overrides the sender.
