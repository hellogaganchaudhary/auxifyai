data "aws_caller_identity" "current" {}

# --- ECS task execution role: pulls images, writes logs, reads secrets ---
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
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow execution role to read the specific secrets + decrypt with our KMS key.
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

# --- ECS task role: the app's runtime AWS permissions ---
resource "aws_iam_role" "ecs_task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "ecs_task" {
  # Bedrock model invocation (Claude family)
  statement {
    sid = "BedrockInvoke"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = ["arn:aws:bedrock:*::foundation-model/anthropic.*"]
  }

  # S3 file storage
  statement {
    sid     = "S3Files"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.files.arn,
      "${aws_s3_bucket.files.arn}/*",
    ]
  }

  # Read app/runtime secrets
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
