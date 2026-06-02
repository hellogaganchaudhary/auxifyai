output "region" {
  description = "Region this environment is deployed to."
  value       = var.region
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "availability_zones" {
  description = "AZs the stack spans (HA, Req 39.5)."
  value       = module.network.availability_zones
}

output "alb_dns_name" {
  description = "Public DNS of the load balancer."
  value       = module.alb.alb_dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "rds_endpoint" {
  value = module.database.endpoint
}

output "redis_primary_endpoint" {
  value = module.cache.primary_endpoint
}

output "s3_files_bucket" {
  value = module.object_store.bucket_id
}

output "kms_key_arn" {
  value = aws_kms_key.main.arn
}

output "secret_arns" {
  description = "Secrets Manager ARNs consumed by the API task."
  value = {
    database = aws_secretsmanager_secret.db.arn
    redis    = aws_secretsmanager_secret.redis.arn
    app      = aws_secretsmanager_secret.app.arn
  }
}

output "api_autoscaling" {
  description = "API service autoscaling bounds (Req 39.6)."
  value = {
    min = module.api.autoscaling_min_capacity
    max = module.api.autoscaling_max_capacity
  }
}
