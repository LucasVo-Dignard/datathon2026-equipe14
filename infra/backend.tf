# Remote state in a private, versioned, encrypted S3 bucket.
# The bucket is created once by ./bootstrap-state-bucket.sh.
# Credentials come from ../.env-aws, never from this file.
terraform {
  backend "s3" {
    bucket       = "datathon2026-equipe14-tfstate-779846826297"
    key          = "infra/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true # S3-native state locking
  }
}
