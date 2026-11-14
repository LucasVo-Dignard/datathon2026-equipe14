output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.web.id
}

output "public_ip" {
  description = "Public IP of the instance (changes if the instance is stopped and started)."
  value       = aws_instance.web.public_ip
}

output "url" {
  description = "HTTP URL of the instance (reachable only from allowed_cidrs)."
  value       = "http://${aws_instance.web.public_ip}"
}

output "allowed_cidrs" {
  description = "IPs currently allowed to reach the instance."
  value       = local.allowed_cidrs
}

output "ssh_command" {
  description = "SSH command (requires enable_ssh = true)."
  value       = "ssh -i ${local_sensitive_file.private_key.filename} ec2-user@${aws_instance.web.public_ip}"
}
