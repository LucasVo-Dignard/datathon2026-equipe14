# ---------------------------------------------------------------------------
# Environments: one Terraform workspace each, in the same AWS account.
#
#   default workspace       -> prod, resources named "datathon2026-equipe14-*"
#   lucas / andre / youcef  -> dev,  resources named "datathon2026-equipe14-<name>-*"
#
# The workspace comes from TF_WORKSPACE (set in ../.env-dev, see ../README.md).
# Each workspace has its own state in the same bucket (env:/<name>/...).
# Keep this file identical in infra/, infra-db/, infra-batch/ and infra-agents/.
# ---------------------------------------------------------------------------

variable "confirm_prod" {
  description = "Must be true to plan or apply in the default workspace (prod), so a missing TF_WORKSPACE never touches prod by accident."
  type        = bool
  default     = false
}

locals {
  dev_environments = ["lucas", "andre", "youcef"]

  is_prod = terraform.workspace == "default"
  env     = local.is_prod ? "prod" : terraform.workspace
  prefix  = local.is_prod ? var.project_name : "${var.project_name}-${terraform.workspace}"
}

data "aws_caller_identity" "env_guard" {
  lifecycle {
    precondition {
      condition     = local.is_prod || contains(local.dev_environments, terraform.workspace)
      error_message = "Unknown workspace \"${terraform.workspace}\". Use one of ${join(", ", local.dev_environments)} (TF_WORKSPACE in .env-dev), or default for prod."
    }
    precondition {
      condition     = !local.is_prod || var.confirm_prod
      error_message = "This is PROD (default workspace). Set TF_WORKSPACE to your environment, or pass -var confirm_prod=true if you really mean prod."
    }
  }
}
