variable "region" {
  description = "AWS region for all resources."
  type        = string
  default     = "ap-south-1" # Mumbai
}

variable "aws_profile" {
  description = "Named AWS CLI profile used by Terraform."
  type        = string
  default     = "auxify"
}

variable "project" {
  description = "Project name prefix for resource names."
  type        = string
  default     = "auxify"
}

variable "environment" {
  description = "Deployment environment (prod, staging, dev)."
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "az_count" {
  description = "Number of Availability Zones to span (for Multi-AZ HA)."
  type        = number
  default     = 2
}

# --- Database ---
variable "db_instance_class" {
  description = "RDS PostgreSQL instance class."
  type        = string
  default     = "db.t4g.medium"
}

variable "db_allocated_storage" {
  description = "Initial RDS storage in GB."
  type        = number
  default     = 50
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GB."
  type        = number
  default     = 200
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "auxify"
}

variable "db_username" {
  description = "Master username for RDS."
  type        = string
  default     = "auxify_admin"
}

variable "db_multi_az" {
  description = "Enable Multi-AZ for RDS (HA). Costs ~2x; disable for dev."
  type        = bool
  default     = true
}

# --- Redis ---
variable "redis_node_type" {
  description = "ElastiCache Redis node type."
  type        = string
  default     = "cache.t4g.medium"
}

# --- Containers ---
variable "api_image_tag" {
  description = "Container image tag for the API service."
  type        = string
  default     = "latest"
}

variable "api_desired_count" {
  description = "Number of API tasks to run."
  type        = number
  default     = 2
}

variable "api_cpu" {
  description = "Fargate task CPU units for the API (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "api_memory" {
  description = "Fargate task memory (MiB) for the API."
  type        = number
  default     = 2048
}

# --- Bedrock model IDs (Mumbai / ap-south-1) ---
variable "bedrock_models" {
  description = "Map of logical model name to Bedrock model ID enabled in this account/region."
  type        = map(string)
  default = {
    claude_opus    = "anthropic.claude-opus-4-5-20251101-v1:0"
    claude_sonnet  = "anthropic.claude-sonnet-4-5-20250929-v1:0"
    claude_haiku   = "anthropic.claude-haiku-4-5-20251001-v1:0"
  }
}
