variable "name" {
  description = "Resource name prefix, e.g. \"auxify-prod\"."
  type        = string
}

variable "bucket_purpose" {
  description = "Short suffix describing the bucket's purpose (e.g. \"files\", \"backups\")."
  type        = string
  default     = "files"
}

variable "kms_key_arn" {
  description = "KMS key ARN for SSE-KMS encryption at rest."
  type        = string
}

variable "versioning_enabled" {
  description = "Enable object versioning (also required for cross-region replication)."
  type        = bool
  default     = true
}

variable "noncurrent_version_expiration_days" {
  description = "Days after which non-current object versions expire."
  type        = number
  default     = 90
}

variable "abort_multipart_days" {
  description = "Days after which incomplete multipart uploads are aborted."
  type        = number
  default     = 7
}

# --- Multi-region replication hooks (Req 42.3) ---
variable "replication_enabled" {
  description = <<-EOT
    Enable S3 Cross-Region Replication to a destination bucket in another region.
    This is the hook that lets the object store follow the platform into a second
    region without redesign (Req 42.3). Requires versioning_enabled = true.
  EOT
  type        = bool
  default     = false
}

variable "replication_destination_bucket_arn" {
  description = "ARN of the destination bucket (in another region) for replication. Required when replication_enabled = true."
  type        = string
  default     = ""
}

variable "replication_role_arn" {
  description = "IAM role ARN S3 assumes to replicate objects. Required when replication_enabled = true."
  type        = string
  default     = ""
}

variable "replication_destination_kms_key_arn" {
  description = "KMS key ARN in the destination region used to encrypt replicas. Required when replication_enabled = true."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Common tag map applied to all resources in this module."
  type        = map(string)
  default     = {}
}
