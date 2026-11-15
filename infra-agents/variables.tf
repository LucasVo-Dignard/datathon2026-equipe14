variable "project_name" {
  description = "Prefix used for resource names and tags. Must match the other stacks: ../infra/iam.tf and ../scripts/deploy-app.sh find these resources by name."
  type        = string
  default     = "datathon2026-equipe14"
}

variable "region" {
  description = "AWS region. Leave null to use AWS_DEFAULT_REGION from the environment."
  type        = string
  default     = null
}

variable "model_id" {
  description = "Bedrock model (inference profile) of the research and reviewer harnesses."
  type        = string
  default     = "global.anthropic.claude-opus-5-5"
}

variable "bigdata_mcp_url" {
  description = "Bigdata.com MCP server."
  type        = string
  default     = "https://mcp.bigdata.com/"
}

variable "bigdata_requests_per_minute" {
  description = "Gateway rate limit on the bigdata target, to protect the limited Bigdata.com credits."
  type        = number
  default     = 6
}
