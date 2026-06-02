/**
 * Property + structural tests for audit immutability (Req 37.3 / Property 7).
 *
 * Feature: auxify-ai-platform, Property 7: Audit immutability.
 *
 * Validates: Requirements 37.3.
 *
 * Property 7 (design): _For any_ sequence of writes to the Audit_Service
 * followed by any attempt to update or delete a stored entry, the update/delete
 * is rejected and every previously stored entry remains byte-for-byte
 * unchanged.
 *
 * There is no live database in this environment, so immutability is asserted
 * against the three defenses the design layers in depth:
 *
 *   1. **No public mutation surface.** Neither {@link AuditService} nor
 *      {@link AuditLogRepository} exposes any update/delete/remove/patch-style
 *      method. We assert this two ways: a fast-check property probes the public
 *      surface with arbitrary mutation-verb method names and finds none, and a
 *      structural check pins the repository's own declared methods to exactly
 *      `{append, query}`. (The base {@link TenantScopedRepository} keeps its
 *      `updateById`/`deleteById` primitives `protected` — a type-level
 *      guarantee — so they are deliberately *not* part of either public API.)
 *
 *   2. **Only INSERT and SELECT are ever issued.** For ANY arbitrary sequence
 *      of record/query/retention operations driven through the service, a fake
 *      {@link SqlClient} captures every emitted statement; we assert the leading
 *      verb is always INSERT or SELECT and never UPDATE/DELETE (or any other
 *      mutating verb), so a stored row can never be altered through the public
 *      API regardless of inputs.
 *
 *   3. **The database blocks UPDATE/DELETE.** A structural scan of the
 *      `audit_logs` migration (0010) confirms the append-only guard trigger and
 *      its BEFORE UPDATE / BEFORE DELETE wiring exist as the last line of
 *      defense.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { loadMigrations } from '../db/migrations.js';
import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import { AuditLogRepository, AuditService } from './index.js';

// ---------------------------------------------------------------------------
// Fake SqlClient that captures every issued statement (no live DB).
// ---------------------------------------------------------------------------

/** A single captured query: its SQL text and bound positional parameters. */
interface CapturedQuery {
  text: string;
  params: unknown[];
}

/**
 * A fake {@link SqlClient} that records every query. For INSERTs it echoes a row
 * built from the bound parameters so `append`'s `RETURNING *` mapper has data;
 * reads return an empty result set. Mirrors the helper in
 * `audit-service.test.ts`.
 */
class CapturingSqlClient implements SqlClient {
  readonly queries: CapturedQuery[] = [];

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ text, params });
    if (/^\s*INSERT INTO/i.test(text)) {
      return { rows: [echoInsertRow(text, params)] };
    }
    return { rows: [] };
  }
}

/** Reconstruct the inserted row from the captured INSERT text + params. */
function echoInsertRow(text: string, params: unknown[]): SqlRow {
  const columnList = /\(([^)]+)\) VALUES/.exec(text)?.[1] ?? '';
  const columns = columnList.split(',').map((c) => c.trim().replace(/"/g, ''));
  const row: SqlRow = {};
  columns.forEach((column, index) => {
    row[column] = params[index];
  });
  return row;
}

/** The leading SQL verb of a statement, upper-cased (e.g. `INSERT`, `SELECT`). */
function leadingVerb(text: string): string {
  return /^\s*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase() ?? '';
}

/** SQL verbs that would mutate or destroy a stored audit row. */
const MUTATING_VERBS = new Set(['UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'MERGE']);

// ---------------------------------------------------------------------------
// Generators over the audit input space.
// ---------------------------------------------------------------------------

/** Any valid ISO-8601 instant within a sane range. */
const isoInstantArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 4_102_444_800_000 }) // 1970 .. 2100
  .map((ms) => new Date(ms).toISOString());

/** Optional structured metadata (round-trips through JSON.stringify). */
const metadataArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string(),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
);

/** An arbitrary tenant-agnostic audit event. */
const auditEventArb = fc.record(
  {
    action: fc.string(),
    resourceType: fc.string(),
    resourceId: fc.string(),
    actorId: fc.option(fc.string(), { nil: undefined }),
    ip: fc.option(fc.string(), { nil: undefined }),
    userAgent: fc.option(fc.string(), { nil: undefined }),
    timestamp: fc.option(isoInstantArb, { nil: undefined }),
    metadata: fc.option(metadataArb, { nil: undefined }),
  },
  { requiredKeys: ['action', 'resourceType', 'resourceId'] },
);

/** A valid tenant context (non-empty Organization + actor). */
const validCtxArb: fc.Arbitrary<TenantContext> = fc.record({
  organizationId: fc.string({ minLength: 1 }),
  userId: fc.string({ minLength: 1 }),
});

/** A malformed context that must fail closed before any SQL is issued. */
const invalidCtxArb = fc.constantFrom<unknown>(
  null,
  undefined,
  { organizationId: '', userId: 'u' },
  { userId: 'u' },
  { organizationId: 'org-1', userId: '' },
);

/** Either a valid or a malformed context (both must never emit mutating SQL). */
const ctxArb = fc.oneof(validCtxArb, invalidCtxArb) as fc.Arbitrary<TenantContext>;

/** An arbitrary filtered query (Organization scope leads). */
const auditQueryArb = fc.record(
  {
    organizationId: fc.string({ minLength: 1 }),
    actorId: fc.option(fc.string(), { nil: undefined }),
    action: fc.option(fc.string(), { nil: undefined }),
    resourceType: fc.option(fc.string(), { nil: undefined }),
    resourceId: fc.option(fc.string(), { nil: undefined }),
    from: fc.option(isoInstantArb, { nil: undefined }),
    to: fc.option(isoInstantArb, { nil: undefined }),
    limit: fc.option(fc.nat({ max: 500 }), { nil: undefined }),
    offset: fc.option(fc.nat({ max: 500 }), { nil: undefined }),
  },
  { requiredKeys: ['organizationId'] },
);

/** One operation against the public surface: record, query, or retention scan. */
const opArb = fc.oneof(
  fc.record({ kind: fc.constant('record' as const), ctx: ctxArb, event: auditEventArb }),
  fc.record({ kind: fc.constant('query' as const), filter: auditQueryArb }),
  fc.record({ kind: fc.constant('expired' as const), organizationId: fc.string({ minLength: 1 }) }),
);

const opsArb = fc.array(opArb, { minLength: 0, maxLength: 12 });

/** Mutation-verb method names that must NEVER exist on the public surface. */
const mutationMethodArb = fc
  .tuple(
    fc.constantFrom(
      'update',
      'delete',
      'remove',
      'patch',
      'destroy',
      'drop',
      'truncate',
      'modify',
      'edit',
      'replace',
      'upsert',
      'put',
      'set',
      'overwrite',
      'rewrite',
      'mutate',
      'alter',
      'purge',
    ),
    // Arbitrary suffix (e.g. `ById`, `All`, `Record`) so we probe many shapes.
    fc.string({ maxLength: 12 }),
  )
  .map(([verb, suffix]) => `${verb}${suffix}`);

// ---------------------------------------------------------------------------
// Property 7a: no mutation method on the public surface (arbitrary probes).
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 7: Audit immutability', () => {
  // Validates: Requirements 37.3
  it('exposes no update/delete/remove/patch-style method on the service or repository', () => {
    const service = new AuditService(new CapturingSqlClient());
    const repository = new AuditLogRepository(new CapturingSqlClient());

    const serviceSurface = service as unknown as Record<string, unknown>;
    const repoSurface = repository as unknown as Record<string, unknown>;

    fc.assert(
      fc.property(mutationMethodArb, (probe) => {
        // No arbitrary mutation-named method is callable on either public API.
        expect(typeof serviceSurface[probe]).not.toBe('function');
        expect(typeof repoSurface[probe]).not.toBe('function');
      }),
      { numRuns: 200 },
    );
  });

  // Validates: Requirements 37.3
  it('only ever issues INSERT and SELECT — never UPDATE/DELETE — for any operation sequence', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        const sql = new CapturingSqlClient();
        let counter = 0;
        const service = new AuditService(sql, {
          idFactory: () => `audit-${++counter}`,
          now: () => new Date('2026-06-02T12:00:00.000Z'),
        });

        // Drive an arbitrary sequence of public operations. Inputs that fail
        // closed (malformed context, empty Organization) simply throw and emit
        // no SQL — which still satisfies the immutability invariant.
        for (const op of ops) {
          try {
            if (op.kind === 'record') {
              await service.record(op.ctx, op.event as never);
            } else if (op.kind === 'query') {
              await service.query(op.filter as never);
            } else {
              await service.expiredBefore(op.organizationId);
            }
          } catch {
            // Fail-closed paths emit no SQL; ignore for the verb invariant.
          }
        }

        for (const { text } of sql.queries) {
          const verb = leadingVerb(text);
          // Every emitted statement is a read or an append, never a mutation.
          expect(['INSERT', 'SELECT']).toContain(verb);
          expect(MUTATING_VERBS.has(verb)).toBe(false);
          // Defensive: the text never targets audit_logs with a mutating verb.
          expect(/\b(UPDATE|DELETE\s+FROM)\b/i.test(text)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Validates: Requirements 37.3
  it('appends are immutable: every record emits exactly one INSERT and no later statement alters it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(auditEventArb, { minLength: 1, maxLength: 8 }), async (events) => {
        const sql = new CapturingSqlClient();
        let counter = 0;
        const service = new AuditService(sql, {
          idFactory: () => `audit-${++counter}`,
          now: () => new Date('2026-06-02T12:00:00.000Z'),
        });
        const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };

        for (const event of events) {
          await service.record(ctx, event as never);
        }

        const inserts = sql.queries.filter((q) => leadingVerb(q.text) === 'INSERT');
        // Completeness: one append per recorded event, nothing more, nothing less.
        expect(inserts).toHaveLength(events.length);
        // Immutability: no statement of any kind rewrites a stored row.
        for (const { text } of sql.queries) {
          expect(MUTATING_VERBS.has(leadingVerb(text))).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Structural complements (deterministic): public surface + DB guard trigger.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 7: append-only public surface (Req 37.3)', () => {
  it('declares exactly append + query as the repository public methods', () => {
    // The repository class itself introduces no mutation method. (The inherited
    // updateById/deleteById primitives are `protected` on the base class — a
    // type-level guarantee — and are therefore not part of the public API.)
    const own = Object.getOwnPropertyNames(AuditLogRepository.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(own.sort()).toEqual(['append', 'query']);
  });

  it('exposes only append-and-query operations on the service', () => {
    const own = Object.getOwnPropertyNames(AuditService.prototype).filter(
      (name) => name !== 'constructor',
    );
    // record / recordReturning (append) + query / expiredBefore (read) only.
    expect(own.sort()).toEqual(['expiredBefore', 'query', 'record', 'recordReturning']);
    for (const name of own) {
      expect(MUTATING_VERBS.has(name.toUpperCase())).toBe(false);
      expect(/^(update|delete|remove|patch|destroy|drop|truncate)/i.test(name)).toBe(false);
    }
  });
});

describe('Feature: auxify-ai-platform, Property 7: database append-only guard (Req 37.3)', () => {
  it('migration installs a trigger that blocks UPDATE and DELETE on audit_logs', () => {
    const auditMigration = loadMigrations().find((m) => /audit/i.test(m.id));
    expect(auditMigration).toBeDefined();
    const sql = auditMigration!.sql;

    // The guard function raises on any mutation.
    expect(/CREATE OR REPLACE FUNCTION audit_logs_block_mutation/i.test(sql)).toBe(true);
    expect(/RAISE EXCEPTION/i.test(sql)).toBe(true);

    // Wired BEFORE both UPDATE and DELETE on audit_logs.
    expect(/CREATE TRIGGER audit_logs_no_update\s+BEFORE UPDATE ON audit_logs/i.test(sql)).toBe(
      true,
    );
    expect(/CREATE TRIGGER audit_logs_no_delete\s+BEFORE DELETE ON audit_logs/i.test(sql)).toBe(
      true,
    );
    expect(/EXECUTE FUNCTION audit_logs_block_mutation/i.test(sql)).toBe(true);
  });
});
