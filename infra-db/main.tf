# ---------------------------------------------------------------------------
# Existing network from ../infra, found by name (no dependency on its state)
# ---------------------------------------------------------------------------

data "aws_vpc" "main" {
  filter {
    name   = "tag:Name"
    values = ["${var.project_name}-vpc"]
  }
}

data "aws_security_group" "web" {
  vpc_id = data.aws_vpc.main.id
  name   = "${var.project_name}-web"
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  engine_defaults = {
    postgres = { version = "17", port = 5432 }
    mysql    = { version = "8.4", port = 3306 }
  }
  engine_version = coalesce(var.engine_version, local.engine_defaults[var.engine].version)
  port           = local.engine_defaults[var.engine].port
}

# ---------------------------------------------------------------------------
# Private subnets: no route to the internet gateway. Subnets without an
# explicit route table use the VPC main table, which only has the local route.
# ---------------------------------------------------------------------------

resource "aws_subnet" "db" {
  count = 2

  vpc_id                  = data.aws_vpc.main.id
  cidr_block              = var.private_subnet_cidrs[count.index]
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "${var.project_name}-db-private-${count.index}" }
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db"
  subnet_ids = aws_subnet.db[*].id

  tags = { Name = "${var.project_name}-db" }
}

# ---------------------------------------------------------------------------
# Security group: inbound only from the web server security group.
# No CIDR rules at all, so nothing on the internet can reach the database.
# ---------------------------------------------------------------------------

resource "aws_security_group" "db" {
  name        = "${var.project_name}-db"
  description = "Database: inbound only from the web server security group"
  vpc_id      = data.aws_vpc.main.id

  tags = { Name = "${var.project_name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "from_web" {
  security_group_id            = aws_security_group.db.id
  description                  = "${var.engine} from the web server"
  ip_protocol                  = "tcp"
  from_port                    = local.port
  to_port                      = local.port
  referenced_security_group_id = data.aws_security_group.web.id
}

# ---------------------------------------------------------------------------
# RDS instance
# ---------------------------------------------------------------------------

resource "aws_db_instance" "main" {
  identifier     = "${var.project_name}-db"
  engine         = var.engine
  engine_version = local.engine_version
  instance_class = var.instance_class

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.master_username
  # RDS generates the password and keeps it in Secrets Manager.
  # It never appears in Terraform code, variables or state.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  port                   = local.port

  publicly_accessible = false # datathon rule
  multi_az            = false # one AZ is enough for the datathon

  backup_retention_period    = var.backup_retention_days
  auto_minor_version_upgrade = true
  apply_immediately          = true
  # Never pay for RDS Extended Support once a major version ages out.
  engine_lifecycle_support = "open-source-rds-extended-support-disabled"

  # Datathon setting: terraform destroy removes the DB without a final
  # snapshot. Turn these on if the data becomes worth keeping.
  skip_final_snapshot = true
  deletion_protection = false

  performance_insights_enabled = false
  monitoring_interval          = 0

  tags = { Name = "${var.project_name}-db" }
}
