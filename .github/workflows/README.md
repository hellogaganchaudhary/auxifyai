# CI/CD Pipelines

This directory contains the GitHub Actions workflows that implement the
Auxify CI/CD pipeline (spec task 26.2, Requirements 42.4–42.7). The pipelines
are built around the monorepo's own scripts (pnpm + Turborepo, Node 22) and the
Terraform per-environment layout from task 26.1
(`infra/environments/{staging,production}`).

## Workflows at a glance

| File | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | `push` to any non-`main` branch, `pull_request` to `main` | Feature-branch / PR checks: lint, type-check, unit tests, security scanning (Req 42.4) |
| `main.yml` | `push` to `main` | Full checks → integration + e2e tests → deploy to staging (Req 42.5) |
| `production.yml` | `workflow_dispatch` or `v*.*.*` tag | Manual-approval, blue-green production release with health-check-driven automatic rollback (Req 42.6, 42.7) |

All workflows use pinned, well-known actions: `actions/checkout@v4`,
`pnpm/action-setup@v4` (pnpm 9.15.9, matching the root `packageManager`),
`actions/setup-node@v4` with `cache: pnpm` (Node 22), and the official
`aws-actions/*` deploy actions.

## Requirement → workflow/job/step mapping

### Req 42.4 — feature-branch lint, type-check, unit tests, security scan
File: `ci.yml`

| Requirement clause | Job | Step |
| --- | --- | --- |
| linting | `lint` | `Lint (turbo run lint)` → `pnpm -w run lint` |
| type checking | `type-check` | `Type check (turbo run type-check)` → `pnpm -w run type-check` |
| unit tests | `unit-test` | `Unit tests` → `pnpm -w run test` (`vitest run`) |
| security scanning (deps) | `security-scan-dependencies` | `pnpm audit --audit-level high` |
| security scanning (static) | `security-scan-codeql` | `github/codeql-action/init@v3` + `analyze@v3` |
| security scanning (secrets) | `security-scan-secrets` | `gitleaks/gitleaks-action@v2` |

The `on:` block uses `branches-ignore: [main]` for pushes and
`pull_request` against `main`, so the pipeline runs on feature branches and PRs
but not on `main` (which is handled by `main.yml`).

### Req 42.5 — main-branch integration + e2e tests, deploy to staging
File: `main.yml` (trigger: `push` to `main`)

| Requirement clause | Job | Step |
| --- | --- | --- |
| full check suite | `checks` | lint / type-check / build / unit tests |
| integration tests | `integration-e2e` (`needs: checks`) | `Integration tests` → `pnpm -w run test:integration` (task 24.4) |
| end-to-end tests | `integration-e2e` | `End-to-end tests` → `pnpm -w run test:e2e` (task 27.3) |
| deploy to staging | `deploy-staging` (`needs: integration-e2e`) | OIDC auth → image build/push → `terraform -chdir=infra/environments/staging apply` |

The `deploy-staging` job declares `needs: integration-e2e`, so staging is only
updated after integration and e2e tests pass.

> The `test:integration` and `test:e2e` scripts are added by tasks 24.4 and
> 27.3 respectively. They are referenced here as workspace script placeholders
> so the deploy gate is wired up ahead of those scripts landing.

### Req 42.6 — production manual approval + blue-green deployment
File: `production.yml`

| Requirement clause | Job | Mechanism |
| --- | --- | --- |
| manual approval | `deploy-production` | `environment: production` → pauses for required reviewers (see configuration below) |
| blue-green deployment | `deploy-production` | ECS service with `CODE_DEPLOY` controller; `aws-actions/amazon-ecs-deploy-task-definition@v2` drives a CodeDeploy blue-green rollout (green task set up, then ALB traffic shift) |

### Req 42.7 — automatic rollback on failed production health check
File: `production.yml`

| Requirement clause | Job | Mechanism |
| --- | --- | --- |
| post-deploy health check | `health-check` (`needs: deploy-production`) | `curl` the production health URL with retries; non-200 fails the job |
| automatic rollback | `rollback` (`needs: [deploy-production, health-check]`, `if: failure()`) | `aws deploy stop-deployment --auto-rollback-enabled` shifts traffic back to the previous (blue) task set |

The production ECS service's CodeDeploy deployment group should also be
configured (in Terraform, task 26.1) to **auto-rollback on a CloudWatch
alarm**, giving a second, infrastructure-level rollback path that complements
the explicit `rollback` job.

## Required repository configuration

These workflows reference repository/environment **variables** (`vars.*`) and
the built-in `GITHUB_TOKEN` only. No long-lived cloud credentials are stored;
AWS access uses GitHub OIDC (`id-token: write`) to assume IAM roles.

### Environment protection rules

1. **`production` environment (Req 42.6 — REQUIRED).** In
   `Settings > Environments`, create an environment named `production` and add a
   **Required reviewers** protection rule. This rule is what makes the
   `deploy-production` job pause for manual approval; it cannot be expressed in
   YAML. Optionally restrict deployments to protected branches/tags.
2. **`staging` environment (optional).** Used for the deployment URL/history
   view; protection rules are not required for Req 42.5.

### Variables (`Settings > Secrets and variables > Actions > Variables`)

| Name | Scope | Used by | Purpose |
| --- | --- | --- | --- |
| `AWS_REGION` | repo | `main.yml`, `production.yml` | AWS region for deploys |
| `AWS_STAGING_DEPLOY_ROLE_ARN` | repo | `main.yml` | IAM role assumed via OIDC for staging |
| `AWS_PRODUCTION_DEPLOY_ROLE_ARN` | `production` env | `production.yml` | IAM role assumed via OIDC for production |
| `STAGING_URL` | repo | `main.yml` | Staging environment URL (Environments view) |
| `PRODUCTION_URL` | `production` env | `production.yml` | Production environment URL (Environments view) |
| `PRODUCTION_HEALTH_URL` | `production` env | `production.yml` | Aggregate health endpoint, e.g. `https://api.example.com/health` |
| `PRODUCTION_CONTAINER_NAME` | `production` env | `production.yml` | Container name in the ECS task definition |
| `PRODUCTION_ECS_SERVICE` | `production` env | `production.yml` | Production ECS service name |
| `PRODUCTION_ECS_CLUSTER` | `production` env | `production.yml` | Production ECS cluster name |
| `PRODUCTION_CODEDEPLOY_APP` | `production` env | `production.yml` | CodeDeploy application name |
| `PRODUCTION_CODEDEPLOY_GROUP` | `production` env | `production.yml` | CodeDeploy deployment group name |

The exact AWS resource names (ECS cluster/service, CodeDeploy app/group, ECR
repositories) are produced by the Terraform `infra/environments/{staging,production}`
configurations (task 26.1). Wire the Terraform outputs to the variables above;
the workflow steps that reference container build contexts / Dockerfiles and the
`taskdef.json` / `appspec.json` paths are marked with comments where a real
resource name is needed.

### Health endpoint

The api app exposes per-service health/readiness endpoints
(`GET /health/:service`, `GET /readiness/:service`) plus an aggregate health
endpoint (`GET /health`) from its Monitoring_Service wiring. Point
`PRODUCTION_HEALTH_URL` at the aggregate endpoint behind the production ALB.

## Notes

- Workflows pin major action versions and use `pnpm install --frozen-lockfile`
  to keep builds reproducible against the committed lockfile.
- Shell `run:` blocks that contain `!`-style retry loops are single-quoted and
  use `set -euo pipefail` to avoid bash history-expansion pitfalls.
- Do **not** run these pipelines, `terraform`, or any deploy command from a
  local checkout; they are intended for GitHub-hosted runners with the OIDC
  trust and environment configuration described above.
