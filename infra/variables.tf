variable "project_name" {
  description = "Prefix used for resource names and tags."
  type        = string
  default     = "datathon2026-equipe14"
}

variable "region" {
  description = "AWS region. Leave null to use AWS_DEFAULT_REGION from the environment."
  type        = string
  default     = null
}

variable "instance_type" {
  description = "EC2 instance type. Keep it small: launch only what the project needs."
  type        = string
  default     = "t3.micro"
}

variable "root_volume_size" {
  description = "Root EBS volume size in GiB (Amazon Linux 2023 minimum is 8)."
  type        = number
  default     = 8
}

variable "instance_running" {
  description = "Set to false to stop the instance when it isn't in use (it keeps its disk and config)."
  type        = bool
  default     = true
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  description = "CIDR block for the public subnet."
  type        = string
  default     = "10.0.1.0/24"
}

variable "web_ports" {
  description = "TCP ports reachable from allowed_cidrs. The chatbot only serves HTTP, so 80 by default."
  type        = list(number)
  default     = [80]
}

variable "allow_my_ip" {
  description = "Also allow the public IP of the machine running terraform. Default: off in prod (a per-machine IP would make each teammate's apply different), on in dev environments (one person applies each)."
  type        = bool
  default     = null
}

variable "allowed_cidrs" {
  description = "Extra IPv4 CIDRs (e.g. teammates' IPs as \"203.0.113.4/32\") allowed to reach the instance. Opening to the whole internet is forbidden."
  type        = list(string)
  # Polytechnique Montreal network (see CLAUDE.md, rule 2).
  default = ["132.207.0.0/16"]

  validation {
    condition     = alltrue([for c in var.allowed_cidrs : can(cidrhost(c, 0)) && !endswith(c, "/0")])
    error_message = "allowed_cidrs must be valid IPv4 CIDRs and must not open the instance to the whole internet (no /0)."
  }
}

variable "enable_ssh" {
  description = "Open SSH (22) to the same allowed CIDRs. Off by default; turn it on only while you need it."
  type        = bool
  default     = false
}

variable "app_image_tag" {
  description = "Tag of the app image in ECR that the server runs. deploy-app.sh moves \"latest\" on every deploy; pin a git SHA to roll back."
  type        = string
  default     = "latest"
}
