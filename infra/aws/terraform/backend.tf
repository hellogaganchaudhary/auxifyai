# Remote state backend for the main stack.
#
# The local tfstate currently sitting in this directory contains the RDS
# master password and Redis auth token in PLAINTEXT — it must live in the
# encrypted, versioned, access-controlled bucket instead of on a laptop.
#
# ACTIVATION (one time):
#   1. Create the bucket:  cd ../tfstate-bootstrap && terraform init && terraform apply
#      (needs admin credentials once; see notes in that stack)
#   2. Uncomment the block below.
#   3. terraform init -migrate-state    # copies local state into S3
#   4. Verify with `terraform state list`, then delete terraform.tfstate*
#      from this directory and from any backups/Trash.
#
# Locking uses S3 native lockfiles (`use_lockfile`, Terraform >= 1.10) — no
# DynamoDB table needed.

# terraform {
#   backend "s3" {
#     bucket       = "auxify-tfstate-904233107009"
#     key          = "auxify/prod/ap-south-1/terraform.tfstate"
#     region       = "ap-south-1"
#     encrypt      = true
#     use_lockfile = true
#   }
# }
