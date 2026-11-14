output "ecr_repository_url" {
  description = "ECR repository of the job image (pushed by ../scripts/deploy-batch.sh)."
  value       = aws_ecr_repository.job.repository_url
}

output "job_queue" {
  description = "Batch job queue (for a manual run, see README.md)."
  value       = aws_batch_job_queue.main.name
}

output "job_definition" {
  description = "Batch job definition, latest revision."
  value       = aws_batch_job_definition.daily_refresh.arn
}

output "log_group" {
  description = "CloudWatch log group of the job."
  value       = aws_cloudwatch_log_group.job.name
}

output "job_security_group_id" {
  description = "Security group of the job (allowed by the DB security group)."
  value       = aws_security_group.job.id
}

output "schedule" {
  description = "When the job runs."
  value       = "${var.schedule_expression} ${var.schedule_timezone} (${local.schedule_enabled ? "enabled" : "paused"})"
}
