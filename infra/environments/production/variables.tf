# --- Region / identity (Req 42.3: region is a variable everywhere) ---
variable "region" {
  description = "AWS region for this deployment. Change (with availability_zones) to deploy to another region — no code change (Req 42.3)."
  type        = string
  default     = "ap-south-1"
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
  description = "Deployment environment name."
  type        = string
  default     = "production"
}

variable "availability_zones" {
  description = "Explicit AZ names for this region. Empty = auto-discover. Supply when targeting a new region (Req 42.3)."
  type        = list(string)
  default     = []
}

# --- Network ---
variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.30.0.0/16"
}

variable "az_count" {
  description = "Number of AZs to span (>= 2 for HA, Req 39.5)."
  type        = number
  default     = 3
}

# --- Database ---
variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.r6g.large"
}

variable "db_allocated_storage" {
  description = "Initial RDS storage (GB)."
  type        = number
  default     = 100
}

variable "db_max_allocated_storage" {
  description = "RDS storage autoscaling ceiling (GB)."
  type        = number
  default     = 500
}

variable "db_multi_az" {
  description = "Enable RDS Multi-AZ HA (Req 39.5)."
  type        = bool
  default     = true
}

# --- Cache ---
variable "redis_node_type" {
  description = "ElastiCache Redis node type."
  type        = string
  default     = "cache.r6g.large"
}

variable "redis_multi_az" {
  description = "Enable Redis Multi-AZ failover (Req 39.5)."
  type        = bool
  default     = true
}

# --- API service ---
variable "api_image_tag" {
  description = "Container image tag for the API service."
  type        = string
  default     = "latest"
}

variable "api_cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "api_memory" {
  description = "Fargate task memory (MiB)."
  type        = number
  default     = 2048
}

variable "api_desired_count" {
  description = "Baseline API task count."
  type        = number
  default     = 3
}

variable "api_min_capacity" {
  description = "Autoscaling floor (HA baseline, Req 39.5)."
  type        = number
  default     = 3
}

variable "api_max_capacity" {
  description = "Autoscaling ceiling under sustained load (Req 39.6)."
  type        = number
  default     = 12
}

# --- Bedrock model IDs ---
variable "bedrock_models" {
  description = "Map of logical model name to Bedrock model ID enabled in this region."
  type        = map(string)
  default = {
    claude_opus   = "anthropic.claude-opus-4-5-20251101-v1:0"
    claude_sonnet = "anthropic.claude-sonnet-4-5-20250929-v1:0"
    claude_haiku  = "anthropic.claude-haiku-4-5-20251001-v1:0"
  }
}
