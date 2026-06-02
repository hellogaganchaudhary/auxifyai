/**
 * Property-based test for **Property 8: Audit query soundness and completeness**
 * (Req 37.5), the filtered-read half of the Audit_Service (Req 37).
 *
 * Validates: Requirements 37.5
 *
 * Property statement (design.md): _for any_ audit log and any filter over
 * actor, action, resource, Organization, and time range, the set returned by
 * the query equals exactly the set of stored entries that satisfy the filter —
 * no matching entry is omitted (completeness) and no non-matching entry is
 * included (soundness) — most recent first.
 *
 * Which layer enforces the filter, and how this stays faithful without a DB:
 *   - The real {@link AuditService} / {@link AuditLogRepository} build the
 *     **parameterized SQL** (org predicate first, then each supplied dimension,
 *     `ORDER BY "timestamp" DESC, id DESC`, optional LIMIT/OFFSET). That SQL is
 *     the production filter; we do not reimplement it.
 *   - {@link InMemoryAuditSqlClient} is a fake {@link SqlClient} that stores
 *     appended rows and, on SELECT, **faithfully interprets the very WHERE /
 *     ORDER BY / LIMIT / OFFSET the repository emitted** against those rows. So
 *     if the repository built a wrong predicate (e.g. `>` instead of `>=`, or
 *     dropped a clause), the executed result would diverge from the oracle.
 *   - An independent {@link oracle} reimplements the filter semantics directly
 *     from the {@link AuditQuery} object. The test asserts the repository's
 *     returned records equal the oracle's — same set, same most-recent-first
 *     order, same pagination window — proving the contract end to end at the JS
 *     boundary.
 *
 * Rows are seeded through the real `AuditService.record` write path (across
 * several Organizations), so the column round-trip (camelCase ⇄ snake_case,
 * JSONB metadata) is exercised too and the organization scope is genuinely put
 * under test.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import { AuditService, type AuditQuery, type AuditRecord } from './index.js';

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// A fake SqlClient that stores appended rows and faithfully executes the
// repository's emitted SELECT (WHERE / ORDER BY / LIMIT / OFFSET) against them.
// ---------------------------------------------------------------------------

/** Resolve a `$n` placeholder against the positional parameter array. */
function boundValue(params: unknown[], placeholder: string): unknown {
  const index = Number(placeholder.slice(1)) - 1;
  return params[index];
}

/** Most-recent-first row ordering: `"timestamp" DESC, id DESC` (as the SQL). */
function compareRowsMostRecentFirst(a: SqlRow, b: SqlRow): number {
  const ta = Date.parse(String(a.timestamp));
  const tb = Date.parse(String(b.timestamp));
  if (ta !== tb) return tb - ta;
  const ia = String(a.id);
  const ib = String(b.id);
  if (ia < ib) return 1;
  if (ia > ib) return -1;
  return 0;
}

class InMemoryAuditSqlClient implements SqlClient {
  /** The stored `audit_logs` rows, in append order. */
  private readonly rows: SqlRow[] = [];

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    if (/^INSERT INTO/.test(text)) {
      return { rows: [this.applyInsert(text, params)] };
    }
    if (/^SELECT/.test(text)) {
      return { rows: this.applySelect(text, params) };
    }
    return { rows: [] };
  }

  /** Store a row reconstructed from the INSERT's `(cols) VALUES ($1, …)`. */
  private applyInsert(text: string, params: unknown[]): SqlRow {
    const columnList = /\(([^)]+)\) VALUES/.exec(text)?.[1] ?? '';
    const columns = columnList.split(',').map((c) => c.trim().replace(/"/g, ''));
    const row: SqlRow = {};
    columns.forEach((column, index) => {
      row[column] = params[index];
    });
    this.rows.push(row);
    return row;
  }

  /** Execute the repository's emitted SELECT against the stored rows. */
  private applySelect(text: string, params: unknown[]): SqlRow[] {
    const whereBody = /WHERE (.+?) ORDER BY/.exec(text)?.[1];
    if (whereBody === undefined) {
      throw new Error(`Could not parse WHERE clause from: ${text}`);
    }
    const clauses = whereBody.split(' AND ');

    let result = this.rows.filter((row) =>
      clauses.every((clause) => this.evaluateClause(row, clause, params)),
    );

    // ORDER BY "timestamp" DESC, id DESC — most recent first (Req 37.5).
    result = result.slice().sort(compareRowsMostRecentFirst);

    // Pagination: OFFSET skips, then LIMIT caps (Postgres semantics).
    const offsetPlaceholder = /OFFSET (\$\d+)/.exec(text)?.[1];
    if (offsetPlaceholder !== undefined) {
      result = result.slice(Number(boundValue(params, offsetPlaceholder)));
    }
    const limitPlaceholder = /LIMIT (\$\d+)/.exec(text)?.[1];
    if (limitPlaceholder !== undefined) {
      result = result.slice(0, Number(boundValue(params, limitPlaceholder)));
    }
    return result;
  }

  /** Evaluate a single `column (=|>=|<=) $n` predicate against a row. */
  private evaluateClause(row: SqlRow, clause: string, params: unknown[]): boolean {
    const match = /^("?[\w]+"?)\s*(>=|<=|=)\s*(\$\d+)$/.exec(clause.trim());
    if (match === null) {
      throw new Error(`Could not parse predicate: ${clause}`);
    }
    const column = match[1]!.replace(/"/g, '');
    const op = match[2]!;
    const value = boundValue(params, match[3]!);
    const cell = row[column];

    if (op === '=') {
      return String(cell) === String(value);
    }
    // The only range predicates the repository emits are on the timestamp.
    const cellMs = Date.parse(String(cell));
    const boundMs = Date.parse(String(value));
    return op === '>=' ? cellMs >= boundMs : cellMs <= boundMs;
  }
}

// ---------------------------------------------------------------------------
// Independent reference (oracle): filter + order + paginate directly from the
// AuditQuery, with no knowledge of the SQL.
// ---------------------------------------------------------------------------

/** Does a record satisfy every constraint the filter sets? (no pagination) */
function recordMatchesFilter(record: AuditRecord, filter: AuditQuery): boolean {
  if (record.organizationId !== filter.organizationId) return false;
  if (filter.actorId !== undefined && record.actorId !== filter.actorId) return false;
  if (filter.action !== undefined && record.action !== filter.action) return false;
  if (filter.resourceType !== undefined && record.resourceType !== filter.resourceType) {
    return false;
  }
  if (filter.resourceId !== undefined && record.resourceId !== filter.resourceId) return false;
  if (filter.from !== undefined && Date.parse(record.timestamp) < Date.parse(filter.from)) {
    return false;
  }
  if (filter.to !== undefined && Date.parse(record.timestamp) > Date.parse(filter.to)) {
    return false;
  }
  return true;
}

/** Most-recent-first record ordering, matching the SQL `ORDER BY`. */
function compareRecordsMostRecentFirst(a: AuditRecord, b: AuditRecord): number {
  const ta = Date.parse(a.timestamp);
  const tb = Date.parse(b.timestamp);
  if (ta !== tb) return tb - ta;
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/** The exact set/order/window the query is contractually required to return. */
function oracle(dataset: AuditRecord[], filter: AuditQuery): AuditRecord[] {
  let result = dataset
    .filter((record) => recordMatchesFilter(record, filter))
    .sort(compareRecordsMostRecentFirst);
  result = result.slice(filter.offset ?? 0);
  if (filter.limit !== undefined) {
    result = result.slice(0, filter.limit);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Generators — small pools so filters genuinely overlap the dataset.
// ---------------------------------------------------------------------------

/** Several Organizations so the org scope must exclude foreign rows. */
const ORG_IDS = ['org-a', 'org-b', 'org-c'] as const;
const ACTOR_IDS = ['user-1', 'user-2', 'user-3'] as const;
const ACTIONS = ['access.denied', 'project.move', 'auth.login.failed'] as const;
const RESOURCE_TYPES = ['document', 'project', 'user'] as const;
const RESOURCE_IDS = ['res-1', 'res-2', 'res-3', 'res-4'] as const;

/**
 * A fixed pool of canonical ISO-8601 instants — with repeats expected across
 * records (ties) and reused as from/to bounds so the inclusive `>=` / `<=`
 * boundary cases are exercised exactly.
 */
const TIMESTAMPS = [
  '2024-01-01T00:00:00.000Z',
  '2024-06-15T12:30:00.000Z',
  '2025-01-01T00:00:00.000Z',
  '2025-03-20T08:00:00.000Z',
  '2025-12-31T23:59:59.000Z',
  '2026-06-02T12:00:00.000Z',
] as const;

interface RecordInput {
  organizationId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  timestamp: string;
}

const recordInputArb: fc.Arbitrary<RecordInput> = fc.record({
  organizationId: fc.constantFrom(...ORG_IDS),
  actorId: fc.constantFrom(...ACTOR_IDS),
  action: fc.constantFrom(...ACTIONS),
  resourceType: fc.constantFrom(...RESOURCE_TYPES),
  resourceId: fc.constantFrom(...RESOURCE_IDS),
  timestamp: fc.constantFrom(...TIMESTAMPS),
});

/** Datasets from empty up to a couple dozen rows. */
const datasetArb: fc.Arbitrary<RecordInput[]> = fc.array(recordInputArb, { maxLength: 25 });

/** The optional, non-paginating filter dimensions (org is mandatory). */
const filterFieldsArb = fc.record({
  organizationId: fc.constantFrom(...ORG_IDS),
  actorId: fc.option(fc.constantFrom(...ACTOR_IDS), { nil: undefined }),
  action: fc.option(fc.constantFrom(...ACTIONS), { nil: undefined }),
  resourceType: fc.option(fc.constantFrom(...RESOURCE_TYPES), { nil: undefined }),
  resourceId: fc.option(fc.constantFrom(...RESOURCE_IDS), { nil: undefined }),
  from: fc.option(fc.constantFrom(...TIMESTAMPS), { nil: undefined }),
  to: fc.option(fc.constantFrom(...TIMESTAMPS), { nil: undefined }),
});

/** A filter that also exercises the LIMIT/OFFSET window. */
const paginatedFilterArb: fc.Arbitrary<AuditQuery> = fc.record({
  organizationId: fc.constantFrom(...ORG_IDS),
  actorId: fc.option(fc.constantFrom(...ACTOR_IDS), { nil: undefined }),
  action: fc.option(fc.constantFrom(...ACTIONS), { nil: undefined }),
  resourceType: fc.option(fc.constantFrom(...RESOURCE_TYPES), { nil: undefined }),
  resourceId: fc.option(fc.constantFrom(...RESOURCE_IDS), { nil: undefined }),
  from: fc.option(fc.constantFrom(...TIMESTAMPS), { nil: undefined }),
  to: fc.option(fc.constantFrom(...TIMESTAMPS), { nil: undefined }),
  limit: fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
  offset: fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
});

// ---------------------------------------------------------------------------
// Harness: a fresh Audit_Service over an in-memory client, seeded via the real
// record() write path so query() reads exactly what was appended.
// ---------------------------------------------------------------------------

/** Build a service with deterministic, lexicographically-ordered ids. */
function makeService(): { service: AuditService; sql: InMemoryAuditSqlClient } {
  const sql = new InMemoryAuditSqlClient();
  let counter = 0;
  const service = new AuditService(sql, {
    idFactory: () => `audit-${String(counter++).padStart(4, '0')}`,
  });
  return { service, sql };
}

/** Append every input through the real write path; return the stored records. */
async function seed(service: AuditService, inputs: RecordInput[]): Promise<AuditRecord[]> {
  const stored: AuditRecord[] = [];
  for (const input of inputs) {
    const ctx: TenantContext = {
      organizationId: input.organizationId,
      userId: input.actorId,
    };
    const record = await service.recordReturning(ctx, {
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      timestamp: input.timestamp,
    });
    stored.push(record);
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Property 8.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 8: Audit query soundness and completeness', () => {
  it('returns exactly the matching entries — sound and complete — for any filter (Validates: Requirements 37.5)', async () => {
    await fc.assert(
      fc.asyncProperty(datasetArb, filterFieldsArb, async (inputs, filter) => {
        const { service } = makeService();
        const dataset = await seed(service, inputs);

        const actual = await service.query(filter);
        const expected = oracle(dataset, filter);

        // Set + order equality: no matching entry omitted, none non-matching
        // included, most recent first.
        expect(actual).toEqual(expected);

        // Soundness (explicit): every returned record satisfies the filter.
        for (const record of actual) {
          expect(recordMatchesFilter(record, filter)).toBe(true);
        }

        // Completeness (explicit): every stored record that matches the filter
        // appears in the result.
        const returnedIds = new Set(actual.map((r) => r.id));
        for (const record of dataset) {
          if (recordMatchesFilter(record, filter)) {
            expect(returnedIds.has(record.id)).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('orders results most-recent-first and honors the limit/offset window (Validates: Requirements 37.5)', async () => {
    await fc.assert(
      fc.asyncProperty(datasetArb, paginatedFilterArb, async (inputs, filter) => {
        const { service } = makeService();
        const dataset = await seed(service, inputs);

        const actual = await service.query(filter);

        // The paginated window equals the oracle's window exactly (order incl.).
        expect(actual).toEqual(oracle(dataset, filter));

        // Ordering is non-increasing by timestamp (most recent first).
        for (let i = 1; i < actual.length; i += 1) {
          const prev = Date.parse(actual[i - 1]!.timestamp);
          const curr = Date.parse(actual[i]!.timestamp);
          expect(prev).toBeGreaterThanOrEqual(curr);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never returns an entry outside the queried Organization (Validates: Requirements 37.5)', async () => {
    await fc.assert(
      fc.asyncProperty(datasetArb, fc.constantFrom(...ORG_IDS), async (inputs, organizationId) => {
        const { service } = makeService();
        const dataset = await seed(service, inputs);

        const actual = await service.query({ organizationId });

        // Org scope: every returned row belongs to the queried Organization.
        for (const record of actual) {
          expect(record.organizationId).toBe(organizationId);
        }
        // And the whole tenant trail (and only it) is returned.
        expect(actual.length).toBe(
          dataset.filter((r) => r.organizationId === organizationId).length,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
