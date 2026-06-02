# Remote state backend — PER-ENVIRONMENT / PER-REGION state key.
#
# The `key` namespaces state by environment AND region. This "local" environment
# is a cloud sandbox that mirrors the docker-compose footprint (Req 42.2): the
# SAME modules and architecture as staging/production, sized down to a single
# instance per service. (Day-to-day local development uses docker-compose.yml at
# the repo root; this root exists so the cloud architecture can be exercised at
# minimal cost in a dev account.)
#
# Bucket / table / region below are PLACEHOLDERS to be supplied by the operator
# via `terraform init -backend-config=...` or a *.backend.hcl file. They are
# intentionally not real values and contain no secrets. To use purely local
# state instead, comment out this block and run with the default local backend.
terraform {
  backend "s3" {
    bucket = "REPLACE_ME-auxify-tfstate"
    key    = "auxify/local/ap-south-1/terraform.tfstate"
    region = "ap-south-1"

    dynamodb_table = "REPLACE_ME-auxify-tflock"
    encrypt        = true
  }
}
