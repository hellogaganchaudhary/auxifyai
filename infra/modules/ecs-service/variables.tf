variable "name" {
  description = "Resource name prefix, e.g. \"auxify-prod\"."
  type        = string
}

variable "service_name" {
  description = "Short logical name of the service (e.g. \"api\")."
  type        = string
  default     = "api"
}

variable "region" {
  description = "AWS region (used for CloudWatch log routing). No region is hardcoded — passed from the environment (Req 42.3)."
  type        = string
}

variable "cluster_id" {
  description = "ECS cluster ID this service runs in."
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster name (used to build the autoscaling resource_id)."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the target group and service security group."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs (across AZs) the tasks run in — HA placement (Req 39.5)."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Tasks must be placeable across at least 2 private subnets/AZs for high availability (Req 39.5)."
  }
}

variable "alb_security_group_id" {
  description = "Security group ID of the ALB; tasks only accept ingress from it."
  type        = string
}

variable "listener_arn" {
  description = "ALB listener ARN to attach the forwarding rule to."
  type        = string
}

variable "alb_arn_suffix" {
  description = <<-EOT
    ARN suffix of the ALB (e.g. "app/my-alb/50dc6c495c0c9188"), required to build
    the resource_label for the ALBRequestCountPerTarget autoscaling metric (Req 39.6).
    Only needed when request_count_target > 0.
  EOT
  type        = string
  default     = ""
}

variable "listener_rule_priority" {
  description = "Priority of the listener rule for this service."
  type        = number
  default     = 100
}

variable "listener_path_patterns" {
  description = "Path patterns routed to this service's target group."
  type        = list(string)
  default     = ["/*"]
}

# --- Container / task sizing ---
variable "container_image" {
  description = "Full container image reference including tag, e.g. \"<ecr-url>:latest\"."
  type        = string
}

variable "container_port" {
  description = "Port the container listens on."
  type        = number
  default     = 3000
}

variable "cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 2048
}

variable "execution_role_arn" {
  description = "IAM role ARN ECS uses to pull images, write logs, and read secrets."
  type        = string
}

variable "task_role_arn" {
  description = "IAM role ARN assumed by the running container (app runtime permissions)."
  type        = string
}

variable "environment_variables" {
  description = "Plain (non-secret) environment variables injected into the container."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = <<-EOT
    Map of env var name => Secrets Manager / SSM ARN. Values are resolved at
    runtime by ECS; NO secret values are ever stored in Terraform code (Req: no
    inline credentials).
  EOT
  type        = map(string)
  default     = {}
}

variable "log_group_name" {
  description = "CloudWatch Logs group name for the container's logs."
  type        = string
}

# --- High availability / autoscaling (Req 39.5, 39.6) ---
variable "desired_count" {
  description = "Baseline number of running tasks. >= 2 keeps the service HA across AZs (Req 39.5)."
  type        = number
  default     = 2
}

variable "min_capacity" {
  description = "Minimum task count for autoscaling (floor; keep >= 2 for HA)."
  type        = number
  default     = 2
}

variable "max_capacity" {
  description = "Maximum task count autoscaling may scale out to under sustained load (Req 39.6)."
  type        = number
  default     = 6
}

variable "cpu_target_value" {
  description = "Target average CPU % for the autoscaling policy (scale out when sustained above, Req 39.6)."
  type        = number
  default     = 65
}

variable "request_count_target" {
  description = "Target ALB requests-per-target for the request-count autoscaling policy (Req 39.6). 0 disables it."
  type        = number
  default     = 1000
}

variable "scale_in_cooldown" {
  description = "Seconds to wait before scaling in again."
  type        = number
  default     = 120
}

variable "scale_out_cooldown" {
  description = "Seconds to wait before scaling out again."
  type        = number
  default     = 60
}

# --- Health checks / deployment (Req 39.7) ---
variable "health_check_path" {
  description = "HTTP path the ALB target group polls for health."
  type        = string
  default     = "/health"
}

variable "health_check_matcher" {
  description = "HTTP status code(s) considered healthy."
  type        = string
  default     = "200"
}

variable "health_check_interval" {
  description = "Seconds between health checks."
  type        = number
  default     = 30
}

variable "health_check_timeout" {
  description = "Health check response timeout in seconds."
  type        = number
  default     = 5
}

variable "healthy_threshold" {
  description = "Consecutive successful checks before a target is healthy."
  type        = number
  default     = 2
}

variable "unhealthy_threshold" {
  description = "Consecutive failed checks before a target is replaced (Req 39.7)."
  type        = number
  default     = 3
}

variable "deregistration_delay" {
  description = "Seconds the ALB drains in-flight connections before deregistering a target (connection draining, Req 39.7)."
  type        = number
  default     = 30
}

variable "health_check_grace_period_seconds" {
  description = "Grace period before ECS starts evaluating health checks on new tasks."
  type        = number
  default     = 60
}

variable "ignore_task_definition_changes" {
  description = "Reserved: the service always ignores task-definition drift (CI deploys images out-of-band). Kept for documentation; Terraform lifecycle blocks cannot be conditional."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Common tag map applied to all resources in this module."
  type        = map(string)
  default     = {}
}
