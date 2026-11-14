# Infra: EC2 web server (IP-restricted)

Terraform that creates:

- a VPC, a public subnet, an internet gateway and a route table
- a security group that allows inbound traffic **only from an IP allowlist**:
  your own IP (detected automatically) plus anything in `allowed_cidrs`
- a `t3.micro` Amazon Linux 2023 instance with an 8 GiB encrypted disk,
  IMDSv2 enforced, running nginx on port 80
- a generated SSH key (SSH stays closed unless `enable_ssh = true`)

## Security rules this follows

- **No security group open to the internet.** `0.0.0.0/0` (or any `/0`) is
  rejected by variable validation and a precondition.
- **No credentials in Git.** `.env-aws`, `*.tfvars`, `*.pem` and
  `terraform.tfstate` are gitignored. The state contains the generated private
  key, so never commit it.
- **No S3, RDS or EMR resources.** If you later add an S3 bucket (e.g. for
  remote state), keep S3 Block Public Access enabled (the default).
- **Minimal resources.** One small instance. Stop it or destroy it when idle.

## Prerequisites

- Terraform >= 1.5 (`winget install Hashicorp.Terraform`)
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

nginx needs about a minute after boot to come up. Only the allowlisted IPs can
open the URL. If your IP changes (new network), run `terraform apply` again.

## Stopping and cleaning up

- Pause: set `instance_running = false` in `terraform.tfvars`, then
  `terraform apply`. The disk is kept; the public IP changes on restart.
- Remove everything: `terraform destroy`.
