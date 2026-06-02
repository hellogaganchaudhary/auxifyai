/**
 * Append-only, tenant-scoped repository over the `audit_logs` table
 * (migrations 0010 + 0013) — the storage half of the Audit_Service (Req 37).
 *
 * Audit logs are an *immutable, append-only* trail (Req 37.3). This repository
 * therefore exposes exactly two operations and nothing else:
 *
 *   - {@link AuditLogRepository.append} — insert a single record. It reuses the
 *     hardened {@link TenantScopedRepository.insertRow} primitive, so the
 *     caller's Organization is forced onto the row from the {@link TenantContext}
 *     and a missing/forged context fails closed before any SQL is issued.
 *   - {@link AuditLogRepository.query} — a sound-and-complete filtered read
 *     (Req 37.5 / Property 8). Every read is scoped to a single Organization;
 *     the audit *actor* is data carried on the row, not the reader's identity,
 *     so the read path takes an explicit `organizationId` tenant scope rather
 *     than a full write context.
 *
 * The base class deliberately keeps `updateById`/`deleteById` `protected`, so
 * this repository's public surface offers no mutation at all — immutability is
 * thus enforced three ways: by the absence of any update/delete API here, by
 * the database trigger that rejects UPDATE/DELETE on `audit_logs`
 * (migration 0010), and by the type system.
 */

import type { TenantContext } from '@auxify/types';

import {
  MissingTenantContextError,
  ParamCollector,
  TenantScopedRepository,
  type ColumnValue,
  type SqlClient,
  type SqlRow,
} from '../repositories/index.js';

/**
 * A persisted audit record (mirrors the `audit_logs` columns). `organizationId`
 * is owned by the repository: callers never set it on append — it is derived
 * from the {@link TenantContext}.
 */
export interface AuditRecord {
  /** Stable unique id of the audit entry. */
  id: string;
  /** The Organization the tracked action belongs to (Req 37.1). */
  organizationId: string;
  /** The acting user's id (Req 37.1). */
  actorId: string;
  /** The action performed (a domain verb, e.g. `access.denied`, `project.move`). */
  action: string;
  /** The kind of resource acted upon (Req 37.1). */
  resourceType: string;
  /** The id of the resource acted upon (Req 37.1). */
  resourceId: string;
  /** The originating IP address, or empty string when not captured (Req 37.1). */
  ip: string;
  /** The originating user agent, or empty string when not captured (Req 37.1). */
  userAgent: string;
  /** When the action occurred, as an ISO-8601 timestamp (Req 37.1). */
  timestamp: string;
  /** Optional structured context attached by the caller (e.g. denial reason). */
  metadata: Record<string, unknown>;
}

/** The fields supplied to append a record (tenant + id/timestamp are explicit). */
export interface AppendAuditInput {
  /** Stable unique id for the entry. */
  id: string;
  /** The acting user's id (Req 37.1). */
  actorId: string;
  /** The action performed. */
  action: string;
  /** The kind of resource acted upon. */
  resourceType: string;
  /** The id of the resource acted upon. */
  resourceId: string;
  /** The originating IP address. Defaults to an empty string. */
  ip?: string;
  /** The originating user agent. Defaults to an empty string. */
  userAgent?: string;
  /** When the action occurred (ISO-8601). */
  timestamp: string;
  /** Optional structured context. Defaults to an empty object. */
  metadata?: Record<string, unknown>;
}

/**
 * A filtered query over the audit log (Req 37.5). Every dimension is optional
 * except the mandatory `organizationId` tenant scope; an omitted dimension does
 * not constrain the result. `from`/`to` bound the `timestamp` inclusively.
 */
export interface AuditQuery {
  /** The Organization whose audit trail is queried (mandatory tenant scope). */
  organizationId: string;
  /** Restrict to a single actor. */
  actorId?: string;
  /** Restrict to a single action. */
  action?: string;
  /** Restrict to a single resource type. */
  resourceType?: string;
  /** Restrict to a single resource id. */
  resourceId?: string;
  /** Lower bound on `timestamp`, inclusive (ISO-8601). */
  from?: string;
  /** Upper bound on `timestamp`, inclusive (ISO-8601). */
  to?: string;
  /** Maximum rows to return. */
  limit?: number;
  /** Rows to skip. */
  offset?: number;
}

/** The audit table's `timestamp` column, quoted because it is a SQL keyword. */
const TIMESTAMP_COLUMN = '"timestamp"';

/** Parse a JSONB column that a driver may hand back as an object or a string. */
function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    if (value.length === 0) return {};
    return JSON.parse(value) as Record<string, unknown>;
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  return {};
}

/** Map a DB row to the domain {@link AuditRecord}. */
function toAuditRecord(row: SqlRow): AuditRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    actorId: String(row.actor_id),
    action: String(row.action),
    resourceType: String(row.resource_type),
    resourceId: String(row.resource_id),
    ip: row.ip === null || row.ip === undefined ? '' : String(row.ip),
    userAgent: row.user_agent === null || row.user_agent === undefined ? '' : String(row.user_agent),
    timestamp:
      row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
    metadata: parseJsonObject(row.metadata),
  };
}

/**
 * Append-only repository over `audit_logs`, always scoped to a single
 * Organization. Construct it once with a {@link SqlClient} and share it across
 * services that need to record or query audit events.
 */
export class AuditLogRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'audit_logs') {
    super(sql, { table, scope: { kind: 'direct', column: 'organization_id' } });
  }

  /**
   * Append an immutable audit record within the caller's Organization
   * (Req 37.1, 37.3). The Organization is forced from `ctx`; a missing or
   * forged context fails closed before any SQL is issued.
   */
  async append(ctx: TenantContext, input: AppendAuditInput): Promise<AuditRecord> {
    const columns: ColumnValue[] = [
      { column: 'id', value: input.id },
      { column: 'actor_id', value: input.actorId },
      { column: 'action', value: input.action },
      { column: 'resource_type', value: input.resourceType },
      { column: 'resource_id', value: input.resourceId },
      { column: 'ip', value: input.ip ?? '' },
      { column: 'user_agent', value: input.userAgent ?? '' },
      { column: TIMESTAMP_COLUMN, value: input.timestamp },
      { column: 'metadata', value: JSON.stringify(input.metadata ?? {}) },
    ];
    const row = await this.insertRow(ctx, columns);
    return toAuditRecord(row);
  }

  /**
   * Return exactly the stored entries that satisfy the filter, most recent
   * first (Req 37.5 / Property 8). The mandatory Organization predicate leads
   * the conjunction; every other dimension narrows the result only when set, so
   * an empty filter (beyond the Organization) returns the whole tenant trail.
   *
   * @throws MissingTenantContextError if `filter.organizationId` is empty.
   */
  async query(filter: AuditQuery): Promise<AuditRecord[]> {
    const organizationId = filter.organizationId;
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new MissingTenantContextError(
        'A non-empty organizationId is required to query the audit log',
      );
    }

    const params = new ParamCollector();
    // Tenant predicate FIRST so a read can never escape its Organization.
    const clauses: string[] = [`organization_id = ${params.add(organizationId)}`];
    if (filter.actorId !== undefined) {
      clauses.push(`actor_id = ${params.add(filter.actorId)}`);
    }
    if (filter.action !== undefined) {
      clauses.push(`action = ${params.add(filter.action)}`);
    }
    if (filter.resourceType !== undefined) {
      clauses.push(`resource_type = ${params.add(filter.resourceType)}`);
    }
    if (filter.resourceId !== undefined) {
      clauses.push(`resource_id = ${params.add(filter.resourceId)}`);
    }
    if (filter.from !== undefined) {
      clauses.push(`${TIMESTAMP_COLUMN} >= ${params.add(filter.from)}`);
    }
    if (filter.to !== undefined) {
      clauses.push(`${TIMESTAMP_COLUMN} <= ${params.add(filter.to)}`);
    }

    let text =
      `SELECT * FROM ${this.table} WHERE ${clauses.join(' AND ')} ` +
      `ORDER BY ${TIMESTAMP_COLUMN} DESC, id DESC`;
    if (filter.limit !== undefined) {
      text += ` LIMIT ${params.add(filter.limit)}`;
    }
    if (filter.offset !== undefined) {
      text += ` OFFSET ${params.add(filter.offset)}`;
    }

    const result = await this.sql.query(text, params.params);
    return result.rows.map(toAuditRecord);
  }
}
