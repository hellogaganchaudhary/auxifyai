# Auxify AI Platform

Enterprise AI platform monorepo. TypeScript / Node.js 22, pnpm workspaces + Turborepo.

## Layout

```
packages/
  types/      @auxify/types — shared domain types (frontend, backend, SDK)
  sdk/        @auxify/sdk   — typed client SDK for the public API
services/
  core/       @auxify/core  — shared backend service scaffolding
apps/
  api/        @auxify/api   — backend API app (search provider abstraction, ...)
  web/        @auxify/web   — Next.js (App Router) web client
infra/
  local/      Local Docker Compose support files (Postgres init, etc.)
  aws/        Terraform for AWS
  azure/      Azure setup
```

## Prerequisites

- Node.js 22+
- pnpm 9+ (`npm install -g pnpm` or `corepack enable pnpm`)
- Docker (for the local data-layer stack)

## Getting started

```bash
pnpm install              # install all workspace dependencies
cp .env.example .env      # configure local environment
pnpm docker:up            # start Postgres+pgvector, Redis, MinIO
pnpm type-check           # type-check all packages
pnpm lint                 # lint all packages
pnpm test                 # run unit + property-based tests (Vitest + fast-check)
```

## Local data-layer stack

`docker compose up -d` starts:

| Service  | Port        | Purpose                                 |
| -------- | ----------- | --------------------------------------- |
| postgres | 5432        | PostgreSQL 16 + pgvector (DB + vectors) |
| redis    | 6379        | Cache / queue / pub-sub / sessions      |
| minio    | 9000 / 9001 | S3-compatible object store (+ console)  |

The same architecture runs locally and in the cloud (Req 42.2); cloud
equivalents are provisioned with Terraform under `infra/`.

## Testing

- **Unit tests** with Vitest (`*.test.ts`, co-located with sources).
- **Property-based tests** with `fast-check`, one test per design property
  (Property 1–60), each running a minimum of 100 generated iterations.
