/**
 * Test fakes for the Policy_Engine: a small in-memory {@link SqlClient}.
 *
 * {@link InMemoryPolicySqlClient} is a purpose-built interpreter for the exact
 * parameterized SQL shapes the {@link PolicyRepository} emits — an
 * `INSERT … RETURNING *` and a tenant-scoped `SELECT * … WHERE org = $ AND
 * scope = $ AND scope_id IN ($, …)`. It supports equality and `IN` predicates
 * (the tenancy fake handles equality only), so Policy_Engine tests run against
 * realistic tenant-scoped behaviour without a database.
 *
 * It is intentionally narrow: it understands only the single-table statements
 * this repository produces, not arbitrary SQL.
 */

import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';

/** Resolve a `$n` placeholder or a literal integer against the parameter list. */
function resolveValue(token: string, params: unknown[]): unknown {
  const trimmed = token.trim();
  if (trimmed.startsWith('$')) {
    const index = Number.parseInt(trimmed.slice(1), 10) - 1;
    return params[index];
  }
  return Number.parseInt(trimmed, 10);
}

/** A parsed equality or set-membership predicate from a WHERE body. */
interface ParsedPredicate {
  column: string;
  values: unknown[];
}

/** Parse `a = $1 AND b IN ($2, $3)` into resolved predicates. */
function parseWhere(whereBody: string, params: unknown[]): ParsedPredicate[] {
  return whereBody
    .split(' AND ')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .map((clause) => {
      const inMatch = /^(\w+)\s+IN\s*\(([^)]*)\)$/i.exec(clause);
      if (inMatch !== null) {
        const tokens = inMatch[2]!
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        return { column: inMatch[1]!, values: tokens.map((t) => resolveValue(t, params)) };
      }
      const eqMatch = /^(\w+)\s*=\s*(\$\d+)$/.exec(clause);
      if (eqMatch !== null) {
        return { column: eqMatch[1]!, values: [resolveValue(eqMatch[2]!, params)] };
      }
      throw new Error(`InMemoryPolicySqlClient: unsupported predicate "${clause}"`);
    });
}

/** Does a row satisfy every predicate (equality or IN-membership)? */
function matchesAll(row: SqlRow, predicates: ParsedPredicate[]): boolean {
  return predicates.every((p) => p.values.some((v) => row[p.column] === v));
}

/** A captured statement: its SQL text and bound positional parameters. */
export interface CapturedQuery {
  text: string;
  params: unknown[];
}

/** An in-memory SQL engine for the policy repository statement shapes. */
export class InMemoryPolicySqlClient implements SqlClient {
  /** Every captured statement, in order, for assertions (e.g. freshness). */
  readonly queries: CapturedQuery[] = [];
  private readonly tables = new Map<string, SqlRow[]>();

  /** Seed a table with rows (e.g. to model another tenant's policies). */
  seed(table: string, rows: SqlRow[]): void {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows.map((r) => ({ ...r }))]);
  }

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ text, params });
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('INSERT INTO')) return this.handleInsert(normalized, params);
    if (normalized.startsWith('SELECT')) return this.handleSelect(normalized, params);
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
      throw new Error(`InMemoryPolicySqlClient: unsupported INSERT "${text}"`);
    }
    const table = match[1]!;
    const columns = match[2]!.split(',').map((c) => c.trim());
    const placeholders = match[3]!.split(',').map((p) => p.trim());
    const row: SqlRow = {};
    columns.forEach((column, i) => {
      row[column] = resolveValue(placeholders[i]!, params);
    });
    if (row.created_at === undefined) {
      row.created_at = new Date('2026-01-01T00:00:00.000Z').toISOString();
    }
    this.tableRows(table).push(row);
    return { rows: [{ ...row }] };
  }

  private handleSelect(text: string, params: unknown[]): SqlQueryResult {
    const match = /^SELECT \* FROM (\w+) WHERE (.+)$/.exec(text);
    if (match === null) {
      throw new Error(`InMemoryPolicySqlClient: unsupported SELECT "${text}"`);
    }
    const table = match[1]!;
    const predicates = parseWhere(match[2]!, params);
    const rows = this.tableRows(table).filter((row) => matchesAll(row, predicates));
    return { rows: rows.map((r) => ({ ...r })) };
  }
}
