output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.web.id
}

output "public_ip" {
  description = "Permanent public IP of the instance (Elastic IP)."
  value       = aws_eip.web.public_ip
}

output "url" {
  description = "HTTP URL of the instance (reachable only from allowed_cidrs)."
  value       = "http://${aws_eip.web.public_ip}"
}

output "allowed_cidrs" {
  description = "IPs currently allowed to reach the instance."
  value       = local.allowed_cidrs
}

output "ssh_command" {
  description = "SSH command (requires enable_ssh = true)."
  value       = "ssh -i ${local_sensitive_file.private_key.filename} ec2-user@${aws_eip.web.public_ip}"
}

output "web_role_name" {
  description = "IAM role of the web server (other stacks attach their permissions to it)."
  value       = aws_iam_role.web.name
}

output "ecr_repository_url" {
  description = "ECR repository of the app image (pushed by ../scripts/deploy-app.sh)."
  value       = aws_ecr_repository.app.repository_url
}

output "price_alerts_topic_arn" {
  description = "SNS topic of the price-move email alerts (sns.tf)."
  value       = aws_sns_topic.price_alerts.arn
}
