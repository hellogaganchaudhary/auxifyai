# =============================================================================
# database module — RDS PostgreSQL 16 with pgvector (RAG vector store).
#
# Multi-AZ is parameterized (var.multi_az): when enabled RDS maintains a
# synchronous standby in a second AZ with automatic failover, removing the
# database single point of failure (Req 39.5). pgvector is enabled per-database
# via `CREATE EXTENSION vector;` (db-init), NOT shared_preload_libraries.
#
# The master password is generated and stored in Secrets Manager by the calling
# environment — NO credentials are ever inlined in Terraform code.
# =============================================================================

resource "random_password" "db" {
  length  = 32
  special = true
  # RDS disallows / @ " and space in the master password.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.name}-db-subnets"
  subnet_ids = var.private_subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-db-subnets" })
}

resource "aws_security_group" "rds" {
  name        = "${var.name}-rds-sg"
  description = "RDS PostgreSQL; ingress only from approved security groups"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = var.ingress_security_group_ids
    content {
      description     = "PostgreSQL from ${ingress.value}"
      from_port       = 5432
      to_port         = 5432
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

  tags = merge(var.tags, { Name = "${var.name}-rds-sg" })
}

# pg_stat_statements is preloaded for query visibility. pgvector is created per
# database by the app/db-init step (it is not a preload library on RDS).
resource "aws_db_parameter_group" "main" {
  name   = "${var.name}-pg"
  family = var.parameter_group_family

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  tags = merge(var.tags, { Name = "${var.name}-pg" })
}

resource "aws_db_instance" "main" {
  identifier     = "${var.name}-pg"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period   = var.backup_retention_period
  backup_window             = var.backup_window
  maintenance_window        = var.maintenance_window
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name}-pg-final"
  copy_tags_to_snapshot     = true

  performance_insights_enabled    = var.performance_insights_enabled
  performance_insights_kms_key_id = var.performance_insights_enabled ? var.kms_key_arn : null
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true

  tags = merge(var.tags, { Name = "${var.name}-pg" })
}
