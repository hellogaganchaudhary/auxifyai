/**
 * Tenant-scoped repository over the `policies` table (migration 0002).
 *
 * Policies are Organization-scoped, so this repository extends
 * {@link TenantScopedRepository} with a direct `organization_id` scope: every
 * read carries the Organization predicate and can never cross a tenant boundary
 * (Req 1.2, 1.4). It maps the snake_case SQL rows (`scope`, `scope_id`,
 * `allow_list`) to the camelCase {@link Policy} records the Policy_Engine
 * evaluates.
 *
 * The repository performs **no caching** of its own: every call issues a fresh
 * query, so a policy change is reflected on the next resolution (Req 19.7).
 */

import type { TenantContext } from '@auxify/types';

import { TenantScopedRepository } from '../repositories/base-repository.js';
import type { SqlClient, SqlRow } from '../storage/pgvector.js';
import type { AllowListEntry, Policy, PolicyScope } from './types.js';

/** Parse a JSONB column that may arrive as a string or already-parsed value. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/**
 * Repository over `policies`, always scoped to the caller's Organization.
 *
 * Exposes the read paths the Policy_Engine needs (fetch by scope, and a bulk
 * fetch for a principal's applicable scope ids) plus a thin `create` used by
 * tests and administrative wiring; resolution itself is pure and lives in the
 * engine.
 */
export class PolicyRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'policies') {
    super(sql, { table, scope: { kind: 'direct', column: 'organization_id' } });
  }

  private toRecord(row: SqlRow): Policy {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      scope: String(row.scope) as PolicyScope,
      scopeId: String(row.scope_id),
      allowList: parseJson<AllowListEntry[]>(row.allow_list, []),
    };
  }

  /** Persist a policy within the caller's Organization (administrative/test path). */
  async create(
    ctx: TenantContext,
    input: { id: string; scope: PolicyScope; scopeId: string; allowList: AllowListEntry[] },
  ): Promise<Policy> {
    const row = await this.insertRow(ctx, [
      { column: 'id', value: input.id },
      { column: 'scope', value: input.scope },
      { column: 'scope_id', value: input.scopeId },
      { column: 'allow_list', value: JSON.stringify(input.allowList) },
    ]);
    return this.toRecord(row);
  }

  /**
   * Fetch every policy at a given precedence level whose `scope_id` is in the
   * provided set, within the caller's Organization. An empty `scopeIds` yields
   * an empty result without issuing a useless query.
   */
  async findByScope(
    ctx: TenantContext,
    scope: PolicyScope,
    scopeIds: readonly string[],
  ): Promise<Policy[]> {
    if (scopeIds.length === 0) return [];
    const rows = await this.selectRows(ctx, {
      where: [
        { column: 'scope', value: scope },
        { column: 'scope_id', op: 'in', value: [...scopeIds] },
      ],
    });
    return rows.map((row) => this.toRecord(row));
  }
}
