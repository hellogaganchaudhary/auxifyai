# =============================================================================
# object-store module — S3 bucket for files / documents / generated assets /
# backups. Versioning + SSE-KMS + a hard public-access block by default. Exposes
# optional cross-region replication (Req 42.3) so the same bucket definition can
# follow the platform into a second region without redesign.
# =============================================================================

resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "this" {
  bucket = "${var.name}-${var.bucket_purpose}-${random_id.suffix.hex}"
  tags   = merge(var.tags, { Name = "${var.name}-${var.bucket_purpose}" })
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = var.versioning_enabled ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = var.abort_multipart_days
    }
  }

  rule {
    id     = "expire-old-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }
  }
}

# --- Optional cross-region replication (multi-region hook, Req 42.3) ---
resource "aws_s3_bucket_replication_configuration" "this" {
  count = var.replication_enabled ? 1 : 0

  # Replication requires versioning to be enabled first.
  depends_on = [aws_s3_bucket_versioning.this]

  role   = var.replication_role_arn
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "replicate-all"
    status = "Enabled"
    filter {}

    delete_marker_replication {
      status = "Enabled"
    }

    destination {
      bucket        = var.replication_destination_bucket_arn
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = var.replication_destination_kms_key_arn
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
  }
}
