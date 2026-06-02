/**
 * Test fakes and builders for the Device_Manager (Req 33.10, 33.11, 33.13,
 * 20.5).
 *
 * The Device_Manager composes the SAME session model as the Auth_Service, so
 * these fakes deliberately REUSE the Auth_Service's in-memory
 * {@link InMemorySessionStore} (re-exported from `../auth/fakes.js`): a test can
 * wire one store into both a real {@link import('../auth/index.js').AuthService}
 * and a {@link import('./device-manager.js').DeviceManager} and prove that a
 * revocation by the manager is visible to the service's `validate` / `refresh`.
 * The remaining fakes let unit tests drive the manager deterministically and
 * inspect what was revoked, deactivated, and audited — without a database, a
 * real clock, or a network:
 *
 *   - {@link InMemorySessionStore} (re-exported from the auth fakes) — the
 *     shared session repository both the Auth_Service and the Device_Manager
 *     write;
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert which device effects were audited (Req 37.1);
 *   - {@link InMemoryDeactivationStore} models the {@link DeactivationStore}
 *     seam — `deactivate` marks a user, `isDeactivated` reports it — confined to
 *     its Organization (Req 1.4, 20.5);
 *   - {@link MutableDeviceClock} is a hand-advanceable {@link DeviceClock} so
 *     session expiry is fully testable: fix "now", then advance it across a
 *     session's expiry;
 *   - {@link makeSessionRecord} / {@link makeDeviceTenant} are small builders
 *     for a fully-formed {@link SessionRecord} (carrying only token hashes) and
 *     a {@link TenantContext}, with sensible defaults.
 *
 * These are imported directly from `./fakes.js` by the tests (never from the
 * package barrel), matching the established convention.
 *
 * SECURITY: even the builders never persist a raw token — {@link makeSessionRecord}
 * produces only the one-way `accessTokenHash` / `refreshTokenHash` a real
 * {@link SessionRecord} carries.
 */

import type { Role, TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type { AuthMethod, SessionRecord } from '../auth/index.js';
import type { DeactivationStore, DeviceClock } from './types.js';

// The Device_Manager composes the Auth_Service's session repository; reuse its
// in-memory store so one instance can back both services in a cross-visibility
// test rather than maintaining a parallel implementation here.
export { InMemorySessionStore } from '../auth/fakes.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  /** The tenant context the event was scoped to. */
  ctx: TenantContext;
  /** The recorded event. */
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which device-management effects were audited (Req 37.1).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({
      ctx: { ...ctx },
      event: { ...event, metadata: { ...(event.metadata ?? {}) } },
    });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `device.revoked`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/**
 * An in-memory {@link DeactivationStore} modelling the "prevent the user from
 * authenticating" seam (Req 20.5).
 *
 * A user is confined to its Organization: {@link isDeactivated} only reports
 * `true` within the Organization the user was {@link deactivate}d in, so the
 * fact never leaks across a tenant boundary (Req 1.4).
 */
export class InMemoryDeactivationStore implements DeactivationStore {
  private readonly deactivated = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async deactivate(ctx: TenantContext, userId: string): Promise<void> {
    this.deactivated.add(this.key(ctx.organizationId, userId));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async isDeactivated(ctx: TenantContext, userId: string): Promise<boolean> {
    return this.deactivated.has(this.key(ctx.organizationId, userId));
  }

  /** The number of deactivated users across every Organization (test inspection). */
  get count(): number {
    return this.deactivated.size;
  }

  private key(organizationId: string, userId: string): string {
    return `${organizationId}\u0000${userId}`;
  }
}

/**
 * A hand-advanceable {@link DeviceClock}, so session expiry is fully testable:
 * fix "now" at construction, then {@link advance} it across a session's expiry
 * (or {@link setIso} an absolute instant). Returns a {@link Date} to match the
 * Auth_Service's clock, with which it shares a session model.
 */
export class MutableDeviceClock implements DeviceClock {
  private current: number;

  constructor(startIso = '2026-01-01T00:00:00.000Z') {
    this.current = Date.parse(startIso);
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.current += ms;
  }

  /** Advance the clock by `seconds` seconds. */
  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }

  /** Set the clock to an absolute ISO-8601 instant. */
  setIso(iso: string): void {
    this.current = Date.parse(iso);
  }
}

/** Build a {@link TenantContext} with sensible defaults; override field-by-field. */
export function makeDeviceTenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    ...overrides,
  };
}

/** Overridable fields for {@link makeSessionRecord}. */
export interface MakeSessionRecordOptions {
  /** The session id (default `sess-1`). */
  id?: string;
  /** The owning user (default `user-1`). */
  userId?: string;
  /** The owning Organization (default `org-1`). */
  organizationId?: string;
  /** The roles at sign-in (default `['standard_user']`). */
  roles?: Role[];
  /** The authentication method (default `password`). */
  method?: AuthMethod;
  /** Whether MFA was satisfied (default `false`). */
  mfaSatisfied?: boolean;
  /** The bound device id, when known. */
  deviceId?: string;
  /** A human-friendly device label, when known. */
  deviceName?: string;
  /** The creation instant (ISO-8601, default 2026-01-01T00:00:00Z). */
  createdAt?: string;
  /** The expiry instant (ISO-8601, default 30 days after `createdAt`). */
  expiresAt?: string;
  /** The last-active instant (ISO-8601, default `createdAt`). */
  lastActiveAt?: string;
  /** The revocation instant (ISO-8601), when already revoked. */
  revokedAt?: string;
  /** The stored access-token hash (default `hash:<id>:access`). */
  accessTokenHash?: string;
  /** The stored refresh-token hash (default `hash:<id>:refresh`). */
  refreshTokenHash?: string;
}

/**
 * Build a fully-formed {@link SessionRecord} with sensible defaults; override
 * field-by-field.
 *
 * SECURITY: the record carries only one-way token HASHES (never a raw token),
 * exactly as a real session does.
 */
export function makeSessionRecord(options: MakeSessionRecordOptions = {}): SessionRecord {
  const id = options.id ?? 'sess-1';
  const createdAt = options.createdAt ?? '2026-01-01T00:00:00.000Z';
  const expiresAt =
    options.expiresAt ?? new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
  const record: SessionRecord = {
    id,
    userId: options.userId ?? 'user-1',
    organizationId: options.organizationId ?? 'org-1',
    roles: options.roles ?? ['standard_user'],
    method: options.method ?? 'password',
    mfaSatisfied: options.mfaSatisfied ?? false,
    createdAt,
    expiresAt,
    lastActiveAt: options.lastActiveAt ?? createdAt,
    accessTokenHash: options.accessTokenHash ?? `hash:${id}:access`,
    refreshTokenHash: options.refreshTokenHash ?? `hash:${id}:refresh`,
  };
  if (options.deviceId !== undefined) record.deviceId = options.deviceId;
  if (options.deviceName !== undefined) record.deviceName = options.deviceName;
  if (options.revokedAt !== undefined) record.revokedAt = options.revokedAt;
  return record;
}
