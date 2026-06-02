# =============================================================================
# KMS — single customer-managed key for RDS, Redis, S3, Secrets at-rest crypto
# =============================================================================
data "aws_iam_policy_document" "kms" {
  # Root account retains full control (required so the key isn't orphaned).
  statement {
    sid       = "EnableRootAccount"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # Allow CloudWatch Logs in this region to use the key for encrypted log groups.
  statement {
    sid     = "AllowCloudWatchLogs"
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
  tags                    = { Name = "${local.name}-kms" }
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}

# =============================================================================
# S3 — file storage (uploads, documents, generated assets, backups)
# =============================================================================
resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "files" {
  bucket = "${local.name}-files-${random_id.bucket_suffix.hex}"
  tags   = { Name = "${local.name}-files" }
}

resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-old-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# =============================================================================
# ECR — container image registry for the API service
# =============================================================================
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

  tags = { Name = "${local.name}-api-ecr" }
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

# =============================================================================
# Secrets Manager — DB creds, Redis auth, app secrets, provider keys
# =============================================================================
resource "aws_secretsmanager_secret" "db" {
  name        = "${local.name}/database"
  description = "RDS PostgreSQL connection details"
  kms_key_id  = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    host     = aws_db_instance.main.address
    port     = 5432
    dbname   = var.db_name
    username = var.db_username
    password = random_password.db.result
    url      = "postgresql://${var.db_username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${var.db_name}?sslmode=require"
  })
}

resource "aws_secretsmanager_secret" "redis" {
  name        = "${local.name}/redis"
  description = "ElastiCache Redis connection details"
  kms_key_id  = aws_kms_key.main.arn
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    host       = aws_elasticache_replication_group.main.primary_endpoint_address
    port       = 6379
    auth_token = random_password.redis_auth.result
    url        = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  })
}

# Application secret bundle — populated out-of-band (Azure keys, JWT secret,
# web-search provider keys). Created empty so the app can read a stable ARN.
resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "Application secrets: Azure OpenAI/Foundry keys, search providers, JWT"
  kms_key_id  = aws_kms_key.main.arn
}
