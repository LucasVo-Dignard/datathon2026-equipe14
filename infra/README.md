# Infra: EC2 web server (IP-restricted)

Terraform that creates:

- a VPC, a public subnet, an internet gateway and a route table
- a security group that allows inbound traffic **only from an IP allowlist**:
  your own IP (detected automatically) plus anything in `allowed_cidrs`
- a `t3.micro` Amazon Linux 2023 instance with an 8 GiB encrypted disk,
  IMDSv2 enforced, running the app container (`../app`, Node.js) on port 80
- a private ECR repository for the app image (`ecr.tf`), with pull access for
  the instance only and a lifecycle policy keeping the 10 latest images
- an Elastic IP, so the public IP never changes
- a generated SSH key (SSH stays closed unless `enable_ssh = true`)

## Security rules this follows

- **No security group open to the internet.** `0.0.0.0/0` (or any `/0`) is
  rejected by variable validation and a precondition.
- **No credentials in Git.** `.env-aws`, `*.tfvars`, `*.pem` and
  `*.tfstate` are gitignored. The state contains the generated private key,
  so it lives only in the private S3 bucket (see below), never in Git.
- **Private S3 only.** The one bucket (Terraform state) has all four Block
  Public Access settings on, versioning, encryption, and a policy that
  denies non-HTTPS access. No RDS or EMR resources.
- **Minimal resources.** One small instance. Stop it or destroy it when idle.

## Remote state

State is stored in `s3://datathon2026-equipe14-tfstate-779846826297/infra/terraform.tfstate`
for prod, and `env:/<name>/infra/terraform.tfstate` for each developer's
environment (see `../ENVIRONMENTS.md`). The same applies to the other stacks.
(configured in `backend.tf`), with S3-native locking so two people can't apply
at once. Anyone with the team's AWS credentials can run Terraform from their
own machine; there is no local state file to pass around.

The bucket was created once with `./bootstrap-state-bucket.sh` (safe to
re-run). It is not managed by Terraform and is **not** removed by
`terraform destroy`. Delete it manually at the end of the datathon, after
destroying everything else.

## Prerequisites

- Terraform >= 1.10 (`winget install Hashicorp.Terraform`)
- Optional: AWS CLI v2 (`winget install Amazon.AWSCLI`)

## Credentials

The AWS provider and CLI read the `AWS_*` variables in `../.env-aws`.
Load them into your shell (Git Bash) before running anything:

```bash
set -a; source ../.env-aws; set +a
aws sts get-caller-identity   # sanity check
```

The session token is temporary. Reload `.env-aws` when it expires.

## Usage

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # add teammates' IPs, etc.
terraform init
terraform plan
terraform apply
terraform output url
```

The chatbot needs a minute or two after boot to come up. Only the allowlisted IPs can
open the URL. If your IP changes (new network), run `terraform apply` again.

## Stopping and cleaning up

- Pause: set `instance_running = false` in `terraform.tfvars`, then
  `terraform apply`. The disk and the Elastic IP are kept. The Elastic IP
  is still billed (about $0.005/h) while the instance is stopped.
- Remove everything: `terraform destroy`.

## Deploying the app

The app ships as a Docker image (`../Dockerfile`) in ECR. `user_data` only
installs Docker and a systemd unit (`chatbot.service`) that logs in to ECR,
pulls the image and runs it, so the app's size no longer matters (the old
16 KB `user_data` limit is gone).

```bash
set -a; source ../.env-aws; set +a
./scripts/deploy-app.sh        # from the repo root
```

The script builds the image for `linux/amd64` (Docker with buildx needed; on a
Mac, `colima start --vm-type vz --vz-rosetta` works), pushes it with the git
SHA and `latest` tags, then restarts the service through SSM (no SSH). The
instance is **not** recreated, so the prototype data in `/var/lib/chatbot`
(users, sessions, chats) is kept.

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

Changing `user_data.sh.tftpl` or `app_image_tag` still recreates the instance
(same Elastic IP, data in `/var/lib/chatbot` reset).
