/**
 * Property-based invariant test for the application-layer tenant scoping the
 * repository layer provides (Req 1.2, 44.1).
 *
 * This is a *local* invariant of the repository layer (not one of the numbered
 * design Properties): for **any** {@link TenantContext} and **any** sequence of
 * repository operations, every SQL statement the repository issues must carry
 * an Organization predicate bound to `ctx.organizationId` as a positional
 * parameter — so a query can never be issued without tenant scoping. The
 * Property 1 design statement (tenant isolation end-to-end) is validated
 * separately in task 3.3.
 *
 * Validates: Requirements 1.2, 44.1
 *
 * The repositories talk to a fake {@link SqlClient} that captures every issued
 * SQL text and its parameters, so the property inspects exactly what would hit
 * PostgreSQL without needing a live database.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import { ConversationRepository, MessageRepository, TenantCrudRepository } from './index.js';

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

interface CapturedQuery {
  text: string;
  params: unknown[];
}

/** Fake client capturing all queries and returning a single echo row. */
class CapturingSqlClient implements SqlClient {
  readonly queries: CapturedQuery[] = [];

  constructor(private readonly rowFactory: () => SqlRow) {}

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ text, params });
    return { rows: [this.rowFactory()] };
  }
}

/** A non-empty identifier (org id, user id, row id, etc.). */
const idArb = fc.string({ minLength: 1, maxLength: 24 });

/** A tenant context with a non-empty organization and user id. */
const ctxArb: fc.Arbitrary<TenantContext> = fc.record({
  organizationId: idArb,
  userId: idArb,
});

/** Assert every captured query carries `organizationId` as a bound parameter. */
function expectEveryQueryScoped(queries: CapturedQuery[], organizationId: string): void {
  expect(queries.length).toBeGreaterThan(0);
  for (const q of queries) {
    // The org value must be bound (parameterized), never absent.
    expect(q.params).toContain(organizationId);
    // And the SQL must reference the tenant column for the scope.
    expect(q.text).toMatch(/organization_id/);
  }
}

describe('Feature: auxify-ai-platform — repository layer always injects the tenant predicate', () => {
  it('direct-scoped conversation reads/writes are always organization-scoped (Validates: Requirements 1.2, 44.1)', async () => {
    await fc.assert(
      fc.asyncProperty(ctxArb, idArb, idArb, idArb, async (ctx, convId, projectId, ownerId) => {
        const sql = new CapturingSqlClient(() => ({
          id: convId,
          organization_id: ctx.organizationId,
          project_id: projectId,
          owner_id: ownerId,
          title: '',
          folder_id: null,
          archived: false,
          share_token: null,
          share_mode: null,
          persona_id: null,
          active_model_id: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        }));
        const repo = new ConversationRepository(sql);

        await repo.create(ctx, { id: convId, projectId, ownerId });
        await repo.findById(ctx, convId);
        await repo.listByOwner(ctx, ownerId);
        await repo.list(ctx, { limit: 5 });
        await repo.update(ctx, convId, { title: 'x', archived: true });
        await repo.delete(ctx, convId);

        expectEveryQueryScoped(sql.queries, ctx.organizationId);

        // The INSERT binds organization_id as its first column → first param.
        const insert = sql.queries[0]!;
        expect(insert.text).toMatch(/^INSERT INTO conversations/);
        expect(insert.params[0]).toBe(ctx.organizationId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('parent-scoped message reads/writes always filter through the owning conversation (Validates: Requirements 1.2, 44.1)', async () => {
    await fc.assert(
      fc.asyncProperty(
        ctxArb,
        idArb,
        idArb,
        fc.constantFrom('user', 'assistant', 'system'),
        async (ctx, msgId, convId, role) => {
          const sql = new CapturingSqlClient(() => ({
            id: msgId,
            conversation_id: convId,
            parent_id: null,
            role,
            content: '[]',
            model: null,
            input_tokens: null,
            output_tokens: null,
            cost: null,
            latency_ms: null,
            rating: null,
            pinned: false,
            attachments: '[]',
            created_at: '2026-01-01T00:00:00.000Z',
          }));
          const repo = new MessageRepository(sql);

          await repo.create(ctx, { id: msgId, conversationId: convId, role: role as 'user' });
          await repo.findById(ctx, msgId);
          await repo.listByConversation(ctx, convId);
          await repo.update(ctx, msgId, { pinned: true });
          await repo.delete(ctx, msgId);

          expectEveryQueryScoped(sql.queries, ctx.organizationId);

          // Every statement scopes through the parent conversation subquery /
          // EXISTS guard referencing the conversations table.
          for (const q of sql.queries) {
            expect(q.text).toMatch(/conversations/);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('a query is never scoped to a different organization than the context (Validates: Requirements 1.2)', async () => {
    // Org ids are drawn from a disjoint, prefixed space from row ids/payload
    // values (as real tenant ids are uuid/prefixed), so the assertion below
    // tests tenant scoping rather than coincidental value collisions.
    const orgIdArb = fc.string({ minLength: 1, maxLength: 24 }).map((s) => `org-${s}`);
    const rowIdArb = fc.string({ minLength: 1, maxLength: 24 }).map((s) => `row-${s}`);

    await fc.assert(
      fc.asyncProperty(
        fc.tuple(orgIdArb, orgIdArb).filter(([a, b]) => a !== b),
        rowIdArb,
        async ([orgA, orgB], rowId) => {
          const ctx: TenantContext = { organizationId: orgA, userId: 'u' };
          const sql = new CapturingSqlClient(() => ({ id: rowId, organization_id: orgA }));
          const repo = new TenantCrudRepository(sql, { table: 'widgets' });

          await repo.create(ctx, { id: rowId });
          await repo.findById(ctx, rowId);
          await repo.list(ctx);
          await repo.update(ctx, rowId, { name: 'val' });
          await repo.delete(ctx, rowId);

          // Bound to org A on every statement, and never to the foreign org B.
          for (const q of sql.queries) {
            expect(q.params).toContain(orgA);
            expect(q.params).not.toContain(orgB);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
