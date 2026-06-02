output "bucket_id" {
  description = "Name (ID) of the S3 bucket."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "ARN of the S3 bucket."
  value       = aws_s3_bucket.this.arn
}

output "bucket_domain_name" {
  description = "Regional domain name of the bucket."
  value       = aws_s3_bucket.this.bucket_regional_domain_name
}

output "versioning_enabled" {
  description = "Whether object versioning is enabled."
  value       = var.versioning_enabled
}

output "replication_enabled" {
  description = "Whether cross-region replication is configured."
  value       = var.replication_enabled
}
