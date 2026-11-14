# Separate state from ../infra: same private S3 bucket, different key.
# Destroying or re-applying one stack never touches the other.
# Credentials come from ../.env-aws, never from this file.
terraform {
  backend "s3" {
    bucket       = "datathon2026-equipe14-tfstate-779846826297"
    key          = "infra-db/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true # S3-native state locking
  }
}
