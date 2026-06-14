/**
 * Audit_Service — the immutable, append-only audit trail across every tracked
 * domain (Req 37).
 *
 * Responsibilities:
 *   - **Record** (Req 37.1, 37.2): capture actor, action, resource type + id,
 *     Organization, timestamp, IP, and user agent for any tracked action across
 *     authentication, administration, agents, workflows, budgets, tools,
 *     knowledge operations, messaging, document management, and access-control
 *     decisions. The Organization is taken from the {@link TenantContext} so a
 *     caller can never mis-scope an event; the actor defaults to `ctx.userId`
 *     and the id/timestamp to a generated UUID and "now" when omitted.
 *   - **Immutable** (Req 37.3): the service exposes only {@link record} and
 *     {@link query} — never update or delete. Immutability is enforced in depth
 *     by the database trigger on `audit_logs` (migration 0010) and by the
 *     append-only repository surface.
 *   - **Query** (Req 37.5): a sound-and-complete filtered read by actor, action,
 *     resource type/id, Organization, and time range (delegated to the
 *     repository, validated by Property 8).
 *   - **Retention** (Req 37.4): the 7-year window is represented by
 *     {@link AUDIT_RETENTION_POLICY}; {@link expiredBefore} identifies records
 *     past retention for the Compliance_Manager to purge — the Audit_Service
 *     itself never deletes.
 *
 * It implements the narrow {@link AuditRecorder} port (`./recorder`) so other
 * services — Tenancy_Service, Access_Control, Auth_Service, and the rest —
 * depend on the seam and a tenant-agnostic {@link AuditEvent}, not on the
 * concrete service or its SQL client.
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import type { SqlClient } from '../repositories/index.js';
import { assertTenantContext } from '../repositories/index.js';
import {
  AuditLogRepository,
  type AppendAuditInput,
  type AuditQuery,
  type AuditRecord,
} from './audit-repository.js';
import type { AuditEvent, AuditRecorder } from './recorder.js';
import {
  AUDIT_RETENTION_POLICY,
  auditRetentionCutoff,
  type AuditRetentionPolicy,
} from './retention.js';

/** Construction options for {@link AuditService} (all optional, for testing). */
export interface AuditServiceOptions {
  /** Override the audit table name (defaults to `audit_logs`). */
  table?: string;
  /** Inject the id generator (defaults to {@link randomUUID}). */
  idFactory?: () => string;
  /** Inject the clock (defaults to `() => new Date()`). */
  now?: () => Date;
}

/**
 * The Audit_Service. Append + query only; never mutates stored entries.
 */
export class AuditService implements AuditRecorder {
  private readonly repository: AuditLogRepository;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  /** The retention policy this service represents (Req 37.4). */
  readonly retention: AuditRetentionPolicy = AUDIT_RETENTION_POLICY;

  constructor(sql: SqlClient, options: AuditServiceOptions = {}) {
    this.repository = new AuditLogRepository(sql, options.table);
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Record one immutable audit event within the caller's Organization
   * (Req 37.1, 37.2). The actor defaults to `ctx.userId`, the id to a generated
   * UUID, and the timestamp to "now" — so request-path callers supply only the
   * action and resource. Implements the {@link AuditRecorder} port.
   */
  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    await this.recordReturning(ctx, event);
  }

  /**
   * Like {@link record}, but returns the persisted {@link AuditRecord}. Useful
   * for callers (and tests) that need the assigned id/timestamp; the
   * {@link AuditRecorder} port deliberately exposes only the `void` form.
   *
   * The append-only repository derives `organization_id` from `ctx` and fails
   * closed on a missing/empty Organization, so a forged event can never be
   * written without a tenant scope (Req 1.2, 37.1).
   */
  async recordReturning(ctx: TenantContext, event: AuditEvent): Promise<AuditRecord> {
    // Fail closed before reading anything off the context: a missing/forged
    // context is rejected with MissingTenantContextError, never a raw TypeError.
    assertTenantContext(ctx);
    const input: AppendAuditInput = {
      id: this.idFactory(),
      actorId: event.actorId ?? ctx.userId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      ip: event.ip ?? '',
      userAgent: event.userAgent ?? '',
      timestamp: event.timestamp ?? this.now().toISOString(),
      metadata: event.metadata ?? {},
    };
    return this.repository.append(ctx, input);
  }

  /**
   * Return exactly the stored entries matching the filter (Req 37.5 /
   * Property 8), most recent first. The filter's `organizationId` is the
   * mandatory tenant scope.
   */
  async query(filter: AuditQuery): Promise<AuditRecord[]> {
    return this.repository.query(filter);
  }

  /**
   * Identify records in an Organization that have aged out of the 7-year
   * retention window as of `now` (Req 37.4). This is a **read** that surfaces
   * purge candidates for the Compliance_Manager (Req 38); the Audit_Service
   * never deletes them itself, preserving immutability (Req 37.3).
   *
   * @param organizationId The Organization whose expired records to list.
   * @param now The reference instant. Defaults to the service clock.
   */
  async expiredBefore(organizationId: string, now: Date = this.now()): Promise<AuditRecord[]> {
    const cutoffMs = new Date(auditRetentionCutoff(now)).getTime();
    const all = await this.repository.query({ organizationId });
    return all.filter((record) => new Date(record.timestamp).getTime() < cutoffMs);
  }
}
