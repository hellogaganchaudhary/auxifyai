/**
 * The Device_Manager — lists, revokes, and deactivates the sessions that
 * authenticate as a user (Req 33.10, 33.11, 33.13, 20.5).
 *
 * It is the single place that:
 *   - lists a user's ACTIVE devices and sessions with their last-active time so
 *     the user can review where they are signed in (Req 33.10);
 *   - revokes a single device's session tokens, leaving the user's other
 *     devices signed in (Req 33.11);
 *   - revokes one session on sign-out so its tokens are rejected thereafter
 *     (Req 33.13, the same effect as {@link import('../auth/index.js').AuthService.signOut});
 *   - on administrative user deactivation, invalidates EVERY active session AND
 *     records the account as deactivated so the user can no longer authenticate
 *     (Req 20.5).
 *
 * It deliberately COMPOSES the Auth_Service's session model: the SAME
 * {@link SessionStore} the {@link import('../auth/index.js').AuthService} writes
 * is injected here, so a revocation performed by the Device_Manager is
 * immediately visible to `AuthService.validate` / `AuthService.refresh`. A
 * revoked session is marked with `revokedAt` and RETAINS its one-way token
 * hashes (which are digests, not secrets) — exactly as `AuthService.signOut`
 * does — so a subsequent `validate` / `refresh` resolves the record by its hash
 * and rejects it with the precise {@link import('../auth/index.js').InvalidSessionError}
 * reason `'revoked'` rather than the indistinct `'unknown'` it would return if
 * the record could no longer be found.
 *
 * All dependencies are injected so the manager is pure orchestration and fully
 * unit-testable with the in-memory fakes in `./fakes.js`: the shared
 * {@link SessionStore}, the shared {@link AuditRecorder}, a
 * {@link DeactivationStore}, and a {@link DeviceClock}.
 *
 * SECURITY: a listing never crosses the service boundary carrying a token hash —
 * every {@link DeviceSession} is the masked projection produced by
 * {@link toDeviceSession}. Revocation and deactivation are recorded immutably in
 * the Audit_Service (Req 37.1).
 */

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import type { SessionRecord, SessionStore } from '../auth/index.js';
import {
  systemDeviceClock,
  type DeactivationStore,
  type DeviceClock,
  type DeviceSession,
} from './types.js';

/** Construction dependencies for the {@link DeviceManager} (all injectable). */
export interface DeviceManagerOptions {
  /**
   * The shared session repository (Req 33.8-33.13). It MUST be the same
   * {@link SessionStore} instance the {@link import('../auth/index.js').AuthService}
   * composes, so a revocation here is visible to `validate` / `refresh`.
   */
  sessions: SessionStore;
  /** The append-only audit sink; every revocation/deactivation is recorded through it (Req 37.1). */
  audit: AuditRecorder;
  /**
   * The seam that records a user as deactivated so the sign-in path can refuse
   * them (the "prevent the user from authenticating" half of Req 20.5).
   */
  deactivation: DeactivationStore;
  /** The clock used to decide whether a session is still active; defaults to {@link systemDeviceClock}. */
  clock?: DeviceClock;
}

/**
 * Project a stored {@link SessionRecord} into its masked, secret-free
 * {@link DeviceSession} listing item (Req 33.10).
 *
 * Every token hash is dropped here, so a token hash never crosses the
 * Device_Manager boundary. When {@link currentSessionId} matches the record, the
 * item is flagged as the caller's current session so a UI can label it.
 */
export function toDeviceSession(record: SessionRecord, currentSessionId?: string): DeviceSession {
  const item: DeviceSession = {
    sessionId: record.id,
    userId: record.userId,
    organizationId: record.organizationId,
    method: record.method,
    createdAt: record.createdAt,
    lastActiveAt: record.lastActiveAt,
    expiresAt: record.expiresAt,
  };
  if (record.deviceId !== undefined) item.deviceId = record.deviceId;
  if (record.deviceName !== undefined) item.deviceName = record.deviceName;
  if (currentSessionId !== undefined) item.current = record.id === currentSessionId;
  return item;
}

/**
 * The Device_Manager. Construct once with its injected dependencies (the SAME
 * {@link SessionStore} the Auth_Service uses, chief among them), then drive
 * device listing, device/session revocation, and user deactivation.
 */
export class DeviceManager {
  private readonly sessions: SessionStore;
  private readonly audit: AuditRecorder;
  private readonly deactivation: DeactivationStore;
  private readonly clock: DeviceClock;

  constructor(options: DeviceManagerOptions) {
    this.sessions = options.sessions;
    this.audit = options.audit;
    this.deactivation = options.deactivation;
    this.clock = options.clock ?? systemDeviceClock;
  }

  /**
   * List a user's ACTIVE devices and sessions with their last-active time
   * (Req 33.10).
   *
   * Reads every session the user owns from the shared {@link SessionStore},
   * keeps only those that are still active at "now" — not revoked and not past
   * their expiry — and projects each to a masked {@link DeviceSession} (never a
   * token hash). The result is ordered most-recently-active first so the user's
   * current device surfaces at the top. An optional {@link currentSessionId}
   * flags the caller's own session in the listing.
   *
   * @param _ctx The acting principal's tenant context (the listing is by user).
   * @param userId The user whose devices to list.
   * @param currentSessionId Optionally flag this session as the caller's current one.
   * @returns The user's active sessions as masked listing items, most-recent-active first.
   */
  async listDevices(
    _ctx: TenantContext,
    userId: string,
    currentSessionId?: string,
  ): Promise<DeviceSession[]> {
    const now = this.clock.now();
    const all = await this.sessions.listByUser(userId);
    return all
      .filter((record) => this.isActive(record, now))
      .map((record) => toDeviceSession(record, currentSessionId))
      .sort(compareMostRecentlyActiveFirst);
  }

  /**
   * Revoke every active session bound to a single device for a user (Req 33.11).
   *
   * Resolves the user's active sessions, selects exactly those whose `deviceId`
   * matches, and revokes each (sets `revokedAt`, retaining the token hashes so
   * `AuthService.validate` / `refresh` reject the tokens with `'revoked'`). Only
   * the named device's sessions are touched — the user's other devices stay
   * signed in. Records a single `device.revoked` audit event carrying the device
   * id and the number revoked. Revoking a device with no active sessions revokes
   * zero and is a no-op (idempotent).
   *
   * @param ctx The acting user's or administrator's tenant context.
   * @param userId The user the device belongs to.
   * @param deviceId The device whose sessions to revoke.
   * @returns The number of sessions revoked.
   */
  async revokeDevice(ctx: TenantContext, userId: string, deviceId: string): Promise<number> {
    const now = this.clock.now();
    const all = await this.sessions.listByUser(userId);
    const targets = all.filter(
      (record) => record.deviceId === deviceId && this.isActive(record, now),
    );

    for (const record of targets) {
      await this.sessions.update(this.revokedFrom(record, now));
    }

    await this.audit.record(ctx, {
      action: 'device.revoked',
      resourceType: 'device',
      resourceId: deviceId,
      metadata: { userId, deviceId, revokedCount: targets.length },
    });

    return targets.length;
  }

  /**
   * Revoke a single session by id — the sign-out path (Req 33.13).
   *
   * Marks the session revoked (retaining its token hashes so a later
   * `AuthService.validate` / `refresh` rejects with `'revoked'`) and records a
   * `device.session_invalidated` audit event. Idempotent: revoking an unknown or
   * already-revoked session does nothing and records nothing, and never reveals
   * whether the session exists.
   *
   * @param ctx The acting principal's tenant context.
   * @param sessionId The session to revoke.
   */
  async revokeSession(ctx: TenantContext, sessionId: string): Promise<void> {
    const record = await this.sessions.findById(sessionId);
    if (record === null || record.revokedAt !== undefined) {
      return;
    }
    const now = this.clock.now();
    await this.sessions.update(this.revokedFrom(record, now));
    await this.audit.record(ctx, {
      action: 'device.session_invalidated',
      resourceType: 'session',
      resourceId: record.id,
      actorId: record.userId,
      metadata: { userId: record.userId, method: record.method },
    });
  }

  /**
   * Deactivate a user: invalidate ALL of the user's active sessions AND record
   * the account as deactivated so it can no longer authenticate (Req 20.5).
   *
   * Revokes every active session the user owns (each retains its token hashes so
   * outstanding tokens are rejected with `'revoked'`), then marks the user
   * deactivated through the injected {@link DeactivationStore} — the fact the
   * Auth_Service / Tenancy_Service sign-in path consults to refuse a future
   * authentication. Records a single `user.deactivated` audit event carrying the
   * number of sessions revoked.
   *
   * @param ctx The acting administrator's tenant context.
   * @param userId The user to deactivate.
   * @returns The number of active sessions that were revoked.
   */
  async deactivateUser(ctx: TenantContext, userId: string): Promise<number> {
    const now = this.clock.now();
    const all = await this.sessions.listByUser(userId);
    const active = all.filter((record) => this.isActive(record, now));

    for (const record of active) {
      await this.sessions.update(this.revokedFrom(record, now));
    }

    // Block future authentication: record the account as deactivated so the
    // sign-in path refuses it (the second half of Req 20.5).
    await this.deactivation.deactivate(ctx, userId);

    await this.audit.record(ctx, {
      action: 'user.deactivated',
      resourceType: 'user',
      resourceId: userId,
      metadata: { userId, revokedCount: active.length },
    });

    return active.length;
  }

  // --- internals ---------------------------------------------------------

  /**
   * Whether a session is active at `now`: not revoked (Req 33.13) and not past
   * its expiry (Req 33.8). This is the same liveness predicate
   * `AuthService.validate` enforces on the session as a whole.
   */
  private isActive(record: SessionRecord, now: Date): boolean {
    if (record.revokedAt !== undefined) {
      return false;
    }
    return new Date(record.expiresAt).getTime() > now.getTime();
  }

  /**
   * Produce the revoked form of a session: stamp `revokedAt` and advance
   * `lastActiveAt` to "now", RETAINING the one-way token hashes (digests, not
   * secrets) so the record stays resolvable by `AuthService.validate` /
   * `refresh` and is rejected there with the precise `'revoked'` reason —
   * mirroring `AuthService.signOut`.
   */
  private revokedFrom(record: SessionRecord, now: Date): SessionRecord {
    return {
      ...record,
      revokedAt: now.toISOString(),
      lastActiveAt: now.toISOString(),
    };
  }
}

/**
 * Order two listing items most-recently-active first, then by session id, so a
 * listing presents a stable, deterministic order with the freshest device at
 * the head.
 */
function compareMostRecentlyActiveFirst(a: DeviceSession, b: DeviceSession): number {
  if (a.lastActiveAt !== b.lastActiveAt) {
    return a.lastActiveAt < b.lastActiveAt ? 1 : -1;
  }
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}
