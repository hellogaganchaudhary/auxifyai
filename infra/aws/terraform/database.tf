# =============================================================================
# RDS PostgreSQL 16 — primary database + pgvector (vector store for RAG memory)
# =============================================================================

resource "random_password" "db" {
  length  = 32
  special = true
  # RDS disallows / @ " and space in the master password.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${local.name}-db-subnets" }
}

# Parameter group with sane logging. NOTE: pgvector does NOT go in
# shared_preload_libraries on RDS — it is enabled per-database with
# `CREATE EXTENSION vector;` (see db-init in the backend migration step).
resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg16"
  family = "postgres16"

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  tags = { Name = "${local.name}-pg16" }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name}-pg"
  engine         = "postgres"
  engine_version = "16.14"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.main.arn

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period   = 14
  backup_window             = "18:00-19:00" # UTC (off-peak for IST)
  maintenance_window        = "Mon:19:30-Mon:20:30"
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-pg-final"
  copy_tags_to_snapshot     = true

  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.main.arn
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true

  tags = { Name = "${local.name}-pg" }
}

# =============================================================================
# ElastiCache Redis 7 — cache, queues (BullMQ), sessions, pub/sub
# =============================================================================

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-redis-subnets"
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "redis_auth" {
  length  = 48
  special = false # Redis AUTH token: alphanumeric only to avoid escaping issues
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name}-redis"
  description          = "Auxify Redis (cache, queues, sessions, pubsub)"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  num_node_groups            = 1
  replicas_per_node_group    = var.db_multi_az ? 1 : 0
  automatic_failover_enabled = var.db_multi_az
  multi_az_enabled           = var.db_multi_az

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  kms_key_id                 = aws_kms_key.main.arn

  snapshot_retention_limit = 7
  snapshot_window          = "17:00-18:00"
  maintenance_window       = "mon:18:30-mon:19:30"

  tags = { Name = "${local.name}-redis" }
}
