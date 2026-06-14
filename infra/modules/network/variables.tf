variable "name" {
  description = "Resource name prefix, e.g. \"auxify-prod\"."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "az_count" {
  description = "Number of Availability Zones to span. Minimum 2 for HA (no single point of failure, Req 39.5)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2
    error_message = "az_count must be >= 2 so the VPC spans multiple Availability Zones (HA, Req 39.5)."
  }
}

variable "availability_zones" {
  description = <<-EOT
    Explicit list of Availability Zone names to use (e.g. ["ap-south-1a", "ap-south-1b"]).
    Leave empty to auto-discover standard AZs in the active region. Providing this
    list keeps the config region-portable for multi-region rollout (Req 42.3).
  EOT
  type        = list(string)
  default     = []
}

variable "public_subnet_cidrs" {
  description = "Optional explicit CIDRs for public subnets (one per AZ). Empty = derive from vpc_cidr."
  type        = list(string)
  default     = []
}

variable "private_subnet_cidrs" {
  description = "Optional explicit CIDRs for private subnets (one per AZ). Empty = derive from vpc_cidr."
  type        = list(string)
  default     = []
}

variable "single_nat_gateway" {
  description = <<-EOT
    true  = one NAT gateway shared by all AZs (cost-conscious; fine for dev/staging).
    false = one NAT gateway per AZ (full HA egress, no single point of failure — Req 39.5).
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  description = "Common tag map applied to all resources in this module."
  type        = map(string)
  default     = {}
}
