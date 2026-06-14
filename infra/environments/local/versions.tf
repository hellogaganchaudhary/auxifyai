# Provider configuration lives here in the environment root (not in the modules),
# so the region is supplied per environment / per region — keeping the modules
# region-agnostic and the platform multi-region capable (Req 42.3).
terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = local.common_tags
  }
}
