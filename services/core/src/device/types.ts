/**
 * Device_Manager domain types and injectable ports (Req 33.10, 33.11, 33.13,
 * 20.5).
 *
 * The Device_Manager lets a user (or an administrator) see and control the
 * sessions that authenticate as them: it lists the user's active devices and
 * sessions with their last-active time (Req 33.10), revokes a single device's
 * session tokens (Req 33.11), revokes one session on sign-out (Req 33.13), and —
 * on administrative user deactivation — invalidates every session AND records
 * the account as deactivated so further authentication is blocked (Req 20.5).
 *
 * It deliberately COMPOSES the Auth_Service's existing session model rather than
 * inventing a parallel one: the same {@link SessionStore} the
 * {@link import('../auth/index.js').AuthService} writes is injected here, so a
 * revocation performed by the Device_Manager is immediately visible to
 * `AuthService.validate` / `AuthService.refresh` (which resolve a presented
 * token to its {@link SessionRecord} by hash and reject a record whose
 * `revokedAt` is set). The auth {@link SessionStore} and {@link SessionRecord}
 * are imported as TYPES from `../auth/index.js` and never redefined here.
 *
 * Everything the manager cannot do purely is a narrow injectable port so it
 * stays pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`:
 *
 *   - the auth {@link SessionStore} — the shared session repository (create,
 *     lookup, update, per-user listing) the Auth_Service also composes;
 *   - the shared {@link import('../audit/index.js').AuditRecorder} — every
 *     device revocation, session invalidation, and deactivation is recorded
 *     immutably (Req 37.1);
 *   - a {@link DeactivationStore} — the narrow seam that records (and reports) a
 *     user as deactivated so the Auth_Service / Tenancy_Service can refuse a
 *     future sign-in (the "prevent the user from authenticating" half of
 *     Req 20.5);
 *   - a {@link DeviceClock} — so "active" (unexpired, unrevoked) is evaluated
 *     deterministically in tests.
 *
 * SECURITY: a {@link DeviceSession} listing item is the masked, secret-free
 * projection of a {@link SessionRecord} — it carries the device metadata and
 * last-active time a user needs to recognise a session, but NEVER a token hash,
 * so a device listing can never be used to reconstruct or compare a token.
 */

import type { TenantContext } from '@auxify/types';

import type { AuthMethod, SessionRecord } from '../auth/index.js';

export type { AuditRecorder, AuditEvent } from '../audit/index.js';

/**
 * The masked, secret-free listing item the Device_Manager returns for an active
 * session (Req 33.10).
 *
 * It is the device-management projection of an Auth_Service
 * {@link SessionRecord}: it carries the session id, the bound device's id/label
 * when known, the owning user and Organization, the authentication method, and
 * the creation / last-active / expiry timestamps — but deliberately OMITS every
 * token hash, so a listing can never leak or be used to reconstruct a token. The
 * optional {@link current} flag marks the caller's own session in the list so a
 * UI can label "this device".
 */
export interface DeviceSession {
  /** The session's stable id (the handle a revoke targets, Req 33.13). */
  sessionId: string;
  /** The device this session is bound to, when known (Req 33.11). */
  deviceId?: string;
  /** A human-friendly device label, when known. */
  deviceName?: string;
  /** The user the session authenticates as. */
  userId: string;
  /** The user's Organization (the session tenant scope). */
  organizationId: string;
  /** The method used to authenticate the session (Req 33.2, 33.3, 33.4). */
  method: AuthMethod;
  /** The ISO-8601 session creation timestamp. */
  createdAt: string;
  /** The ISO-8601 timestamp of the session's most recent validated use (Req 33.10). */
  lastActiveAt: string;
  /** The ISO-8601 session expiry. */
  expiresAt: string;
  /** Whether this is the caller's current session, when that is known. */
  current?: boolean;
}

/**
 * The narrow seam that records — and reports — a user as deactivated (Req 20.5).
 *
 * User deactivation has two halves: revoking the user's active sessions (which
 * the Device_Manager does directly through the shared {@link SessionStore}) and
 * preventing the user from authenticating again. This port models the second
 * half as a single fact the Auth_Service / Tenancy_Service can consult at
 * sign-in: {@link deactivate} marks the user deactivated and {@link isDeactivated}
 * reports it. It is injectable and fake-able so the deactivation decision stays
 * testable without a database. The concrete implementation is wired in the
 * application layer (the Tenancy_Service's persisted user status is one such
 * backing); tests substitute the in-memory
 * {@link import('./fakes.js').InMemoryDeactivationStore}.
 */
export interface DeactivationStore {
  /**
   * Record the user as deactivated within the caller's Organization, so a
   * subsequent authentication attempt is refused (Req 20.5).
   *
   * @param ctx The acting administrator's tenant context (the Organization scope).
   * @param userId The user being deactivated.
   */
  deactivate(ctx: TenantContext, userId: string): Promise<void>;
  /**
   * Report whether the user is currently deactivated, for the sign-in gate to
   * consult (Req 20.5).
   *
   * @param ctx The tenant context the check is scoped to.
   * @param userId The user to check.
   * @returns `true` when the user has been deactivated.
   */
  isDeactivated(ctx: TenantContext, userId: string): Promise<boolean>;
}

/**
 * The injectable clock the Device_Manager reads to decide whether a session is
 * still active (unexpired) (Req 33.10).
 *
 * It returns a {@link Date} to match the Auth_Service's {@link import('../auth/index.js').AuthClock},
 * with which it shares the same session model. Named {@link DeviceClock} (not
 * `Clock`) so it never collides with the Auth_Service's, Model_Router's,
 * Scheduler's, or Backup_Service's identically-purposed clocks in the shared
 * `@auxify/core` barrel.
 */
export interface DeviceClock {
  /** The current instant. */
  now(): Date;
}

/** The default {@link DeviceClock}, backed by the system clock. */
export const systemDeviceClock: DeviceClock = { now: () => new Date() };
