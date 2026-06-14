output "alb_arn" {
  description = "ARN of the Application Load Balancer."
  value       = aws_lb.main.arn
}

output "alb_dns_name" {
  description = "Public DNS name of the ALB (point your domain CNAME/ALIAS here)."
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone ID of the ALB (for Route 53 alias records)."
  value       = aws_lb.main.zone_id
}

output "alb_arn_suffix" {
  description = "ARN suffix of the ALB (used to build the ALBRequestCountPerTarget autoscaling metric label)."
  value       = aws_lb.main.arn_suffix
}

output "security_group_id" {
  description = "ID of the ALB security group (ECS services allow ingress from this)."
  value       = aws_security_group.alb.id
}

output "http_listener_arn" {
  description = "ARN of the HTTP:80 listener."
  value       = aws_lb_listener.http.arn
}

output "https_listener_arn" {
  description = "ARN of the HTTPS:443 listener, or empty when no certificate is configured."
  value       = local.https_enabled ? aws_lb_listener.https[0].arn : ""
}

output "active_listener_arn" {
  description = "ARN of the listener services should attach forwarding rules to (HTTPS when present, else HTTP)."
  value       = local.https_enabled ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
}
