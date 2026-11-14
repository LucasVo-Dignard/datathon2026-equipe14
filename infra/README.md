# Infra: EC2 web server (IP-restricted)

Terraform that creates:

- a VPC, a public subnet, an internet gateway and a route table
- a security group that allows inbound traffic **only from an IP allowlist**:
  your own IP (detected automatically) plus anything in `allowed_cidrs`
- a `t3.micro` Amazon Linux 2023 instance with an 8 GiB encrypted disk,
  IMDSv2 enforced, running the chatbot (`../app`, Node.js) on port 80
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

## Updating the chatbot

The app in `../app` is embedded in the instance's `user_data`. Any change to
it makes `terraform apply` **recreate the instance**. The public IP stays the
same (Elastic IP), but the chat data (`/var/lib/chatbot/db.json`) is reset. Fine for a prototype.
