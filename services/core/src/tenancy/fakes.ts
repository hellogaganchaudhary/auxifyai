/**
 * Test fakes for the Tenancy_Service: an in-memory {@link SqlClient} and a
 * capturing {@link AuditRecorder}.
 *
 * The {@link InMemorySqlClient} is a small, purpose-built interpreter for the
 * exact parameterized SQL shapes the tenancy repositories emit
 * (`INSERT … RETURNING *`, `SELECT * … WHERE …`, `UPDATE … SET … WHERE …`,
 * `DELETE … WHERE … RETURNING id`). It stores rows per table and applies the
 * AND-ed equality predicates, ordering, and limit/offset, so service tests run
 * against realistic behaviour — including tenant scoping — without a database.
 *
 * It is intentionally narrow: it understands only the equality-predicate,
 * single-table statements this service produces, not arbitrary SQL.
 */

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import type { AuditEvent, AuditRecorder } from './types.js';

/** A captured statement: its SQL text and bound positional parameters. */
export interface CapturedQuery {
  text: string;
  params: unknown[];
}

/** Resolve a `$n` placeholder or a literal integer against the parameter list. */
function resolveValue(token: string, params: unknown[]): unknown {
  const trimmed = token.trim();
  if (trimmed.startsWith('$')) {
    const index = Number.parseInt(trimmed.slice(1), 10) - 1;
    return params[index];
  }
  return Number.parseInt(trimmed, 10);
}

/** A single `col = $n` equality predicate parsed from a WHERE body. */
interface ParsedPredicate {
  column: string;
  value: unknown;
}

/** Parse `a = $1 AND b = $2` into resolved equality predicates. */
function parseWhere(whereBody: string, params: unknown[]): ParsedPredicate[] {
  return whereBody
    .split(' AND ')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .map((clause) => {
      const match = /^(\w+)\s*=\s*(\$\d+)$/.exec(clause);
      if (match === null) {
        throw new Error(`InMemorySqlClient: unsupported predicate "${clause}"`);
      }
      return { column: match[1]!, value: resolveValue(match[2]!, params) };
    });
}

/** Does a row satisfy every equality predicate? */
function matchesAll(row: SqlRow, predicates: ParsedPredicate[]): boolean {
  return predicates.every((p) => row[p.column] === p.value);
}

/**
 * An in-memory SQL engine for the tenancy repository statement shapes. Tables
 * are arrays of plain row objects keyed by table name.
 */
export class InMemorySqlClient implements SqlClient {
  /** Every captured statement, in order, for assertions. */
  readonly queries: CapturedQuery[] = [];
  private readonly tables = new Map<string, SqlRow[]>();

  /** Seed a table with rows (e.g. to model another tenant's data). */
  seed(table: string, rows: SqlRow[]): void {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows.map((r) => ({ ...r }))]);
  }

  /** Snapshot the rows currently stored for a table. */
  rowsOf(table: string): SqlRow[] {
    return (this.tables.get(table) ?? []).map((r) => ({ ...r }));
  }

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ text, params });
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('INSERT INTO')) return this.handleInsert(normalized, params);
    if (normalized.startsWith('SELECT')) return this.handleSelect(normalized, params);
    if (normalized.startsWith('UPDATE')) return this.handleUpdate(normalized, params);
    if (normalized.startsWith('DELETE')) return this.handleDelete(normalized, params);
    // Unrecognized statements (e.g. ledger bootstrap) return no rows.
    return { rows: [] };
  }

  private tableRows(table: string): SqlRow[] {
    let rows = this.tables.get(table);
    if (rows === undefined) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  private handleInsert(text: string, params: unknown[]): SqlQueryResult {
    const match = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\) RETURNING \*$/.exec(text);
    if (match === null) {
      throw new Error(`InMemorySqlClient: unsupported INSERT "${text}"`);
    }
    const table = match[1]!;
    const columns = match[2]!.split(',').map((c) => c.trim());
    const placeholders = match[3]!.split(',').map((p) => p.trim());
    const row: SqlRow = {};
    columns.forEach((column, i) => {
      row[column] = resolveValue(placeholders[i]!, params);
    });
    // Supply a created_at default the migrations would otherwise generate.
    if (row.created_at === undefined) {
      row.created_at = new Date('2026-01-01T00:00:00.000Z').toISOString();
    }
    this.tableRows(table).push(row);
    return { rows: [{ ...row }] };
  }

  private handleSelect(text: string, params: unknown[]): SqlQueryResult {
    const match = /^SELECT \* FROM (\w+) WHERE (.+)$/.exec(text);
    if (match === null) {
      throw new Error(`InMemorySqlClient: unsupported SELECT "${text}"`);
    }
    const table = match[1]!;
    let rest = match[2]!;

    let limit: number | undefined;
    let offset: number | undefined;
    let orderBy: { column: string; direction: 'ASC' | 'DESC' } | undefined;

    const offsetMatch = / OFFSET (\$\d+|\d+)$/.exec(rest);
    if (offsetMatch !== null) {
      offset = Number(resolveValue(offsetMatch[1]!, params));
      rest = rest.slice(0, offsetMatch.index);
    }
    const limitMatch = / LIMIT (\$\d+|\d+)$/.exec(rest);
    if (limitMatch !== null) {
      limit = Number(resolveValue(limitMatch[1]!, params));
      rest = rest.slice(0, limitMatch.index);
    }
    const orderMatch = / ORDER BY (\w+) (ASC|DESC)$/.exec(rest);
    if (orderMatch !== null) {
      orderBy = { column: orderMatch[1]!, direction: orderMatch[2]! as 'ASC' | 'DESC' };
      rest = rest.slice(0, orderMatch.index);
    }

    const predicates = parseWhere(rest, params);
    let rows = this.tableRows(table).filter((row) => matchesAll(row, predicates));

    if (orderBy !== undefined) {
      const { column, direction } = orderBy;
      rows = [...rows].sort((a, b) => {
        const av = String(a[column] ?? '');
        const bv = String(b[column] ?? '');
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return direction === 'DESC' ? -cmp : cmp;
      });
    }
    if (offset !== undefined) rows = rows.slice(offset);
    if (limit !== undefined) rows = rows.slice(0, limit);

    return { rows: rows.map((r) => ({ ...r })) };
  }

  private handleUpdate(text: string, params: unknown[]): SqlQueryResult {
    const match = /^UPDATE (\w+) SET (.+) WHERE (.+) RETURNING \*$/.exec(text);
    if (match === null) {
      throw new Error(`InMemorySqlClient: unsupported UPDATE "${text}"`);
    }
    const table = match[1]!;
    const setBody = match[2]!;
    const whereBody = match[3]!;

    const assignments = setBody.split(',').map((pair) => {
      const m = /^(\w+)\s*=\s*(\$\d+)$/.exec(pair.trim());
      if (m === null) throw new Error(`InMemorySqlClient: unsupported SET "${pair}"`);
      return { column: m[1]!, value: resolveValue(m[2]!, params) };
    });
    const predicates = parseWhere(whereBody, params);

    const updated: SqlRow[] = [];
    for (const row of this.tableRows(table)) {
      if (matchesAll(row, predicates)) {
        for (const a of assignments) row[a.column] = a.value;
        updated.push({ ...row });
      }
    }
    return { rows: updated };
  }

  private handleDelete(text: string, params: unknown[]): SqlQueryResult {
    const match = /^DELETE FROM (\w+) WHERE (.+) RETURNING (\w+)$/.exec(text);
    if (match === null) {
      throw new Error(`InMemorySqlClient: unsupported DELETE "${text}"`);
    }
    const table = match[1]!;
    const whereBody = match[2]!;
    const idColumn = match[3]!;
    const predicates = parseWhere(whereBody, params);

    const rows = this.tableRows(table);
    const deleted: SqlRow[] = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]!;
      if (matchesAll(row, predicates)) {
        deleted.push({ [idColumn]: row[idColumn] });
        rows.splice(i, 1);
      }
    }
    return { rows: deleted };
  }
}

/** A capturing {@link AuditRecorder} that stores every recorded event. */
export class FakeAuditRecorder implements AuditRecorder {
  /** Every recorded event, paired with the Organization and actor it was scoped to. */
  readonly events: Array<AuditEvent & { organizationId: string; actorId: string }> = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.events.push({
      ...event,
      organizationId: ctx.organizationId,
      actorId: event.actorId ?? ctx.userId,
    });
  }

  /** All recorded events with the given action. */
  withAction(action: string): Array<AuditEvent & { organizationId: string; actorId: string }> {
    return this.events.filter((e) => e.action === action);
  }
}

/** A {@link SessionInvalidator} fake that records which users it revoked. */
export class FakeSessionInvalidator {
  readonly invalidated: string[] = [];

  async invalidateAllForUser(userId: string): Promise<void> {
    this.invalidated.push(userId);
  }
}
