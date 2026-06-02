variable "name" {
  description = "Resource name prefix, e.g. \"auxify-prod\"."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID the Redis security group lives in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs across AZs for the cache subnet group (Multi-AZ HA, Req 39.5)."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "ElastiCache requires subnets in at least 2 AZs for Multi-AZ high availability (Req 39.5)."
  }
}

variable "ingress_security_group_ids" {
  description = "Security group IDs allowed to connect to Redis (e.g. the ECS service SG)."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "KMS key ARN for at-rest encryption."
  type        = string
}

variable "engine_version" {
  description = "Redis engine version."
  type        = string
  default     = "7.1"
}

variable "node_type" {
  description = "ElastiCache node type (size per environment)."
  type        = string
  default     = "cache.t4g.medium"
}

variable "multi_az" {
  description = <<-EOT
    Enable Multi-AZ with automatic failover. When true, a replica is created in
    another AZ and ElastiCache fails over automatically, removing the cache
    single point of failure (Req 39.5). Set true in production.
  EOT
  type        = bool
  default     = false
}

variable "replicas_per_node_group" {
  description = "Number of read replicas per shard. >= 1 required for Multi-AZ failover."
  type        = number
  default     = 1
}

variable "snapshot_retention_limit" {
  description = "Days of automatic Redis snapshots to retain."
  type        = number
  default     = 7
}

variable "snapshot_window" {
  description = "Daily snapshot window (UTC)."
  type        = string
  default     = "17:00-18:00"
}

variable "maintenance_window" {
  description = "Weekly maintenance window."
  type        = string
  default     = "mon:18:30-mon:19:30"
}

variable "tags" {
  description = "Common tag map applied to all resources in this module."
  type        = map(string)
  default     = {}
}
