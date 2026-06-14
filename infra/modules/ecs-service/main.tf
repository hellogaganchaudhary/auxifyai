# =============================================================================
# ecs-service module — a Fargate service behind the ALB with:
#   * tasks spread across private subnets in multiple AZs        (Req 39.5)
#   * horizontal auto-scaling on CPU and ALB request-count       (Req 39.6)
#   * an ALB target group with health checks + connection drain  (Req 39.7)
#   * rolling deployment with circuit-breaker rollback           (Req 39.7)
# Fully parameterized (image/port, desired/min/max, health-check path) so it is
# reusable across services and environments.
# =============================================================================

locals {
  svc = "${var.name}-${var.service_name}"
}

# --- Service security group: ingress only from the ALB ---
resource "aws_security_group" "service" {
  name        = "${local.svc}-sg"
  description = "ECS service ${var.service_name}; ingress only from the ALB"
  vpc_id      = var.vpc_id

  ingress {
    description     = "From ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${local.svc}-sg" })
}

# --- Target group with health checks (Req 39.7) ---
resource "aws_lb_target_group" "this" {
  name        = "${local.svc}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = var.health_check_path
    matcher             = var.health_check_matcher
    interval            = var.health_check_interval
    timeout             = var.health_check_timeout
    healthy_threshold   = var.healthy_threshold
    unhealthy_threshold = var.unhealthy_threshold
  }

  # Connection draining: in-flight requests finish before a target is removed.
  deregistration_delay = var.deregistration_delay

  tags = merge(var.tags, { Name = "${local.svc}-tg" })
}

resource "aws_lb_listener_rule" "this" {
  listener_arn = var.listener_arn
  priority     = var.listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }

  condition {
    path_pattern {
      values = var.listener_path_patterns
    }
  }

  tags = merge(var.tags, { Name = "${local.svc}-rule" })
}

# --- Task definition ---
resource "aws_ecs_task_definition" "this" {
  family                   = local.svc
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = var.service_name
      image     = var.container_image
      essential = true
      portMappings = [{
        containerPort = var.container_port
        protocol      = "tcp"
      }]
      environment = [for k, v in var.environment_variables : { name = k, value = v }]
      secrets     = [for k, v in var.secrets : { name = k, valueFrom = v }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.log_group_name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = var.service_name
        }
      }
    }
  ])

  tags = merge(var.tags, { Name = "${local.svc}-task" })
}

# --- Service ---
resource "aws_ecs_service" "this" {
  name            = local.svc
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = var.service_name
    container_port   = var.container_port
  }

  # Rolling deployment: a failed rollout is detected and automatically rolled
  # back, and unhealthy tasks are replaced (Req 39.7).
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  health_check_grace_period_seconds = var.health_check_grace_period_seconds

  # Container image is pushed/updated out-of-band by CI; ignore task-definition
  # churn here so Terraform plans stay clean between deploys.
  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener_rule.this]

  tags = merge(var.tags, { Name = "${local.svc}-svc" })
}

# --- Autoscaling target (Req 39.6) ---
resource "aws_appautoscaling_target" "this" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# Scale on sustained average CPU.
resource "aws_appautoscaling_policy" "cpu" {
  name               = "${local.svc}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.cpu_target_value
    scale_in_cooldown  = var.scale_in_cooldown
    scale_out_cooldown = var.scale_out_cooldown
  }
}

# Scale on ALB requests-per-target (sustained request load). Disabled when
# request_count_target = 0.
resource "aws_appautoscaling_policy" "request_count" {
  count              = var.request_count_target > 0 ? 1 : 0
  name               = "${local.svc}-reqcount-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${var.alb_arn_suffix}/${aws_lb_target_group.this.arn_suffix}"
    }
    target_value       = var.request_count_target
    scale_in_cooldown  = var.scale_in_cooldown
    scale_out_cooldown = var.scale_out_cooldown
  }
}
