output "endpoint" {
  description = "Host name of the database (reachable only from inside the VPC)."
  value       = aws_db_instance.main.address
}

output "port" {
  description = "Database port."
  value       = aws_db_instance.main.port
}

output "db_name" {
  description = "Database name."
  value       = aws_db_instance.main.db_name
}

output "master_username" {
  description = "Master user name."
  value       = aws_db_instance.main.username
}

output "master_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the master password."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "security_group_id" {
  description = "Database security group. Add ingress from other app security groups here."
  value       = aws_security_group.db.id
}

output "migrations_bucket" {
  description = "Private bucket used by db/migrate.py to send migration bundles to the web server."
  value       = aws_s3_bucket.migrations.bucket
}
