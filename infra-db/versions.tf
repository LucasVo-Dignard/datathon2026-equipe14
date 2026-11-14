terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Credentials and region come from the AWS_* variables in ../.env-aws.
provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project_name
      Stack     = "db"
      ManagedBy = "terraform"
    }
  }
}
