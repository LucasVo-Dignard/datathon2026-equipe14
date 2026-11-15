output "research_harness_arn" {
  description = "RESEARCH_HARNESS_ARN of the app."
  value       = aws_bedrockagentcore_harness.research.arn
}

output "reviewer_harness_arn" {
  description = "RESEARCH_REVIEWER_ARN of the app."
  value       = aws_bedrockagentcore_harness.reviewer.arn
}

output "gateway_url" {
  description = "RESEARCH_GATEWAY_URL of the app (MCP endpoint, IAM auth)."
  value       = aws_bedrockagentcore_gateway.research.gateway_url
}

output "knowledge_base_bucket" {
  description = "RESEARCH_KB_BUCKET of the app: documents go under reports/<SYMBOL>/, their metadata under metadata/."
  value       = aws_s3_bucket.earnings.bucket
}

output "knowledge_base_id" {
  description = "RESEARCH_KB_ID of the app."
  value       = aws_bedrockagent_knowledge_base.earnings.id
}

output "knowledge_base_data_source_id" {
  description = "RESEARCH_KB_DATA_SOURCE_ID of the app."
  value       = aws_bedrockagent_data_source.earnings.data_source_id
}

output "bigdata_secret_name" {
  description = "Secrets Manager secret to fill with the Bigdata.com key: {\"api_key\": \"...\"}."
  value       = aws_secretsmanager_secret.bigdata.name
}
