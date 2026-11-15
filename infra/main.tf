data "aws_availability_zones" "available" {
  state = "available"
}

# Latest Amazon Linux 2023 AMI (x86_64).
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ---------------------------------------------------------------------------
# Networking: VPC + public subnet routed to the internet
# ---------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.prefix}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${local.prefix}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = { Name = "${local.prefix}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.prefix}-public-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# Security group: inbound ONLY from an explicit IP allowlist (never 0.0.0.0/0)
# ---------------------------------------------------------------------------

# Public IP of whoever runs terraform, so they can reach the instance.
locals {
  allow_my_ip = var.allow_my_ip != null ? var.allow_my_ip : !local.is_prod
}

data "http" "my_ip" {
  count = local.allow_my_ip ? 1 : 0
  url   = "https://checkip.amazonaws.com"
}

locals {
  my_cidr       = local.allow_my_ip ? ["${chomp(data.http.my_ip[0].response_body)}/32"] : []
  allowed_cidrs = distinct(concat(local.my_cidr, var.allowed_cidrs))

  ingress_ports = concat(var.web_ports, var.enable_ssh ? [22] : [])

  # One rule per (port, cidr) pair.
  ingress_rules = {
    for pair in setproduct(local.ingress_ports, local.allowed_cidrs) :
    "${pair[0]}-${pair[1]}" => { port = pair[0], cidr = pair[1] }
  }
}

resource "aws_security_group" "web" {
  name        = "${local.prefix}-web"
  description = "Inbound only from allowlisted IPs"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.prefix}-web" }
}

resource "aws_vpc_security_group_ingress_rule" "allowed" {
  for_each = local.ingress_rules

  security_group_id = aws_security_group.web.id
  description       = "TCP ${each.value.port} from ${each.value.cidr}"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr

  lifecycle {
    precondition {
      condition     = !endswith(each.value.cidr, "/0")
      error_message = "Refusing to open the instance to the whole internet."
    }
  }
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.web.id
  description       = "All outbound traffic"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------------------------------------------------------------------------
# SSH key pair (private key written locally, gitignored)
# ---------------------------------------------------------------------------

resource "tls_private_key" "ssh" {
  algorithm = "ED25519"
}

resource "aws_key_pair" "main" {
  key_name   = "${local.prefix}-key"
  public_key = tls_private_key.ssh.public_key_openssh
}

resource "local_sensitive_file" "private_key" {
  content         = tls_private_key.ssh.private_key_openssh
  filename        = "${path.module}/${local.prefix}-key.pem"
  file_permission = "0600"
}

# ---------------------------------------------------------------------------
# EC2 instance + Elastic IP
# ---------------------------------------------------------------------------

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  # The app runs as a container pulled from ECR (see ecr.tf); user_data only
  # installs Docker and the systemd unit, so its size no longer depends on the app.
  #
  # The registry address is built from the account and region (not from the
  # repository's attributes) so it is known at plan time: otherwise Terraform
  # can't see that user_data changes, and would update it in place instead of
  # replacing the instance (and user_data only runs on first boot).
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com"
  app_image    = "${local.ecr_registry}/${local.prefix}-app:${var.app_image_tag}"

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    region   = data.aws_region.current.name
    registry = local.ecr_registry
    image    = local.app_image
    # Same name as aws_db_instance.main in ../infra-db (that stack may not exist yet).
    db_identifier = "${local.prefix}-db"
  })
}

resource "aws_instance" "web" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
  key_name               = aws_key_pair.main.key_name
  iam_instance_profile   = aws_iam_instance_profile.web.name

  # Changing user_data (or app_image_tag) recreates the instance. Changing the
  # app does not: scripts/deploy-app.sh pushes a new image and restarts it.
  user_data                   = local.user_data
  user_data_replace_on_change = true

  metadata_options {
    http_tokens = "required" # IMDSv2 only
    # 2 hops so the app container (Docker adds one) can get the instance role's
    # credentials, e.g. to call Bedrock.
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  tags = { Name = "${local.prefix}-web" }

  depends_on = [aws_internet_gateway.main]
}

# Stop the instance when not in use: set instance_running = false and apply.
resource "aws_ec2_instance_state" "web" {
  instance_id = aws_instance.web.id
  state       = var.instance_running ? "running" : "stopped"
}

# Permanent public IP. Kept separate from the instance (via an association) so
# it survives instance replacement, e.g. when ../app changes.
resource "aws_eip" "web" {
  domain = "vpc"

  tags = { Name = "${local.prefix}-web" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_eip_association" "web" {
  allocation_id = aws_eip.web.id
  instance_id   = aws_instance.web.id
}
