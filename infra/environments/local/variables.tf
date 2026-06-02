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
  default     = "local"
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
  default     = "10.50.0.0/16"
}

variable "az_count" {
  description = "Number of AZs to span. 2 is the HA minimum; kept here so the local cloud sandbox still matches the multi-AZ architecture (Req 39.5/42.2)."
  type        = number
  default     = 2
}

# --- Database (mirrors the single docker-compose postgres+pgvector instance) ---
variable "db_instance_class" {
  description = "RDS instance class (smallest viable for the local sandbox)."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Initial RDS storage (GB)."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "RDS storage autoscaling ceiling (GB)."
  type        = number
  default     = 50
}

variable "db_multi_az" {
  description = "Multi-AZ off for the local sandbox to match the single-container footprint and minimise cost (Req 42.2)."
  type        = bool
  default     = false
}

# --- Cache (mirrors the single docker-compose redis instance) ---
variable "redis_node_type" {
  description = "ElastiCache Redis node type (smallest viable)."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_multi_az" {
  description = "Multi-AZ off for the local sandbox (single-node, matches docker-compose)."
  type        = bool
  default     = false
}

# --- API service (single task, mirrors one local container) ---
variable "api_image_tag" {
  description = "Container image tag for the API service."
  type        = string
  default     = "latest"
}

variable "api_cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU)."
  type        = number
  default     = 256
}

variable "api_memory" {
  description = "Fargate task memory (MiB)."
  type        = number
  default     = 512
}

variable "api_desired_count" {
  description = "Baseline API task count (1 mirrors the single local container)."
  type        = number
  default     = 1
}

variable "api_min_capacity" {
  description = "Autoscaling floor."
  type        = number
  default     = 1
}

variable "api_max_capacity" {
  description = "Autoscaling ceiling (small for the sandbox; autoscaling is still wired, Req 39.6)."
  type        = number
  default     = 2
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
