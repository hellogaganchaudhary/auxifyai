# Auxify — Per-Environment Terraform Configurations

Each subdirectory here is a **Terraform root** for one environment (Req 42.1). A
root does very little of its own: it sets the provider/region, declares typed
variables, supplies an environment-specific `terraform.tfvars`, and **composes
the reusable modules** under [`../modules/`](../modules/README.md). All three
environments use the **same modules and the same architecture** — only sizing,
HA toggles, and teardown-protection differ (Req 42.2).

| Environment | AZs | RDS Multi-AZ | Redis Multi-AZ | API min→max tasks | Notes |
| --- | --- | --- | --- | --- | --- |
| [`local/`](local) | 2 | off | off | 1 → 2 | Cloud sandbox mirroring the docker-compose footprint. Day-to-day dev uses `docker-compose.yml`. |
| [`staging/`](staging) | 2 | on | on | 2 → 6 | Smaller scale, disposable, validates the production HA topology. |
| [`production/`](production) | 3 | on | on | 3 → 12 | Full HA, larger instances, higher autoscale ceiling. |

Each root contains the same five files:

- `main.tf` — composes `network`, `alb`, `ecs-service`, `database`, `cache`,
  `object-store`, plus the shared glue (KMS, ECS cluster, IAM, ECR, Secrets,
  CloudWatch Logs).
- `variables.tf` — typed, described variables with environment-appropriate defaults.
- `terraform.tfvars` — the environment's concrete sizing / HA values.
- `backend.tf` — remote state with a **per-environment / per-region state key**.
- `versions.tf` — provider pinning (AWS `~> 5.60`, random `~> 3.6`) + the
  **`provider "aws"` block** (region comes from `var.region`).

## How each requirement is satisfied

- **42.1 — reusable modules + per-env configs:** modules live in `../modules`;
  each env here is a thin root composing them with its own variables.
- **42.2 — same architecture locally and in cloud:** every env (including `local`)
  uses identical modules; the `local` root mirrors the `docker-compose.yml`
  services (Postgres+pgvector, Redis, S3/MinIO) sized to one instance each.
- **42.3 — multi-region capable, no redesign to add a region:** `region` is a
  variable in every root and the only place a region is set is the provider
  block. AZs are variables (or auto-discovered). State keys in `backend.tf` are
  namespaced `auxify/<env>/<region>/terraform.tfstate`. Adding a region = a new
  `*.tfvars` (region + AZ list) + a new backend key, no code change.
- **39.5 — HA, no single point of failure:** every env spans ≥ 2 AZs; the ALB
  spans public subnets across AZs; staging/production enable RDS + Redis Multi-AZ;
  production runs one NAT gateway per AZ.
- **39.6 — horizontal auto-scaling:** the `ecs-service` module attaches CPU and
  ALB request-count target-tracking policies between each env's `min`/`max`.
- **39.7 — health-check draining + replacement:** the `ecs-service` target group
  has health checks + `deregistration_delay` (connection draining), and the ECS
  service uses a deployment circuit breaker with automatic rollback; unhealthy
  tasks are replaced.

## Running Terraform (operator only)

> ⚠️ Terraform is **not** run as part of generating this code, and **must not** be
> run against the legacy live-state config in `../aws/terraform/`. An operator runs
> it from an environment directory:

```sh
# from infra/environments/<env>
terraform init \
  -backend-config="bucket=<your-tfstate-bucket>" \
  -backend-config="dynamodb_table=<your-tflock-table>" \
  -backend-config="key=auxify/<env>/<region>/terraform.tfstate"

terraform plan  -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

To bring up an **additional region**, copy the env's `terraform.tfvars`, set a new
`region` + `availability_zones`, and init with a new `key=auxify/<env>/<new-region>/terraform.tfstate`.

### Secrets

No secrets live in this code. Generated credentials (DB password, Redis AUTH
token) are produced at apply time and written to **AWS Secrets Manager**;
application secrets (provider keys, JWT) are populated **out-of-band** into the
`<name>/app` secret and referenced by ARN only.
