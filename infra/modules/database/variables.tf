variable "name" {
  description = "Resource name prefix, e.g. \"auxify-prod\"."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID the RDS security group lives in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs across AZs for the DB subnet group (Multi-AZ HA, Req 39.5)."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "RDS requires subnets in at least 2 AZs for Multi-AZ high availability (Req 39.5)."
  }
}

variable "ingress_security_group_ids" {
  description = "Security group IDs allowed to connect to PostgreSQL (e.g. the ECS service SG)."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "KMS key ARN for storage and Performance Insights encryption."
  type        = string
}

# --- Engine / sizing (parameterized per environment) ---
variable "engine_version" {
  description = "PostgreSQL engine version."
  type        = string
  default     = "16.14"
}

variable "parameter_group_family" {
  description = "RDS parameter group family matching the engine version."
  type        = string
  default     = "postgres16"
}

variable "instance_class" {
  description = "RDS instance class (size per environment)."
  type        = string
  default     = "db.t4g.medium"
}

variable "allocated_storage" {
  description = "Initial storage in GB."
  type        = number
  default     = 50
}

variable "max_allocated_storage" {
  description = "Storage autoscaling ceiling in GB."
  type        = number
  default     = 200
}

variable "multi_az" {
  description = "Enable Multi-AZ for synchronous standby + automatic failover (HA, Req 39.5). Set true in production."
  type        = bool
  default     = false
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "auxify"
}

variable "db_username" {
  description = "Master username."
  type        = string
  default     = "auxify_admin"
}

variable "enable_pgvector" {
  description = <<-EOT
    When true, pg_stat_statements is preloaded and pgvector is expected to be
    enabled per-database via `CREATE EXTENSION vector;` (RDS does NOT load
    pgvector through shared_preload_libraries — see db-init SQL). This flag keeps
    the module's intent explicit; the extension is created by the app's
    migration / db-init step.
  EOT
  type        = bool
  default     = true
}

variable "backup_retention_period" {
  description = "Days of automated backups to retain."
  type        = number
  default     = 14
}

variable "backup_window" {
  description = "Daily backup window (UTC)."
  type        = string
  default     = "18:00-19:00"
}

variable "maintenance_window" {
  description = "Weekly maintenance window."
  type        = string
  default     = "Mon:19:30-Mon:20:30"
}

variable "deletion_protection" {
  description = "Protect the DB instance from deletion (recommend true in production)."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy (true is convenient for ephemeral envs)."
  type        = bool
  default     = false
}

variable "performance_insights_enabled" {
  description = "Enable RDS Performance Insights."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Common tag map applied to all resources in this module."
  type        = map(string)
  default     = {}
}
