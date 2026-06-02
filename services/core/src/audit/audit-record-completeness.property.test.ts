/**
 * Property-based test — **Property 6: Audit record completeness** (Req 37.1, 37.2).
 *
 * Design statement (Property 6):
 *   _For any_ tracked action across the audited domains (authentication,
 *   administration, agents, workflows, budgets, tools, knowledge, messaging,
 *   document management, and access decisions), the recorded audit entry
 *   contains a non-empty actor, action, resource type, resource identifier,
 *   Organization, timestamp, IP address, and user agent.
 *
 * Validates: Requirements 37.1, 37.2
 *
 * This file is dedicated to Property 6 only. The example-based unit tests live
 * in `audit-service.test.ts`; sibling `audit-*.property.test.ts` files own the
 * other audit properties (immutability, query soundness, retention).
 *
 * Strategy: drive the real {@link AuditService} against a fake {@link SqlClient}
 * that captures the issued INSERT and echoes the inserted row back (the same
 * pattern as `audit-service.test.ts`), so the *persisted* record is exactly
 * what the mapper reads out of storage. For ANY tracked action — arbitrary
 * actor, action, resource type/id, IP, user agent, and Organization (from the
 * {@link TenantContext}) — we assert that:
 *   - the core identity fields (actor, action, resource type, resource id,
 *     Organization, timestamp) are always present and non-empty — recording
 *     never drops or blanks a required field;
 *   - the persisted record reflects EXACTLY what was supplied, with the
 *     documented defaults applied: actor → `ctx.userId`, timestamp → "now",
 *     IP / user agent → `''` when omitted;
 *   - the Organization is taken from the context, never the event payload;
 *   - when an IP and user agent ARE supplied they are persisted non-empty
 *     (the design's "non-empty IP address and user agent" for the captured
 *     case).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import { AuditService, type AuditEvent } from './index.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

/** Deterministic clock + id so defaulted timestamp/id are assertable. */
const FIXED_NOW = '2026-06-02T12:00:00.000Z';
const FIXED_ID = 'audit-fixed-id';

/** A single captured query: its SQL text and bound positional parameters. */
interface CapturedQuery {
  text: string;
  params: unknown[];
}

/**
 * Fake {@link SqlClient} that captures every query and, for an INSERT, echoes a
 * row reconstructed from the inserted columns + bound params — so `append()`'s
 * `RETURNING *` mapper reads back exactly what was written.
 */
class FakeSqlClient implements SqlClient {
  readonly queries: CapturedQuery[] = [];

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ text, params });
    if (/^INSERT INTO/.test(text)) {
      return { rows: [echoInsertRow(text, params)] };
    }
    return { rows: [] };
  }

  get last(): CapturedQuery {
    const q = this.queries[this.queries.length - 1];
    if (q === undefined) throw new Error('no query captured');
    return q;
  }
}

/** Reconstruct the inserted row from the captured INSERT text + params. */
function echoInsertRow(text: string, params: unknown[]): SqlRow {
  // Columns appear as `INSERT INTO audit_logs (a, b, c) VALUES ($1, $2, $3)`.
  const columnList = /\(([^)]+)\) VALUES/.exec(text)?.[1] ?? '';
  const columns = columnList.split(',').map((c) => c.trim().replace(/"/g, ''));
  const row: SqlRow = {};
  columns.forEach((column, index) => {
    row[column] = params[index];
  });
  return row;
}

/** Build a fresh service with a deterministic id factory and clock. */
function makeService(): { service: AuditService; sql: FakeSqlClient } {
  const sql = new FakeSqlClient();
  const service = new AuditService(sql, {
    idFactory: () => FIXED_ID,
    now: () => new Date(FIXED_NOW),
  });
  return { service, sql };
}

// ---------------------------------------------------------------------------
// Generators — intelligently constrained to the tracked-action input space.
// ---------------------------------------------------------------------------

/** A non-empty identifier (org id, user id, actor id, resource id, ...). */
const idArb = fc.string({ minLength: 1, maxLength: 24 });

/** A tenant context with a non-empty Organization and user id. */
const ctxArb: fc.Arbitrary<TenantContext> = fc.record({
  organizationId: idArb,
  userId: idArb,
});

/**
 * A non-empty action verb spanning every audited domain (Req 37.2), mixing the
 * concrete domain actions with freely generated verbs so the property holds for
 * ANY tracked action, not just the canonical examples.
 */
const actionArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'auth.login.failed', // authentication
    'role.change', // administration
    'agent.run', // agents
    'workflow.execute', // workflows
    'budget.exceeded', // budgets
    'tool.invoke', // tools
    'knowledge.denied', // knowledge operations
    'message.delete', // messaging
    'document.denied', // document management
    'access.denied', // access-control decisions
  ),
  fc.string({ minLength: 1, maxLength: 32 }),
);

/** A non-empty resource type spanning the audited domains. */
const resourceTypeArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'user',
    'agent_run',
    'workflow',
    'usage_record',
    'agent',
    'knowledge_page',
    'channel_message',
    'document',
    'project',
    'api_key',
  ),
  fc.string({ minLength: 1, maxLength: 32 }),
);

/** A non-empty supplied value, or `undefined` to exercise the default. */
const optionalNonEmpty: fc.Arbitrary<string | undefined> = fc.option(
  fc.string({ minLength: 1, maxLength: 40 }),
  { nil: undefined },
);

/** An ISO-8601 timestamp, or `undefined` to default to the service clock. */
const optionalTimestamp: fc.Arbitrary<string | undefined> = fc.option(
  fc
    .integer({ min: 0, max: 4_102_444_800_000 }) // epoch .. year ~2100
    .map((ms) => new Date(ms).toISOString()),
  { nil: undefined },
);

/**
 * A tracked-action event: required action + resource always present; actor, ip,
 * user agent, and timestamp optionally supplied so we exercise both the
 * supplied path and the documented defaults.
 */
const eventArb: fc.Arbitrary<AuditEvent> = fc.record({
  action: actionArb,
  resourceType: resourceTypeArb,
  resourceId: idArb,
  actorId: fc.option(idArb, { nil: undefined }),
  ip: optionalNonEmpty,
  userAgent: optionalNonEmpty,
  timestamp: optionalTimestamp,
});

// ---------------------------------------------------------------------------
// Property 6: Audit record completeness.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 6: Audit record completeness (Validates: Requirements 37.1, 37.2)', () => {
  it('persists every required field, never dropping or blanking one, for any tracked action', async () => {
    await fc.assert(
      fc.asyncProperty(ctxArb, eventArb, async (ctx, event) => {
        const { service, sql } = makeService();

        const record = await service.recordReturning(ctx, event);

        // --- Completeness: the core identity fields are always populated. ---
        // (actor, action, resource type, resource id, Organization, timestamp)
        expect(record.organizationId.length).toBeGreaterThan(0);
        expect(record.actorId.length).toBeGreaterThan(0);
        expect(record.action.length).toBeGreaterThan(0);
        expect(record.resourceType.length).toBeGreaterThan(0);
        expect(record.resourceId.length).toBeGreaterThan(0);
        expect(record.timestamp.length).toBeGreaterThan(0);

        // --- Exact reflection of what was supplied, with documented defaults. ---
        // Organization always comes from the context, never the event payload.
        expect(record.organizationId).toBe(ctx.organizationId);
        // Actor defaults to ctx.userId when omitted.
        expect(record.actorId).toBe(event.actorId ?? ctx.userId);
        // Action / resource are passed through verbatim.
        expect(record.action).toBe(event.action);
        expect(record.resourceType).toBe(event.resourceType);
        expect(record.resourceId).toBe(event.resourceId);
        // Timestamp defaults to "now" when omitted.
        expect(record.timestamp).toBe(event.timestamp ?? FIXED_NOW);
        // IP / user agent default to '' when omitted, else reflect the input.
        expect(record.ip).toBe(event.ip ?? '');
        expect(record.userAgent).toBe(event.userAgent ?? '');

        // --- When an IP / user agent ARE captured, they persist non-empty. ---
        if (event.ip !== undefined) {
          expect(record.ip.length).toBeGreaterThan(0);
          expect(record.ip).toBe(event.ip);
        }
        if (event.userAgent !== undefined) {
          expect(record.userAgent.length).toBeGreaterThan(0);
          expect(record.userAgent).toBe(event.userAgent);
        }

        // --- The write itself carries every column (no field is omitted). ---
        const insert = sql.last;
        expect(insert.text).toMatch(/^INSERT INTO audit_logs/);
        expect(insert.text).toContain('RETURNING *');
        // organization_id is forced from ctx as the first bound parameter.
        expect(insert.params[0]).toBe(ctx.organizationId);
        // id, actor_id, action, resource_type, resource_id, ip, user_agent,
        // timestamp, metadata -> 9 fields + the forced organization_id = 10.
        expect(insert.params).toHaveLength(10);
        for (const param of insert.params) {
          expect(param).not.toBeUndefined();
          expect(param).not.toBeNull();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
