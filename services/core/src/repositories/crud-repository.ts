/**
 * A generic, tenant-scoped CRUD repository (Req 1.2, 44.1).
 *
 * Most tenant-scoped tables need only the standard create/read/update/delete/list
 * operations with the Organization predicate injected automatically. Rather than
 * hand-writing a class per table, later tasks can instantiate
 * {@link TenantCrudRepository} (or subclass it) for any such table:
 *
 * ```ts
 * const prompts = new TenantCrudRepository(sql, { table: 'prompt_templates' });
 * await prompts.create(ctx, { id, title, content });   // organization_id forced on
 * await prompts.list(ctx, { orderBy: 'created_at', direction: 'DESC' });
 * ```
 *
 * It exposes the base primitives as a small public surface; every method still
 * requires a {@link TenantContext}, so it is impossible to issue a query without
 * tenant scoping.
 */

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlRow } from '../storage/pgvector.js';
import {
  TenantScopedRepository,
  type ListOptions,
  type TenantScopedRepositoryOptions,
} from './base-repository.js';
import type { ColumnValue } from './sql.js';

/** A plain attribute bag for a row, keyed by column name. */
export type RowValues = Record<string, unknown>;

/** Convert a {@link RowValues} bag into ordered {@link ColumnValue} pairs. */
function toColumnValues(values: RowValues): ColumnValue[] {
  return Object.entries(values).map(([column, value]) => ({ column, value }));
}

/**
 * Generic tenant-scoped CRUD over a single table. Construct it directly for
 * simple tables, or subclass it to add domain-specific queries while inheriting
 * the always-tenant-scoped primitives.
 */
export class TenantCrudRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, options: TenantScopedRepositoryOptions) {
    super(sql, options);
  }

  /**
   * Insert a row within the caller's tenant. For a direct scope the tenant
   * column is set automatically; for a parent scope the parent must belong to
   * the tenant or a {@link CrossTenantReferenceError} is thrown.
   */
  async create(ctx: TenantContext, values: RowValues): Promise<SqlRow> {
    return this.insertRow(ctx, toColumnValues(values));
  }

  /** Fetch a single row by id within the caller's tenant, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<SqlRow | null> {
    return this.selectById(ctx, id);
  }

  /** List rows within the caller's tenant, with optional filters/ordering/paging. */
  async list(ctx: TenantContext, options: ListOptions = {}): Promise<SqlRow[]> {
    return this.selectRows(ctx, options);
  }

  /** Update a row by id within the caller's tenant; returns the row or `null`. */
  async update(ctx: TenantContext, id: string, values: RowValues): Promise<SqlRow | null> {
    return this.updateById(ctx, id, toColumnValues(values));
  }

  /** Delete a row by id within the caller's tenant; returns whether it existed. */
  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    return this.deleteById(ctx, id);
  }
}
