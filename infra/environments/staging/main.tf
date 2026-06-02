# =============================================================================
# Staging environment root — composes the reusable modules under ../../modules
# into the full Auxify stack for the staging environment (Req 42.1).
#
# Same architecture and modules as production (Req 42.2); only sizing and
# teardown-protection differ via variables + terraform.tfvars. Multi-AZ HA is
# still on by default so staging validates the production HA topology (Req 39.5).
# =============================================================================

data "aws_caller_identity" "current" {}

locals {
  name = "${var.project}-${var.environment}"

  common_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# -----------------------------------------------------------------------------
# KMS — single customer-managed key for RDS, Redis, S3, Secrets at-rest crypto
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "EnableRootAccount"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid = "AllowCloudWatchLogs"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:*"]
    }
  }
}

resource "aws_kms_key" "main" {
  description             = "${local.name} encryption key (RDS, Redis, S3, Secrets)"
  deletion_window_in_days = 14
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms.json
  tags                    = merge(local.common_tags, { Name = "${local.name}-kms" })
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}

# -----------------------------------------------------------------------------
# Network — VPC spanning multiple AZs (Req 39.5, 42.3)
# -----------------------------------------------------------------------------
module "network" {
  source = "../../modules/network"

  name               = local.name
  vpc_cidr           = var.vpc_cidr
  az_count           = var.az_count
  availability_zones = var.availability_zones
  single_nat_gateway = true # cost-conscious for staging
  tags               = local.common_tags
}

# -----------------------------------------------------------------------------
# ALB — public entry point across AZs (Req 39.5)
# -----------------------------------------------------------------------------
module "alb" {
  source = "../../modules/alb"

  name                       = local.name
  vpc_id                     = module.network.vpc_id
  public_subnet_ids          = module.network.public_subnet_ids
  enable_deletion_protection = false
  tags                       = local.common_tags
}

# -----------------------------------------------------------------------------
# ECS cluster + logs + IAM (shared glue for the Fargate services)
# -----------------------------------------------------------------------------
resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(local.common_tags, { Name = "${local.name}-cluster" })
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}-api"
  retention_in_days = 14
  kms_key_id        = aws_kms_key.main.arn
  tags              = merge(local.common_tags, { Name = "${local.name}-api-logs" })
}

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}/api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }

  tags = merge(local.common_tags, { Name = "${local.name}-api-ecr" })
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 15 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 15
      }
      action = { type = "expire" }
    }]
  })
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.db.arn,
      aws_secretsmanager_secret.redis.arn,
      aws_secretsmanager_secret.app.arn,
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name   = "${local.name}-ecs-execution-secrets"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution_secrets.json
}

resource "aws_iam_role" "ecs_task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "ecs_task" {
  statement {
    sid = "BedrockInvoke"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = ["arn:aws:bedrock:*::foundation-model/anthropic.*"]
  }

  statement {
    sid     = "S3Files"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [
      module.object_store.bucket_arn,
      "${module.object_store.bucket_arn}/*",
    ]
  }

  statement {
    sid     = "ReadSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.db.arn,
      aws_secretsmanager_secret.redis.arn,
      aws_secretsmanager_secret.app.arn,
    ]
  }

  statement {
    sid       = "KmsDecrypt"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "ecs_task" {
  name   = "${local.name}-ecs-task-policy"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task.json
}

# -----------------------------------------------------------------------------
# Database — RDS PostgreSQL + pgvector, Multi-AZ to mirror production (Req 39.5)
# -----------------------------------------------------------------------------
module "database" {
  source = "../../modules/database"

  name                       = local.name
  vpc_id                     = module.network.vpc_id
  private_subnet_ids         = module.network.private_subnet_ids
  ingress_security_group_ids = [module.api.security_group_id]
  kms_key_arn                = aws_kms_key.main.arn

  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  multi_az              = var.db_multi_az
  enable_pgvector       = true
  deletion_protection   = false # staging is disposable
  skip_final_snapshot   = true

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Cache — ElastiCache Redis, Multi-AZ to mirror production (Req 39.5)
# -----------------------------------------------------------------------------
module "cache" {
  source = "../../modules/cache"

  name                       = local.name
  vpc_id                     = module.network.vpc_id
  private_subnet_ids         = module.network.private_subnet_ids
  ingress_security_group_ids = [module.api.security_group_id]
  kms_key_arn                = aws_kms_key.main.arn

  node_type = var.redis_node_type
  multi_az  = var.redis_multi_az

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Object store — S3 for files/documents/backups (replication hook ready, 42.3)
# -----------------------------------------------------------------------------
module "object_store" {
  source = "../../modules/object-store"

  name           = local.name
  bucket_purpose = "files"
  kms_key_arn    = aws_kms_key.main.arn
  tags           = local.common_tags
}

# -----------------------------------------------------------------------------
# Secrets — DB creds, Redis auth, app bundle (values from module outputs / OOB)
# -----------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "db" {
  name        = "${local.name}/database"
  description = "RDS PostgreSQL connection details"
  kms_key_id  = aws_kms_key.main.arn
  tags        = local.common_tags
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    host     = module.database.endpoint
    port     = module.database.port
    dbname   = module.database.db_name
    username = module.database.username
    password = module.database.password
    url      = module.database.connection_url
  })
}

resource "aws_secretsmanager_secret" "redis" {
  name        = "${local.name}/redis"
  description = "ElastiCache Redis connection details"
  kms_key_id  = aws_kms_key.main.arn
  tags        = local.common_tags
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    host       = module.cache.primary_endpoint
    port       = module.cache.port
    auth_token = module.cache.auth_token
    url        = module.cache.connection_url
  })
}

# Application secret bundle — populated out-of-band (provider keys, JWT secret).
# Created empty so the app can read a stable ARN. No secrets in code.
resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "Application secrets: provider keys, JWT, search providers"
  kms_key_id  = aws_kms_key.main.arn
  tags        = local.common_tags
}

# -----------------------------------------------------------------------------
# API service — Fargate behind the ALB with autoscaling + health checks
# (Req 39.5 / 39.6 / 39.7)
# -----------------------------------------------------------------------------
module "api" {
  source = "../../modules/ecs-service"

  name         = local.name
  service_name = "api"
  region       = var.region

  cluster_id   = aws_ecs_cluster.main.id
  cluster_name = aws_ecs_cluster.main.name

  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids

  alb_security_group_id = module.alb.security_group_id
  listener_arn          = module.alb.active_listener_arn
  alb_arn_suffix        = module.alb.alb_arn_suffix

  container_image = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
  container_port  = 3000
  cpu             = var.api_cpu
  memory          = var.api_memory

  execution_role_arn = aws_iam_role.ecs_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn
  log_group_name     = aws_cloudwatch_log_group.api.name

  environment_variables = {
    NODE_ENV             = var.environment
    PORT                 = "3000"
    AWS_REGION           = var.region
    S3_BUCKET            = module.object_store.bucket_id
    BEDROCK_MODEL_OPUS   = var.bedrock_models.claude_opus
    BEDROCK_MODEL_SONNET = var.bedrock_models.claude_sonnet
    BEDROCK_MODEL_HAIKU  = var.bedrock_models.claude_haiku
  }

  secrets = {
    DATABASE_SECRET = aws_secretsmanager_secret.db.arn
    REDIS_SECRET    = aws_secretsmanager_secret.redis.arn
    APP_SECRETS     = aws_secretsmanager_secret.app.arn
  }

  # HA + autoscaling (Req 39.5, 39.6)
  desired_count = var.api_desired_count
  min_capacity  = var.api_min_capacity
  max_capacity  = var.api_max_capacity

  # Health-check-based draining + replacement (Req 39.7)
  health_check_path    = "/health"
  deregistration_delay = 30

  tags = local.common_tags
}
