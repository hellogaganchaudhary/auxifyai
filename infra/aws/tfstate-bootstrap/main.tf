# =============================================================================
# ONE-SHOT bootstrap: the S3 bucket that stores Terraform state for the main
# stack (infra/aws/terraform). Run ONCE with ADMIN credentials (the regular
# `myai-deploy` user intentionally has no s3:CreateBucket):
#
#   cd infra/aws/tfstate-bootstrap
#   terraform init && terraform apply
#
# Then activate the remote backend on the main stack:
#
#   cd ../terraform
#   # uncomment the backend block in backend.tf
#   terraform init -migrate-state     # answer "yes" to copy local -> S3
#   rm terraform.tfstate terraform.tfstate.backup   # after verifying!
#
# State locking uses S3 native lockfiles (Terraform >= 1.10), so no DynamoDB
# table is required.
# =============================================================================

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "region" {
  description = "Region for the state bucket (keep it with the stack)."
  type        = string
  default     = "ap-south-1"
}

variable "bucket_name" {
  description = "Globally-unique name for the Terraform state bucket."
  type        = string
  default     = "auxify-tfstate-904233107009"
}

provider "aws" {
  region = var.region
}

resource "aws_s3_bucket" "tfstate" {
  bucket = var.bucket_name

  # State contains secrets (DB master password); never destroy casually.
  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "auxify-tfstate", Purpose = "terraform-state" }
}

# Versioning: every state revision is recoverable.
resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Encryption at rest (SSE-S3; switch to a CMK if account policy requires).
resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# No public access, ever.
resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Refuse plaintext (non-TLS) access outright.
resource "aws_s3_bucket_policy" "tfstate_tls_only" {
  bucket = aws_s3_bucket.tfstate.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.tfstate.arn,
        "${aws_s3_bucket.tfstate.arn}/*",
      ]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.tfstate]
}

output "bucket" {
  description = "State bucket name to use in the main stack's backend config."
  value       = aws_s3_bucket.tfstate.bucket
}
