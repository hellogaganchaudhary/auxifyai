output "service_name" {
  description = "Name of the ECS service."
  value       = aws_ecs_service.this.name
}

output "service_arn" {
  description = "ARN of the ECS service."
  value       = aws_ecs_service.this.id
}

output "task_definition_arn" {
  description = "ARN of the task definition."
  value       = aws_ecs_task_definition.this.arn
}

output "target_group_arn" {
  description = "ARN of the ALB target group fronting this service."
  value       = aws_lb_target_group.this.arn
}

output "target_group_arn_suffix" {
  description = "ARN suffix of the target group (for CloudWatch / request-count metrics)."
  value       = aws_lb_target_group.this.arn_suffix
}

output "security_group_id" {
  description = "Security group ID of the service tasks."
  value       = aws_security_group.service.id
}

output "autoscaling_min_capacity" {
  description = "Configured autoscaling floor (HA baseline)."
  value       = aws_appautoscaling_target.this.min_capacity
}

output "autoscaling_max_capacity" {
  description = "Configured autoscaling ceiling (scale-out limit, Req 39.6)."
  value       = aws_appautoscaling_target.this.max_capacity
}
