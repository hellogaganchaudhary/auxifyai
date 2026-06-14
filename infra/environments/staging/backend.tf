# Remote state backend — PER-ENVIRONMENT / PER-REGION state key.
#
# The `key` namespaces state by environment AND region, so deploying the same
# code to an additional region only needs a new var set + a new backend key
# (override `-backend-config="key=auxify/staging/<region>/terraform.tfstate"`
# at init time). No code change is required to add a region (Req 42.3).
#
# Bucket / table / region below are PLACEHOLDERS to be supplied by the operator
# via `terraform init -backend-config=...` or a *.backend.hcl file. They are
# intentionally not real values and contain no secrets.
terraform {
  backend "s3" {
    bucket = "REPLACE_ME-auxify-tfstate"
    key    = "auxify/staging/ap-south-1/terraform.tfstate"
    region = "ap-south-1"

    dynamodb_table = "REPLACE_ME-auxify-tflock"
    encrypt        = true
  }
}
