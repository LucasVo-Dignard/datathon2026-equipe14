# ---------------------------------------------------------------------------
# Existing resources from ../infra and ../infra-db, found by name (no
# dependency on their state). Apply order: infra, infra-db, infra-batch.
# ---------------------------------------------------------------------------

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_vpc" "main" {
  filter {
    name   = "tag:Name"
    values = ["${local.prefix}-vpc"]
  }
}

# The job runs in the public subnet with a public IP, so it reaches Yahoo,
# ECR and Secrets Manager through the internet gateway: no NAT gateway.
data "aws_subnet" "public" {
  vpc_id = data.aws_vpc.main.id
  filter {
    name   = "tag:Name"
    values = ["${local.prefix}-public"]
  }
}

data "aws_db_instance" "main" {
  db_instance_identifier = "${local.prefix}-db"
}

# Price alerts (SES): the sender and the web server's address come from
# ../infra (looked up by name, like the database), so apply ../infra first.
# No sender parameter = alerts disabled in this environment.
data "aws_ssm_parameters_by_path" "alerts" {
  path = "/${local.prefix}/alerts"
}

data "aws_eip" "web" {
  tags = { Name = "${local.prefix}-web" }
}

data "aws_security_group" "db" {
  vpc_id = data.aws_vpc.main.id
  name   = "${local.prefix}-db"
}

locals {
  db_secret_arn = data.aws_db_instance.main.master_user_secret[0].secret_arn
  db_port       = data.aws_db_instance.main.port

  schedule_enabled = var.schedule_enabled != null ? var.schedule_enabled : local.is_prod
  refresh_enabled  = var.refresh_enabled != null ? var.refresh_enabled : local.is_prod
  job_timeout      = var.job_timeout_seconds != null ? var.job_timeout_seconds : (local.is_prod ? 14400 : 1800)

  alerts_sender = try(
    data.aws_ssm_parameters_by_path.alerts.values[index(data.aws_ssm_parameters_by_path.alerts.names, "/${local.prefix}/alerts/sender")],
    "",
  )
  alerts_configuration_set = "${local.prefix}-alerts" # created with the sender in ../infra/ses.tf
}

# ---------------------------------------------------------------------------
# Security group of the job: NO inbound rules at all, so nothing can connect
# to it, even though it has a public IP while it runs.
# Outbound: HTTPS (Yahoo, Finnhub, ECR, Secrets Manager, CloudWatch Logs) and
# the database port to the DB security group only.
# ---------------------------------------------------------------------------

resource "aws_security_group" "job" {
  name        = "${local.prefix}-batch-job"
  description = "Daily refresh job: no inbound, outbound HTTPS and DB only"
  vpc_id      = data.aws_vpc.main.id

  tags = { Name = "${local.prefix}-batch-job" }
}

resource "aws_vpc_security_group_egress_rule" "job_https" {
  security_group_id = aws_security_group.job.id
  description       = "HTTPS to data providers and AWS APIs"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "job_db" {
  security_group_id            = aws_security_group.job.id
  description                  = "PostgreSQL to the database"
  ip_protocol                  = "tcp"
  from_port                    = local.db_port
  to_port                      = local.db_port
  referenced_security_group_id = data.aws_security_group.db.id
}

# The database accepts the job's security group, in addition to the web
# server's (set in ../infra-db). Security group reference only: no CIDR.
# This rule belongs to this stack, so destroying it removes the access.
resource "aws_vpc_security_group_ingress_rule" "db_from_job" {
  security_group_id            = data.aws_security_group.db.id
  description                  = "PostgreSQL from the daily refresh batch job"
  ip_protocol                  = "tcp"
  from_port                    = local.db_port
  to_port                      = local.db_port
  referenced_security_group_id = aws_security_group.job.id
}

resource "aws_cloudwatch_log_group" "job" {
  name              = "/aws/batch/${local.prefix}-daily-refresh"
  retention_in_days = var.log_retention_days
}
