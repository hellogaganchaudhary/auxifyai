/**
 * The abstract tenant-scoped repository (application-layer tenant scoping, Req 1.2).
 *
 * This is the centralizing arm of the platform's defense-in-depth tenant
 * isolation (design "Multi-Tenancy Model"). Every read, write, and delete that
 * flows through this base:
 *
 *   1. requires a {@link TenantContext} (enforced by the TypeScript surface and
 *      re-checked at runtime by {@link assertTenantContext}), and
 *   2. automatically injects the Organization predicate **first** into every
 *      statement, so a query can never be issued without tenant scoping.
 *
 * Two scoping strategies are supported so the same machinery serves every
 * tenant-scoped table:
 *
 *   - {@link DirectTenantScope} — the table carries an `organization_id` column
 *     (organizations' descendants such as `conversations`). Reads/updates/deletes
 *     add `organization_id = $n`; inserts force `organization_id` onto the row.
 *   - {@link ParentTenantScope} — the table is scoped through a parent's
 *     `organization_id` (e.g. `messages` via their `conversation_id`). Reads add
 *     a `fk IN (SELECT id FROM parent WHERE organization_id = $n)` predicate;
 *     inserts are guarded by an `EXISTS` check so a child can never be attached
 *     to another tenant's parent (a {@link CrossTenantReferenceError} otherwise).
 *
 * The narrow {@link SqlClient} port keeps the layer driver-agnostic and unit
 * testable with a fake client that captures the issued SQL and parameters.
 */

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlRow } from '../storage/pgvector.js';
import { CrossTenantReferenceError, assertTenantContext } from './errors.js';
import {
  ParamCollector,
  renderInsertColumns,
  renderPredicates,
  renderSetClause,
  type ColumnValue,
  type Predicate,
} from './sql.js';

/** A table that carries the tenant column (`organization_id`) directly. */
export interface DirectTenantScope {
  kind: 'direct';
  /** The tenant column on this table. Defaults to `organization_id`. */
  column?: string;
}

/** A table scoped through a parent row's tenant column. */
export interface ParentTenantScope {
  kind: 'parent';
  /** The foreign-key column on this table that references the parent's id. */
  foreignKey: string;
  /** The parent table that carries the tenant column. */
  parentTable: string;
  /** The parent's primary-key column. Defaults to `id`. */
  parentIdColumn?: string;
  /** The parent's tenant column. Defaults to `organization_id`. */
  parentTenantColumn?: string;
}

/** How a repository's table is bound to an Organization. */
export type TenantScope = DirectTenantScope | ParentTenantScope;

/** Construction options shared by every tenant-scoped repository. */
export interface TenantScopedRepositoryOptions {
  /** The table this repository owns (a trusted identifier, never user input). */
  table: string;
  /** How the table is tenant-scoped. Defaults to a direct `organization_id` column. */
  scope?: TenantScope;
  /** The table's primary-key column. Defaults to `id`. */
  idColumn?: string;
}

/** Options for a tenant-scoped list/select. */
export interface ListOptions {
  /** Extra predicates AND-ed *after* the mandatory tenant predicate. */
  where?: Predicate[];
  /** Column to order by (a trusted identifier). */
  orderBy?: string;
  /** Sort direction. Defaults to `ASC`. */
  direction?: 'ASC' | 'DESC';
  /** Maximum rows to return. */
  limit?: number;
  /** Rows to skip. */
  offset?: number;
}

/**
 * Base class that all tenant-scoped repositories extend. Subclasses supply a
 * table and scope, then expose domain methods built on the `protected`
 * primitives here — never issuing SQL that omits the tenant predicate.
 */
export abstract class TenantScopedRepository {
  /** The owned table (trusted identifier). */
  protected readonly table: string;
  /** How the table is bound to an Organization. */
  protected readonly scope: TenantScope;
  /** The primary-key column. */
  protected readonly idColumn: string;

  protected constructor(
    protected readonly sql: SqlClient,
    options: TenantScopedRepositoryOptions,
  ) {
    this.table = options.table;
    this.scope = options.scope ?? { kind: 'direct' };
    this.idColumn = options.idColumn ?? 'id';
  }

  /** The tenant column for a direct scope (defaults to `organization_id`). */
  private directColumn(): string {
    return this.scope.kind === 'direct'
      ? (this.scope.column ?? 'organization_id')
      : 'organization_id';
  }

  /**
   * Render the mandatory Organization predicate, binding `ctx.organizationId`
   * through `params`. This is the single place the tenant scope is produced for
   * SELECT/UPDATE/DELETE; both scope strategies route through here.
   */
  private renderTenantPredicate(ctx: TenantContext, params: ParamCollector): string {
    if (this.scope.kind === 'direct') {
      return `${this.directColumn()} = ${params.add(ctx.organizationId)}`;
    }
    const parentId = this.scope.parentIdColumn ?? 'id';
    const parentTenant = this.scope.parentTenantColumn ?? 'organization_id';
    return `${this.scope.foreignKey} IN (SELECT ${parentId} FROM ${this.scope.parentTable} WHERE ${parentTenant} = ${params.add(ctx.organizationId)})`;
  }

  /**
   * Build a full `WHERE` body with the tenant predicate FIRST, followed by any
   * caller predicates. Guarantees no statement is ever issued without the
   * Organization scope leading the conjunction.
   */
  private buildWhere(ctx: TenantContext, params: ParamCollector, extra: Predicate[] = []): string {
    const tenant = this.renderTenantPredicate(ctx, params);
    if (extra.length === 0) return tenant;
    return `${tenant} AND ${renderPredicates(extra, params)}`;
  }

  /** Tenant-scoped `SELECT *`. Always carries the Organization predicate. */
  protected async selectRows(ctx: TenantContext, options: ListOptions = {}): Promise<SqlRow[]> {
    assertTenantContext(ctx);
    const params = new ParamCollector();
    const where = this.buildWhere(ctx, params, options.where ?? []);
    let text = `SELECT * FROM ${this.table} WHERE ${where}`;
    if (options.orderBy !== undefined) {
      const direction = options.direction === 'DESC' ? 'DESC' : 'ASC';
      text += ` ORDER BY ${options.orderBy} ${direction}`;
    }
    if (options.limit !== undefined) {
      text += ` LIMIT ${params.add(options.limit)}`;
    }
    if (options.offset !== undefined) {
      text += ` OFFSET ${params.add(options.offset)}`;
    }
    const result = await this.sql.query(text, params.params);
    return result.rows;
  }

  /** Tenant-scoped fetch of a single row by primary key. */
  protected async selectById(ctx: TenantContext, id: string): Promise<SqlRow | null> {
    const rows = await this.selectRows(ctx, {
      where: [{ column: this.idColumn, value: id }],
      limit: 1,
    });
    return rows[0] ?? null;
  }

  /**
   * Tenant-scoped INSERT. For a direct scope the tenant column is forced onto
   * the row (overriding any caller-supplied value); for a parent scope the
   * insert is guarded by an `EXISTS` check against the parent's tenant so a
   * child can never be created under another Organization's parent.
   *
   * @returns The inserted row (`RETURNING *`).
   * @throws CrossTenantReferenceError if the parent does not belong to the tenant.
   */
  protected async insertRow(ctx: TenantContext, columnValues: ColumnValue[]): Promise<SqlRow> {
    assertTenantContext(ctx);

    if (this.scope.kind === 'direct') {
      const tenantColumn = this.directColumn();
      const withoutTenant = columnValues.filter((cv) => cv.column !== tenantColumn);
      const finalValues: ColumnValue[] = [
        { column: tenantColumn, value: ctx.organizationId },
        ...withoutTenant,
      ];
      const params = new ParamCollector();
      const { columns, placeholders } = renderInsertColumns(finalValues, params);
      const text = `INSERT INTO ${this.table} (${columns}) VALUES (${placeholders}) RETURNING *`;
      const result = await this.sql.query(text, params.params);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`INSERT into ${this.table} returned no row`);
      }
      return row;
    }

    // Parent scope: the row must reference a parent owned by this tenant.
    const scope = this.scope;
    const fk = columnValues.find((cv) => cv.column === scope.foreignKey);
    if (fk === undefined) {
      throw new Error(
        `INSERT into ${this.table} is missing the tenant foreign key "${scope.foreignKey}"`,
      );
    }
    const parentId = scope.parentIdColumn ?? 'id';
    const parentTenant = scope.parentTenantColumn ?? 'organization_id';

    const params = new ParamCollector();
    const columns = columnValues.map((cv) => cv.column).join(', ');
    const selectValues = columnValues.map((cv) => params.add(cv.value));
    const fkPlaceholder = params.add(fk.value);
    const orgPlaceholder = params.add(ctx.organizationId);
    const text =
      `INSERT INTO ${this.table} (${columns}) ` +
      `SELECT ${selectValues.join(', ')} ` +
      `WHERE EXISTS (SELECT 1 FROM ${scope.parentTable} ` +
      `WHERE ${parentId} = ${fkPlaceholder} AND ${parentTenant} = ${orgPlaceholder}) ` +
      `RETURNING *`;
    const result = await this.sql.query(text, params.params);
    const row = result.rows[0];
    if (row === undefined) {
      throw new CrossTenantReferenceError(
        `Cannot insert into ${this.table}: ${scope.foreignKey} does not reference a ${scope.parentTable} row in the current tenant`,
      );
    }
    return row;
  }

  /**
   * Tenant-scoped UPDATE by primary key. The tenant column can never be
   * reassigned by an update; the Organization predicate scopes the rows.
   *
   * @returns The updated row, or `null` if no tenant-scoped row matched.
   */
  protected async updateById(
    ctx: TenantContext,
    id: string,
    set: ColumnValue[],
  ): Promise<SqlRow | null> {
    assertTenantContext(ctx);
    const tenantColumn = this.directColumn();
    const safeSet = set.filter((cv) => cv.column !== tenantColumn && cv.column !== this.idColumn);
    if (safeSet.length === 0) {
      // Nothing to update beyond immutable columns; return the current row.
      return this.selectById(ctx, id);
    }
    const params = new ParamCollector();
    const setClause = renderSetClause(safeSet, params);
    const where = this.buildWhere(ctx, params, [{ column: this.idColumn, value: id }]);
    const text = `UPDATE ${this.table} SET ${setClause} WHERE ${where} RETURNING *`;
    const result = await this.sql.query(text, params.params);
    return result.rows[0] ?? null;
  }

  /**
   * Tenant-scoped DELETE by primary key.
   *
   * @returns `true` if a tenant-scoped row was deleted, `false` otherwise.
   */
  protected async deleteById(ctx: TenantContext, id: string): Promise<boolean> {
    assertTenantContext(ctx);
    const params = new ParamCollector();
    const where = this.buildWhere(ctx, params, [{ column: this.idColumn, value: id }]);
    const text = `DELETE FROM ${this.table} WHERE ${where} RETURNING ${this.idColumn}`;
    const result = await this.sql.query(text, params.params);
    return result.rows.length > 0;
  }
}
