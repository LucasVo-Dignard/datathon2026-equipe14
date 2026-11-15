terraform {
  required_version = ">= 1.10"

  required_providers {
    # AgentCore (gateway, targets, harnesses, credential providers) needs 6.x.
    # The other stacks stay on 5.x.
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
    # Only for the gateway rate limit, which the aws provider doesn't have.
    awscc = {
      source  = "hashicorp/awscc"
      version = "~> 1.110"
    }
  }
}

# Credentials and region come from the AWS_* variables in ../.env-aws.
provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = local.env
      Stack       = "agents"
      ManagedBy   = "terraform"
    }
  }
}

provider "awscc" {
  region = var.region
}
