output "endpoint" {
  description = "Connection endpoint (host) of the RDS instance."
  value       = aws_db_instance.main.address
}

output "port" {
  description = "PostgreSQL port."
  value       = aws_db_instance.main.port
}

output "db_name" {
  description = "Initial database name."
  value       = aws_db_instance.main.db_name
}

output "username" {
  description = "Master username."
  value       = aws_db_instance.main.username
}

output "multi_az" {
  description = "Whether Multi-AZ HA is enabled for this instance."
  value       = aws_db_instance.main.multi_az
}

output "security_group_id" {
  description = "Security group ID guarding the database."
  value       = aws_security_group.rds.id
}

# Marked sensitive so the generated master password never prints in plan/apply
# output. The environment writes this into Secrets Manager.
output "password" {
  description = "Generated master password (sensitive; store in Secrets Manager)."
  value       = random_password.db.result
  sensitive   = true
}

output "connection_url" {
  description = "PostgreSQL connection URL (sensitive)."
  value       = "postgresql://${aws_db_instance.main.username}:${random_password.db.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${aws_db_instance.main.db_name}?sslmode=require"
  sensitive   = true
}
