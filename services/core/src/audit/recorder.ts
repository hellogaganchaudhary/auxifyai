/**
 * The shared {@link AuditRecorder} port and {@link AuditEvent} shape (Req 37.1).
 *
 * Several domains must record immutable, append-only audit events without
 * taking a hard dependency on the concrete Audit_Service implementation. This
 * module defines the narrow seam those domains depend on: a single `record`
 * method accepting the caller's {@link TenantContext} (which carries the
 * Organization tenant scope and the default actor) and a tenant-agnostic
 * {@link AuditEvent}.
 *
 * The concrete {@link AuditService} (in `./audit-service`) implements this port
 * by appending to the immutable `audit_logs` table; consumers such as the
 * Tenancy_Service accept an {@link AuditRecorder} by dependency injection, and
 * tests substitute a fake recorder that captures emitted events. Keeping the
 * port here — rather than inside any one domain — lets every audited service
 * and the Audit_Service share a single contract.
 */

import type { TenantContext } from '@auxify/types';

/**
 * A tenant-agnostic audit event to be recorded immutably.
 *
 * Mirrors the immutable `audit_logs` columns (actor, action, resource type/id,
 * timestamp, IP, user agent — Req 37.1) minus the Organization, which is always
 * taken from the {@link TenantContext} so a caller can never mis-scope an event.
 * `actorId` and `timestamp` default (to `ctx.userId` and "now") when omitted;
 * `metadata` carries optional structured, action-specific context (for example
 * the source and destination Team of a project move).
 */
export interface AuditEvent {
  /** The action performed, e.g. `team.create` or `project.move`. */
  action: string;
  /** The kind of resource the action targeted. */
  resourceType: string;
  /** The stable id of the resource the action targeted. */
  resourceId: string;
  /** The acting user's id. Defaults to `ctx.userId` when omitted. */
  actorId?: string;
  /** The originating IP address. Defaults to an empty string. */
  ip?: string;
  /** The originating user agent. Defaults to an empty string. */
  userAgent?: string;
  /** The event timestamp (ISO-8601). Defaults to "now" when omitted. */
  timestamp?: string;
  /** Optional structured, action-specific context. */
  metadata?: Record<string, unknown>;
}

/**
 * The append-only audit sink (Req 37.1-37.3).
 *
 * Implementations persist each event as an immutable record scoped to the
 * Organization carried by `ctx`. Consumers depend on this port — never on the
 * concrete Audit_Service — so the dependency is inverted and substitutable in
 * tests.
 */
export interface AuditRecorder {
  /**
   * Record a single audit event within the caller's Organization.
   *
   * @param ctx The tenant context supplying the Organization scope and default actor.
   * @param event The tenant-agnostic event to append.
   */
  record(ctx: TenantContext, event: AuditEvent): Promise<void>;
}
