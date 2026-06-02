# Primary_Database schema & migrations

This directory defines the PostgreSQL 16 schema that is the platform's system of
record (Req 44.1) and the tooling to apply it.

## Layout

- `migrations/NNNN_name.sql` — ordered, **idempotent** raw SQL migrations. The
  numeric prefix is the application order; the runner refuses duplicate prefixes
  or malformed names.
- `migrations.ts` — driver-agnostic loader (`loadMigrations`) and runner
  (`applyMigrations`). Records applied files in a `schema_migrations` ledger so a
  run only executes the pending tail.
- `partitions.ts` — helpers that render monthly-partition DDL for
  `usage_records` (Req 44.7) from application code, mirroring the SQL
  `create_usage_records_partition()` function.
- `../../scripts/migrate.ts` — CLI that wires `applyMigrations` to the `pg`
  driver and pre-creates upcoming monthly partitions.

## Applying migrations

```bash
DATABASE_URL=postgres://auxify:auxify@localhost:5432/auxify \
  pnpm --filter @auxify/core db:migrate
```

The local Docker Compose stack provisions PostgreSQL 16 + pgvector with the
`vector` and `pg_trgm` extensions (see `infra/local/postgres`). Migration `0001`
also enables them so the schema can be bootstrapped against any fresh database.

Migrations are idempotent: every object uses `CREATE ... IF NOT EXISTS`,
`CREATE OR REPLACE`, or a `DROP ... IF EXISTS` guard, so re-running is safe.

## Migration order

| #    | File                         | Tables / objects                                                                       |
| ---- | ---------------------------- | -------------------------------------------------------------------------------------- |
| 0001 | `extensions`                 | `vector`, `pg_trgm`, `pgcrypto`                                                        |
| 0002 | `tenancy_identity`           | organizations, teams, projects, users, memberships, policies                           |
| 0003 | `conversations_messages`     | conversations, messages (branch tree)                                                  |
| 0004 | `personas_prompts_artifacts` | personas, prompt_templates, prompt_versions, artifacts, artifact_versions              |
| 0005 | `files_knowledge`            | files, knowledge_collections, knowledge_sources, knowledge_documents, knowledge_chunks |
| 0006 | `knowledge_hub`              | knowledge_pages, page_versions, page_comments                                          |
| 0007 | `messaging`                  | channels, channel_messages, notifications                                              |
| 0008 | `document_management`        | folders, documents, document_versions                                                  |
| 0009 | `agents_workflows`           | agents, agent_runs, agent_steps, workflows                                             |
| 0010 | `keys_audit`                 | api_keys, audit_logs (append-only)                                                     |
| 0011 | `usage_records`              | usage_records (month-partitioned), partition helper                                    |
| 0012 | `vector_records`             | vector_records (pgvector + HNSW)                                                       |
| 0013 | `invitations`                | invitations (single-use token, accept-to-create)                                       |
| 0014 | `audit_metadata`             | audit_logs.metadata structured-context column                                          |
| 0015 | `row_level_security`         | RLS enabled + forced on every tenant-scoped table, bound to the session Organization   |

## Tenant isolation: defense in depth (Req 1.2, 1.4)

No query may cross an Organization boundary (Req 1.4). The platform enforces
this in **two independent layers**, so a gap in either one cannot leak data:

1. **Application layer (Req 1.2)** — the repository layer
   (`services/core/src/repositories`) requires a `TenantContext` on every call
   and automatically injects an `organization_id` predicate into every
   SELECT/UPDATE/DELETE (and sets/guards it on INSERT). See `base-repository.ts`.
2. **Database layer (Req 1.4)** — PostgreSQL Row-Level Security (migration
   `0015_row_level_security.sql`) is `ENABLE`d **and** `FORCE`d on every
   tenant-scoped table, with a policy that binds row visibility to the session
   GUC `app.current_organization_id`.

The two are complementary: even if an application-layer predicate were ever
missed, RLS still blocks the cross-tenant row at the database; and even on a
connection that bypasses RLS, the repository predicate still scopes the query.

### How RLS is bound to a request

`app.current_organization_id` is a custom session/transaction setting (a GUC).
Every policy compares the row's Organization against
`current_setting('app.current_organization_id', true)`. The `true` (missing-ok)
argument makes an **unset** GUC return SQL `NULL` rather than raising, so a
connection that has not bound a tenant sees **no rows** — RLS **fails closed**.

Request handlers bind the session before running tenant-scoped queries with the
helpers in `rls.ts`:

```ts
import { withTenantSession } from '@auxify/core';

// Binds app.current_organization_id for the transaction, runs the work, and
// COMMITs (or ROLLBACKs + rethrows on failure). SET LOCAL means the binding is
// discarded automatically when the transaction ends.
await withTenantSession(client, tenantContext, async (tx) => {
  // every query here is RLS-scoped to tenantContext.organizationId
});
```

`setTenantSession` / `resetTenantSession` are also exported for code that
manages its own transaction or a dedicated session-wide connection. The
Organization id is bound via `set_config(...)` as a positional parameter (never
string-concatenated) and is additionally validated against `[A-Za-z0-9_-]+`.

### Scoping strategies

Mirroring the repository layer's `DirectTenantScope` / `ParentTenantScope`:

- **Direct** — tables carrying `organization_id` compare it to the GUC
  directly. `organizations` is the root, scoped by its own `id`.
- **Parent** — tables without `organization_id` are scoped through the nearest
  ancestor that has one, via an `IN (SELECT … WHERE organization_id = <guc>)`
  subquery: `messages`/`artifacts` → `conversations`; `prompt_versions` →
  `prompt_templates`; `knowledge_sources`/`knowledge_documents`/
  `knowledge_chunks` → up to `knowledge_collections`; `page_versions`/
  `page_comments` → `knowledge_pages`; `document_versions` → `documents`;
  `agent_runs`/`agent_steps` → `agents`; `notifications` → `users`.
- **Special cases**:
  - `channel_messages` — a channel post (`channel_id` set) is scoped by its
    `channels` row; a direct message (`channel_id` NULL) is scoped by its
    author's `users` row.
  - `personas` — system/default and predefined personas have a `NULL` owner and
    are shared across tenants (Req 9.1, 9.2); user personas are scoped through
    their owning user's Organization.

## Cascade-delete policy (Req 44.8 / Property 58)

Deleting a parent removes all dependent children so no orphan remains:

- **Tenancy containment** uses `ON DELETE CASCADE` end-to-end: organization →
  team → project, and project → (conversations, knowledge pages, channels,
  documents, agents, workflows, …).
- **Owner/aggregate edges** cascade: conversation → messages, agent →
  agent_runs → agent_steps, knowledge_collection → sources → documents →
  chunks, prompt_template → prompt_versions, document → document_versions, etc.
- **Self-referential trees** cascade so subtrees are removed with their root:
  `messages.parent_id`, `knowledge_pages.parent_id`,
  `channel_messages.parent_id`, `folders.parent_id`.
- **Non-containment references** use `ON DELETE SET NULL` to avoid deleting
  unrelated data: `documents.folder_id` (move to unfiled) and
  `knowledge_documents.duplicate_of` (detach the de-dup pointer).

## Usage-record partitioning (Req 44.7)

`usage_records` is `PARTITION BY RANGE (created_at)`. PostgreSQL requires the
partition key in the primary key, so the PK is `(id, created_at)`. Monthly
partitions are named `usage_records_pYYYY_MM`. The migration creates the current
month plus a `DEFAULT` catch-all partition; operations pre-create upcoming
months with `createUpcomingUsageRecordsPartitionsSql()` (or the SQL
`create_usage_records_partition()` function) and can detach/drop old months once
past the 2-year retention window (Req 22.6).

## Message persistence round-trip (Req 44.6)

`messages` stores the conversation reference, parent reference (branch tree),
role, content, model, input/output token counts, cost, and latency so a
persisted message round-trips with full request-outcome metadata.
