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

  tags = { Name = "${var.project_name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = { Name = "${var.project_name}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = { Name = "${var.project_name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.project_name}-public-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# Security group: inbound ONLY from an explicit IP allowlist (never 0.0.0.0/0)
# ---------------------------------------------------------------------------

# Public IP of whoever runs terraform, so they can reach the instance.
data "http" "my_ip" {
  count = var.allow_my_ip ? 1 : 0
  url   = "https://checkip.amazonaws.com"
}

locals {
  my_cidr       = var.allow_my_ip ? ["${chomp(data.http.my_ip[0].response_body)}/32"] : []
  allowed_cidrs = distinct(concat(local.my_cidr, var.allowed_cidrs))

  ingress_ports = concat(var.web_ports, var.enable_ssh ? [22] : [])

  # One rule per (port, cidr) pair.
  ingress_rules = {
    for pair in setproduct(local.ingress_ports, local.allowed_cidrs) :
    "${pair[0]}-${pair[1]}" => { port = pair[0], cidr = pair[1] }
  }
}

resource "aws_security_group" "web" {
  name        = "${var.project_name}-web"
  description = "Inbound only from allowlisted IPs"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${var.project_name}-web" }
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
  key_name   = "${var.project_name}-key"
  public_key = tls_private_key.ssh.public_key_openssh
}

resource "local_sensitive_file" "private_key" {
  content         = tls_private_key.ssh.private_key_openssh
  filename        = "${path.module}/${var.project_name}-key.pem"
  file_permission = "0600"
}

# ---------------------------------------------------------------------------
# EC2 instance + Elastic IP
# ---------------------------------------------------------------------------

locals {
  app_dir = "${path.module}/../app"

  app_files = [
    for f in sort(fileset(local.app_dir, "**")) : {
      path = f
      # Light minification to save user_data space: drop indentation, and
      # comment-only lines in JS/CSS. The files in Git keep their comments.
      content = trimsuffix(
        replace(
          replace(
            replace(file("${local.app_dir}/${f}"), "/(?m)^[ \\t]+/", ""),
            "/(?m)^//.*\\n/", ""
          ),
          "/(?m)^/\\*.*\\*/\\n/", ""
        ),
        "\n"
      )
    } if !startswith(f, "data/") && !startswith(f, "node_modules/") && !endswith(f, ".md")
  ]

  # Heredoc delimiter for the embedded files; must not appear in any of them.
  app_eof = "CHATBOT_FILE_EOF_7f3a"

  # The app is embedded in user_data, and the whole script is gzipped so it
  # stays under the 16 KB EC2 limit (cloud-init decompresses gzip natively).
  user_data_gzip_b64 = base64gzip(templatefile("${path.module}/user_data.sh.tftpl", {
    files = local.app_files
    eof   = local.app_eof
  }))
}

resource "aws_instance" "web" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
  key_name               = aws_key_pair.main.key_name

  # Any change in ../app recreates the instance (new public IP, chat data reset).
  user_data_base64            = local.user_data_gzip_b64
  user_data_replace_on_change = true

  metadata_options {
    http_tokens = "required" # IMDSv2 only
  }

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = "gp3"
    encrypted   = true
  }

  tags = { Name = "${var.project_name}-web" }

  lifecycle {
    precondition {
      # 16 KB of decoded (gzipped) data = 21848 base64 characters.
      condition     = length(local.user_data_gzip_b64) <= 21848
      error_message = "Gzipped user_data exceeds the 16 KB EC2 limit: the app in ../app is too big to embed."
    }
    precondition {
      condition     = alltrue([for f in local.app_files : !strcontains(f.content, local.app_eof)])
      error_message = "An app file contains the heredoc delimiter used to embed it in user_data."
    }
  }

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

  tags = { Name = "${var.project_name}-web" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_eip_association" "web" {
  allocation_id = aws_eip.web.id
  instance_id   = aws_instance.web.id
}
