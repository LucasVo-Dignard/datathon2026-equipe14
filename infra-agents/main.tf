# ---------------------------------------------------------------------------
# Research agents (AgentCore): knowledge base, gateway and its three targets,
# Bigdata.com key, research and reviewer harnesses. See ../README.md.
#
# The web server's permissions to call them are in ../infra/iam.tf, and
# ../scripts/deploy-app.sh finds them by name, so keep the names below.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # Harness names only allow letters, digits and "_".
  harness_prefix = replace(local.prefix, "-", "_")
}
