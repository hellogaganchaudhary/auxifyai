output "region" {
  value = var.region
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "alb_dns_name" {
  description = "Public DNS of the load balancer (point your domain CNAME here)."
  value       = aws_lb.main.dns_name
}

output "acm_validation_records" {
  description = "DNS records to create at your DNS provider to validate the ACM certificate (empty until `domain_name` is set)."
  value = var.domain_name != "" && var.acm_certificate_arn == "" ? [
    for dvo in aws_acm_certificate.api[0].domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ] : []
}

output "https_enabled" {
  description = "Whether the ALB is serving HTTPS (HTTP redirects when true)."
  value       = local.https_enabled
}

output "ecr_repository_url" {
  description = "Push API container images here."
  value       = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "rds_endpoint" {
  value = aws_db_instance.main.address
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "s3_files_bucket" {
  value = aws_s3_bucket.files.bucket
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

output "bedrock_models" {
  value = var.bedrock_models
}
