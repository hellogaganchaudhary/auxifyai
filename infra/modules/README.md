# Auxify — Reusable Terraform Modules

This directory holds the **reusable, region-agnostic** Terraform modules that
make up the Auxify cloud architecture (Req 42.1). Each module is composed by the
per-environment root configurations under [`../environments/`](../environments/README.md).

The module set deliberately mirrors the **same architecture the platform runs
locally** under `docker-compose.yml` (PostgreSQL 16 + pgvector, Redis, an
S3-compatible object store), so the local and cloud topologies match without
architectural changes (Req 42.2).

> ⚠️ These modules are **not applied directly**. They are inputs to the
> environment roots. `terraform` (init/plan/apply) must be run by an **operator**
> from an environment directory — never from this `modules/` directory, and never
> against the legacy live-state config in `../aws/terraform/`.

## Modules

| Module | Purpose | Key HA / scaling / multi-region features |
| --- | --- | --- |
| [`network/`](network) | VPC, public + private subnets, IGW, NAT, route tables | Spans **≥ 2 Availability Zones**; optional one-NAT-per-AZ for full HA egress (Req 39.5). Region/AZ/CIDR are all variables (Req 42.3). |
| [`alb/`](alb) | Application Load Balancer, security group, listeners | Spans public subnets across **multiple AZs** (Req 39.5). Optional HTTPS + HTTP→HTTPS redirect. |
| [`ecs-service/`](ecs-service) | Fargate service, target group, autoscaling | Tasks across AZs (Req 39.5); **CPU + ALB request-count autoscaling** (Req 39.6); health checks + connection draining + **circuit-breaker rollback** and unhealthy-task replacement (Req 39.7). |
| [`database/`](database) | RDS PostgreSQL 16 + pgvector | **`multi_az` toggle** for synchronous standby + automatic failover (Req 39.5). pgvector enabled per-database via `CREATE EXTENSION vector;`. |
| [`cache/`](cache) | ElastiCache Redis 7 replication group | **`multi_az` toggle** with automatic failover replica (Req 39.5). Encryption in transit + at rest. |
| [`object-store/`](object-store) | S3 bucket(s) | Versioning + SSE-KMS + public-access block; **optional cross-region replication** hook (Req 42.3). |

## Conventions

Every module follows Terraform HCL best practices:

- **Four files per module**: `main.tf`, `variables.tf` (typed + described), `outputs.tf`, `versions.tf`.
- **Provider version pinning** in `versions.tf` — AWS provider `~> 5.60` (matches the
  legacy `aws/terraform/versions.tf`), `random ~> 3.6`. Provider *configuration*
  (region, profile, tags) lives in the environment root, keeping every module
  region-agnostic.
- **No hardcoded regions.** Region is always supplied by the calling environment's
  provider block; AZ lists are variables. This is what lets the same code deploy to
  additional regions without redesign (Req 42.3).
- **No secrets in code.** Generated credentials (DB password, Redis AUTH token) are
  returned as `sensitive` outputs and written to AWS Secrets Manager by the
  environment; application secrets are referenced by ARN only. There are **no inline
  credentials** anywhere.
- **Tagging.** Every resource merges a common `tags` map (carrying `Environment` and
  a project tag) supplied by the environment.

## Multi-region story (Req 42.3)

The platform is initially deployed in a single **primary region**, but adding a
region requires **no redesign**:

1. The provider's `region` is a variable in every environment root — point a new
   var set / workspace at another region.
2. The `network` module takes the region's AZ list (or auto-discovers it), so the
   VPC rebuilds itself correctly in the new region.
3. The environment `backend.tf` uses a **per-environment / per-region state key**
   (e.g. `auxify/<env>/<region>/terraform.tfstate`) so each region keeps isolated
   state.
4. The `object-store` module exposes cross-region replication hooks to mirror
   files/backups into the new region.

Adding a region therefore means: a new `*.tfvars` (region + AZ list + sizing) and a
new backend key — not a code change.
