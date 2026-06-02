/**
 * Owner-scoped repository over the `personas` table (migration 0004; Req 9.4).
 *
 * Unlike most platform tables, `personas` is **user-owned, not Organization-
 * scoped**: it carries a nullable `owner_id` (NULL for built-in/system rows) and
 * has no `organization_id` column. Custom personas therefore belong to a user,
 * and "a custom persona for that user" (Req 9.4) is enforced by scoping every
 * read and write to `owner_id = ctx.userId`.
 *
 * Because the standard {@link TenantScopedRepository} injects an
 * `organization_id` predicate (which this table lacks), this repository instead
 * builds parameterized SQL directly on the narrow {@link SqlClient} port using
 * the shared fragment builders, while still:
 *   - requiring a {@link TenantContext} on every call (guarded by
 *     {@link assertTenantContext}), and
 *   - forcing `owner_id` onto every insert and into every read/write predicate,
 *     so a user can never read or mutate another user's custom personas.
 *
 * The `variables` JSONB column is mapped to/from {@link VariableDef}[]; the
 * repository tolerates either a parsed array (real `pg` JSONB) or a JSON string
 * (some drivers/fakes) on read.
 */

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlRow } from '../storage/pgvector.js';
import {
  assertTenantContext,
  ParamCollector,
  renderInsertColumns,
  type ColumnValue,
} from '../repositories/index.js';
import type { PersonaRecord, PersonaStore, VariableDef } from './types.js';

/** Coerce a value to a string, or `null` for nullish. */
function asStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Parse the `variables` JSONB column into {@link VariableDef}[] (tolerant of string or array). */
function parseVariables(value: unknown): VariableDef[] {
  let raw: unknown = value;
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const variables: VariableDef[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string') continue;
    const variable: VariableDef = { name: record.name };
    if (typeof record.description === 'string') variable.description = record.description;
    if (typeof record.required === 'boolean') variable.required = record.required;
    if (typeof record.defaultValue === 'string') variable.defaultValue = record.defaultValue;
    variables.push(variable);
  }
  return variables;
}

/**
 * Tenant-aware, owner-scoped repository for custom personas (Req 9.4).
 *
 * Implements the {@link PersonaStore} port the Persona_Manager composes.
 */
export class PersonaRepository implements PersonaStore {
  constructor(
    private readonly sql: SqlClient,
    private readonly table = 'personas',
  ) {}

  /** Map a DB row to the domain {@link PersonaRecord}. */
  private toRecord(row: SqlRow): PersonaRecord {
    return {
      id: String(row.id),
      ownerId: asStringOrNull(row.owner_id),
      name: String(row.name ?? ''),
      category: String(row.category ?? ''),
      systemPrompt: String(row.system_prompt ?? ''),
      isDefault: Boolean(row.is_default),
      variables: parseVariables(row.variables),
      createdAt: String(row.created_at ?? ''),
    };
  }

  /**
   * Insert a custom persona owned by the acting user (Req 9.4).
   *
   * `owner_id` is forced to `ctx.userId` regardless of the supplied record, so a
   * caller can never create a persona under another user.
   */
  async create(ctx: TenantContext, record: PersonaRecord): Promise<PersonaRecord> {
    assertTenantContext(ctx);
    const columns: ColumnValue[] = [
      { column: 'id', value: record.id },
      { column: 'owner_id', value: ctx.userId },
      { column: 'name', value: record.name },
      { column: 'category', value: record.category },
      { column: 'system_prompt', value: record.systemPrompt },
      { column: 'is_default', value: record.isDefault },
      { column: 'variables', value: JSON.stringify(record.variables) },
    ];
    const params = new ParamCollector();
    const { columns: cols, placeholders } = renderInsertColumns(columns, params);
    const text = `INSERT INTO ${this.table} (${cols}) VALUES (${placeholders}) RETURNING *`;
    const result = await this.sql.query(text, params.params);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`INSERT into ${this.table} returned no row`);
    }
    return this.toRecord(row);
  }

  /** Fetch one of the acting user's custom personas by id, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<PersonaRecord | null> {
    assertTenantContext(ctx);
    const params = new ParamCollector();
    const idP = params.add(id);
    const ownerP = params.add(ctx.userId);
    const text = `SELECT * FROM ${this.table} WHERE id = ${idP} AND owner_id = ${ownerP} LIMIT 1`;
    const result = await this.sql.query(text, params.params);
    const row = result.rows[0];
    return row === undefined ? null : this.toRecord(row);
  }

  /** List the acting user's custom personas, most recently created first. */
  async listOwned(ctx: TenantContext): Promise<PersonaRecord[]> {
    assertTenantContext(ctx);
    const params = new ParamCollector();
    const ownerP = params.add(ctx.userId);
    const text =
      `SELECT * FROM ${this.table} WHERE owner_id = ${ownerP} ` + `ORDER BY created_at DESC`;
    const result = await this.sql.query(text, params.params);
    return result.rows.map((row) => this.toRecord(row));
  }
}
