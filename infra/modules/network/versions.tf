# Reusable module: pins the providers it needs. The provider *configuration*
# (region, profile, default tags) lives in the environment root that calls this
# module — keeping the module region-agnostic and multi-region capable (Req 42.3).
terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}
