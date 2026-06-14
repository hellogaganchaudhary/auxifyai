output "primary_endpoint" {
  description = "Primary endpoint address of the Redis replication group."
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "reader_endpoint" {
  description = "Reader endpoint address (replicas) of the Redis replication group."
  value       = aws_elasticache_replication_group.main.reader_endpoint_address
}

output "port" {
  description = "Redis port."
  value       = 6379
}

output "multi_az" {
  description = "Whether Multi-AZ failover is enabled."
  value       = aws_elasticache_replication_group.main.multi_az_enabled
}

output "security_group_id" {
  description = "Security group ID guarding Redis."
  value       = aws_security_group.redis.id
}

output "auth_token" {
  description = "Generated Redis AUTH token (sensitive; store in Secrets Manager)."
  value       = random_password.redis_auth.result
  sensitive   = true
}

output "connection_url" {
  description = "Redis (TLS) connection URL (sensitive)."
  value       = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  sensitive   = true
}
