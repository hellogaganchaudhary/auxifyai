# =============================================================================
# cache module — ElastiCache Redis 7 replication group (cache, queues, sessions,
# pub/sub). When var.multi_az is true the group runs a replica in a second AZ
# with automatic failover, removing the Redis single point of failure (Req 39.5).
# In-transit + at-rest encryption are always on; the AUTH token is generated and
# handed back to the environment for Secrets Manager — never inlined (no secrets
# in code).
# =============================================================================

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.name}-redis-subnets"
  subnet_ids = var.private_subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-redis-subnets" })
}

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis-sg"
  description = "ElastiCache Redis; ingress only from approved security groups"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = var.ingress_security_group_ids
    content {
      description     = "Redis from ${ingress.value}"
      from_port       = 6379
      to_port         = 6379
      protocol        = "tcp"
      security_groups = [ingress.value]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.name}-redis-sg" })
}

resource "random_password" "redis_auth" {
  length  = 48
  special = false # Redis AUTH token: alphanumeric only to avoid escaping issues
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.name}-redis"
  description          = "${var.name} Redis (cache, queues, sessions, pubsub)"

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = 6379

  num_node_groups            = 1
  replicas_per_node_group    = var.multi_az ? var.replicas_per_node_group : 0
  automatic_failover_enabled = var.multi_az
  multi_az_enabled           = var.multi_az

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  kms_key_id                 = var.kms_key_arn

  snapshot_retention_limit = var.snapshot_retention_limit
  snapshot_window          = var.snapshot_window
  maintenance_window       = var.maintenance_window

  tags = merge(var.tags, { Name = "${var.name}-redis" })
}
