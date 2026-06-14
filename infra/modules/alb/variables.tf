variable "name" {
  description = "Resource name prefix, e.g. \"auxify-prod\"."
  type        = string
}

variable "vpc_id" {
  description = "ID of the VPC the ALB and its security group live in."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs across multiple AZs the ALB spans (Req 39.5 — HA, no single point of failure)."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "The ALB must span at least 2 public subnets in different AZs for high availability (Req 39.5)."
  }
}

variable "ingress_cidr_blocks" {
  description = "CIDR blocks allowed to reach the ALB on 80/443."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "idle_timeout" {
  description = "ALB idle timeout in seconds (raised to allow long streaming responses)."
  type        = number
  default     = 120
}

variable "enable_deletion_protection" {
  description = "Protect the ALB from accidental deletion (recommend true in production)."
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "Optional ACM certificate ARN. When set, an HTTPS:443 listener is created and HTTP:80 redirects to it."
  type        = string
  default     = ""
}

variable "ssl_policy" {
  description = "TLS policy for the HTTPS listener (used only when certificate_arn is set)."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "tags" {
  description = "Common tag map applied to all resources in this module."
  type        = map(string)
  default     = {}
}
