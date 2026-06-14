# =============================================================================
# ALB module — public Application Load Balancer spanning public subnets across
# multiple AZs (Req 39.5). Exposes a security group and listeners; target
# groups are owned by the ecs-service module so each service registers its own.
#
# When certificate_arn is provided, traffic is served over HTTPS:443 and HTTP:80
# redirects to it. Until then, HTTP:80 forwards directly (dev/bootstrap).
# =============================================================================

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb-sg"
  description = "ALB ingress from clients on 80/443"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name}-alb-sg" })
}

resource "aws_lb" "main" {
  name               = "${var.name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  enable_deletion_protection = var.enable_deletion_protection
  idle_timeout               = var.idle_timeout

  tags = merge(var.tags, { Name = "${var.name}-alb" })
}

locals {
  https_enabled = var.certificate_arn != ""
}

# HTTPS listener (created only when a certificate is supplied). Services attach
# their target groups to this listener via the ecs-service module.
resource "aws_lb_listener" "https" {
  count             = local.https_enabled ? 1 : 0
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not Found"
      status_code  = "404"
    }
  }

  tags = merge(var.tags, { Name = "${var.name}-https" })
}

# HTTP listener. When HTTPS is enabled it redirects to 443; otherwise it serves
# a default 404 (services attach rules / become the default action).
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  dynamic "default_action" {
    for_each = local.https_enabled ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }

  dynamic "default_action" {
    for_each = local.https_enabled ? [] : [1]
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "text/plain"
        message_body = "Not Found"
        status_code  = "404"
      }
    }
  }

  tags = merge(var.tags, { Name = "${var.name}-http" })
}
