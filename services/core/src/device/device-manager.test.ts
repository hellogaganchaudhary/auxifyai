/**
 * Unit tests for the Device_Manager (Req 33.10, 33.11, 33.13, 20.5).
 *
 * These drive the REAL {@link DeviceManager} over the in-memory fakes (imported
 * directly from `./fakes.js`, never the barrel) with a hand-advanced
 * {@link MutableDeviceClock} as the only source of time, covering:
 *
 *   - `listDevices` returns only ACTIVE sessions (filtering out revoked/expired)
 *     projected to the masked, token-free {@link DeviceSession} shape with their
 *     last-active time (Req 33.10);
 *   - `revokeDevice` revokes exactly the named device's sessions and leaves the
 *     user's other devices' sessions active (Req 33.11);
 *   - a session revoked through the Device_Manager is rejected by a REAL
 *     {@link AuthService} composed over the SAME session store, proving the two
 *     services share one session model (Req 33.11, 33.13);
 *   - `revokeSession` is idempotent on an unknown/already-revoked session
 *     (Req 33.13);
 *   - `deactivateUser` revokes ALL of the user's sessions AND records the user
 *     as deactivated so the sign-in path can refuse them (Req 20.5);
 *   - every revocation/deactivation is recorded in the Audit_Service (Req 37.1).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { AuthService, InvalidSessionError } from '../auth/index.js';
import {
  FakeAuthProvider,
  FakeTokenHasher,
  InMemoryIdentityLinkStore,
  InMemoryMfaEnrollmentStore,
  MutableAuthClock,
  SequentialTokenGenerator,
  makeIdentity,
  sequentialAuthIdGenerator,
} from '../auth/fakes.js';
import { DeviceManager, toDeviceSession } from './device-manager.js';
import {
  CapturingAuditRecorder,
  InMemoryDeactivationStore,
  InMemorySessionStore,
  MutableDeviceClock,
  makeDeviceTenant,
  makeSessionRecord,
} from './fakes.js';

const START = '2026-01-01T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness {
  manager: DeviceManager;
  sessions: InMemorySessionStore;
  audit: CapturingAuditRecorder;
  deactivation: InMemoryDeactivationStore;
  clock: MutableDeviceClock;
  ctx: TenantContext;
}

/** Wire the real Device_Manager over in-memory fakes with a fixed clock. */
function makeHarness(): Harness {
  const sessions = new InMemorySessionStore();
  const audit = new CapturingAuditRecorder();
  const deactivation = new InMemoryDeactivationStore();
  const clock = new MutableDeviceClock(START);
  const manager = new DeviceManager({ sessions, audit, deactivation, clock });
  const ctx = makeDeviceTenant({ organizationId: 'org-1', userId: 'user-1' });
  return { manager, sessions, audit, deactivation, clock, ctx };
}

describe('DeviceManager.listDevices (Req 33.10)', () => {
  it('lists the user\u2019s active sessions with last-active time, masked of token hashes', async () => {
    const h = makeHarness();
    h.sessions.seed(
      makeSessionRecord({
        id: 'sess-1',
        userId: 'user-1',
        deviceId: 'dev-A',
        deviceName: 'Chrome on macOS',
        createdAt: START,
        lastActiveAt: new Date(Date.parse(START) + DAY_MS).toISOString(),
      }),
    );

    const devices = await h.manager.listDevices(h.ctx, 'user-1');

    expect(devices).toHaveLength(1);
    const device = devices[0];
    expect(device?.sessionId).toBe('sess-1');
    expect(device?.deviceId).toBe('dev-A');
    expect(device?.deviceName).toBe('Chrome on macOS');
    expect(device?.lastActiveAt).toBe(new Date(Date.parse(START) + DAY_MS).toISOString());
    // SECURITY: the listing item carries no token hash.
    expect(device).not.toHaveProperty('accessTokenHash');
    expect(device).not.toHaveProperty('refreshTokenHash');
    expect(Object.keys(device ?? {})).not.toContain('accessTokenHash');
  });

  it('excludes revoked and expired sessions, returning only the active ones', async () => {
    const h = makeHarness();
    h.sessions.seed(makeSessionRecord({ id: 'active', userId: 'user-1' }));
    h.sessions.seed(
      makeSessionRecord({
        id: 'revoked',
        userId: 'user-1',
        revokedAt: new Date(Date.parse(START) - 1000).toISOString(),
      }),
    );
    h.sessions.seed(
      makeSessionRecord({
        id: 'expired',
        userId: 'user-1',
        expiresAt: new Date(Date.parse(START) - 1000).toISOString(),
      }),
    );

    const devices = await h.manager.listDevices(h.ctx, 'user-1');

    expect(devices.map((d) => d.sessionId)).toEqual(['active']);
  });

  it('orders the listing most-recently-active first and flags the current session', async () => {
    const h = makeHarness();
    h.sessions.seed(
      makeSessionRecord({ id: 'older', userId: 'user-1', lastActiveAt: START }),
    );
    h.sessions.seed(
      makeSessionRecord({
        id: 'newer',
        userId: 'user-1',
        lastActiveAt: new Date(Date.parse(START) + DAY_MS).toISOString(),
      }),
    );

    const devices = await h.manager.listDevices(h.ctx, 'user-1', 'older');

    expect(devices.map((d) => d.sessionId)).toEqual(['newer', 'older']);
    expect(devices.find((d) => d.sessionId === 'older')?.current).toBe(true);
    expect(devices.find((d) => d.sessionId === 'newer')?.current).toBe(false);
  });

  it('does not list another user\u2019s sessions', async () => {
    const h = makeHarness();
    h.sessions.seed(makeSessionRecord({ id: 'mine', userId: 'user-1' }));
    h.sessions.seed(makeSessionRecord({ id: 'theirs', userId: 'user-2' }));

    const devices = await h.manager.listDevices(h.ctx, 'user-1');

    expect(devices.map((d) => d.sessionId)).toEqual(['mine']);
  });
});

describe('DeviceManager.revokeDevice (Req 33.11)', () => {
  it('revokes exactly the named device\u2019s sessions and leaves other devices active', async () => {
    const h = makeHarness();
    h.sessions.seed(makeSessionRecord({ id: 'a1', userId: 'user-1', deviceId: 'dev-A' }));
    h.sessions.seed(makeSessionRecord({ id: 'a2', userId: 'user-1', deviceId: 'dev-A' }));
    h.sessions.seed(makeSessionRecord({ id: 'b1', userId: 'user-1', deviceId: 'dev-B' }));

    const revoked = await h.manager.revokeDevice(h.ctx, 'user-1', 'dev-A');

    expect(revoked).toBe(2);
    // Device A's sessions are now revoked ...
    expect(h.sessions.peek('a1')?.revokedAt).toBe(START);
    expect(h.sessions.peek('a2')?.revokedAt).toBe(START);
    // ... while device B's session stays active.
    expect(h.sessions.peek('b1')?.revokedAt).toBeUndefined();

    const remaining = await h.manager.listDevices(h.ctx, 'user-1');
    expect(remaining.map((d) => d.sessionId)).toEqual(['b1']);
  });

  it('retains the token hashes on revocation so the session stays resolvable', async () => {
    const h = makeHarness();
    h.sessions.seed(makeSessionRecord({ id: 'a1', userId: 'user-1', deviceId: 'dev-A' }));

    await h.manager.revokeDevice(h.ctx, 'user-1', 'dev-A');

    const after = h.sessions.peek('a1');
    expect(after?.revokedAt).toBe(START);
    expect(after?.accessTokenHash).toBe('hash:a1:access');
    expect(after?.refreshTokenHash).toBe('hash:a1:refresh');
  });

  it('records a device.revoked audit event with the revoked count (Req 37.1)', async () => {
    const h = makeHarness();
    h.sessions.seed(makeSessionRecord({ id: 'a1', userId: 'user-1', deviceId: 'dev-A' }));

    await h.manager.revokeDevice(h.ctx, 'user-1', 'dev-A');

    const events = h.audit.withAction('device.revoked');
    expect(events).toHaveLength(1);
    expect(events[0]?.event.resourceId).toBe('dev-A');
    expect(events[0]?.event.metadata?.userId).toBe('user-1');
    expect(events[0]?.event.metadata?.revokedCount).toBe(1);
  });

  it('is a no-op returning 0 when the device has no active sessions', async () => {
    const h = makeHarness();
    h.sessions.seed(makeSessionRecord({ id: 'b1', userId: 'user-1', deviceId: 'dev-B' }));

    const revoked = await h.manager.revokeDevice(h.ctx, 'user-1', 'dev-A');

    expect(revoked).toBe(0);
    expect(h.sessions.peek('b1')?.revokedAt).toBeUndefined();
    // The audit event still records the (zero) outcome of the request.
    expect(h.audit.withAction('device.revoked')[0]?.event.metadata?.revokedCount).toBe(0);
  });
});

describe('DeviceManager.revokeSession (Req 33.13)', () => {
  it('revokes a single session and audits the sign-out', async () => {
    const h = makeHarness();
    h.sessions.seed(makeSessionRecord({ id: 'sess-1', userId: 'user-1' }));

    await h.manager.revokeSession(h.ctx, 'sess-1');

    expect(h.sessions.peek('sess-1')?.revokedAt).toBe(START);
    const events = h.audit.withAction('device.session_invalidated');
    expect(events).toHaveLength(1);
    expect(events[0]?.event.resourceId).toBe('sess-1');
  });

  it('is idempotent on an unknown session (no throw, no audit)', async () => {
    const h = makeHarness();

    await expect(h.manager.revokeSession(h.ctx, 'does-not-exist')).resolves.toBeUndefined();
    expect(h.audit.count).toBe(0);
  });

  it('is idempotent on an already-revoked session (no second audit)', async () => {
    const h = makeHarness();
    h.sessions.seed(
      makeSessionRecord({
        id: 'sess-1',
        userId: 'user-1',
        revokedAt: new Date(Date.parse(START) - 1000).toISOString(),
      }),
    );

    await h.manager.revokeSession(h.ctx, 'sess-1');

    // The original revocation time is untouched and nothing was audited.
    expect(h.sessions.peek('sess-1')?.revokedAt).toBe(
      new Date(Date.parse(START) - 1000).toISOString(),
    );
    expect(h.audit.count).toBe(0);
  });
});

describe('DeviceManager.deactivateUser (Req 20.5)', () => {
  it('revokes all of the user\u2019s active sessions and blocks future authentication', async () => {
    const h = makeHarness();
    h.sessions.seed(makeSessionRecord({ id: 's1', userId: 'user-1', deviceId: 'dev-A' }));
    h.sessions.seed(makeSessionRecord({ id: 's2', userId: 'user-1', deviceId: 'dev-B' }));
    h.sessions.seed(makeSessionRecord({ id: 'other', userId: 'user-2' }));

    const revoked = await h.manager.deactivateUser(h.ctx, 'user-1');

    expect(revoked).toBe(2);
    expect(h.sessions.peek('s1')?.revokedAt).toBe(START);
    expect(h.sessions.peek('s2')?.revokedAt).toBe(START);
    // Another user's session is untouched.
    expect(h.sessions.peek('other')?.revokedAt).toBeUndefined();
    // The account is recorded as deactivated so the sign-in path can refuse it.
    expect(await h.deactivation.isDeactivated(h.ctx, 'user-1')).toBe(true);
  });

  it('records a user.deactivated audit event with the revoked count (Req 37.1)', async () => {
    const h = makeHarness();
    h.sessions.seed(makeSessionRecord({ id: 's1', userId: 'user-1' }));

    await h.manager.deactivateUser(h.ctx, 'user-1');

    const events = h.audit.withAction('user.deactivated');
    expect(events).toHaveLength(1);
    expect(events[0]?.event.resourceId).toBe('user-1');
    expect(events[0]?.event.metadata?.revokedCount).toBe(1);
  });

  it('marks a user with no active sessions deactivated, revoking 0 (Req 20.5)', async () => {
    const h = makeHarness();

    const revoked = await h.manager.deactivateUser(h.ctx, 'user-1');

    expect(revoked).toBe(0);
    expect(await h.deactivation.isDeactivated(h.ctx, 'user-1')).toBe(true);
  });

  it('does not report the deactivation across an Organization boundary (Req 1.4)', async () => {
    const h = makeHarness();
    await h.manager.deactivateUser(h.ctx, 'user-1');

    const otherOrg = makeDeviceTenant({ organizationId: 'org-2', userId: 'admin' });
    expect(await h.deactivation.isDeactivated(otherOrg, 'user-1')).toBe(false);
  });
});

describe('DeviceManager + AuthService cross-visibility (Req 33.11, 33.13)', () => {
  /**
   * Wire a REAL {@link AuthService} and a {@link DeviceManager} over the SAME
   * {@link InMemorySessionStore}, so a revocation by the manager must be visible
   * to the service's `validate` — proving they share one session model rather
   * than two parallel ones.
   */
  function makeWiredHarness() {
    const sessions = new InMemorySessionStore();
    const clock = new MutableAuthClock(START);
    const auth = new AuthService({
      provider: new FakeAuthProvider({
        passwords: [
          { email: 'user@example.com', password: 'pw', identity: makeIdentity({ userId: 'user-1' }) },
        ],
      }),
      sessions,
      identityLinks: new InMemoryIdentityLinkStore(),
      mfaFactors: new InMemoryMfaEnrollmentStore(),
      audit: new CapturingAuditRecorder(),
      tokenGenerator: new SequentialTokenGenerator(),
      tokenHasher: new FakeTokenHasher(),
      idGenerator: sequentialAuthIdGenerator(),
      clock,
    });
    const manager = new DeviceManager({
      sessions,
      audit: new CapturingAuditRecorder(),
      deactivation: new InMemoryDeactivationStore(),
      // The DeviceManager's clock shares the Date-returning shape; reuse the
      // auth clock so both services agree on "now".
      clock,
    });
    return { sessions, auth, manager };
  }

  it('rejects a token whose device the Device_Manager revoked (Req 33.11)', async () => {
    const { auth, manager } = makeWiredHarness();
    const result = await auth.signInPassword({
      email: 'user@example.com',
      password: 'pw',
      device: { deviceId: 'dev-A', deviceName: 'Laptop' },
    });
    // The freshly-issued token validates ...
    await expect(auth.validate(result.tokens.access)).resolves.toMatchObject({ userId: 'user-1' });

    // ... until the Device_Manager revokes that device's sessions ...
    const ctx = makeDeviceTenant({ organizationId: result.session.organizationId, userId: 'user-1' });
    const revoked = await manager.revokeDevice(ctx, 'user-1', 'dev-A');
    expect(revoked).toBe(1);

    // ... after which the AuthService rejects the token as revoked (Req 33.13).
    await expect(auth.validate(result.tokens.access)).rejects.toBeInstanceOf(InvalidSessionError);
    await expect(auth.validate(result.tokens.access)).rejects.toMatchObject({ reason: 'revoked' });
  });

  it('rejects a token whose session deactivateUser invalidated (Req 20.5)', async () => {
    const { auth, manager } = makeWiredHarness();
    const result = await auth.signInPassword({ email: 'user@example.com', password: 'pw' });
    await expect(auth.validate(result.tokens.access)).resolves.toMatchObject({ userId: 'user-1' });

    const ctx = makeDeviceTenant({ organizationId: result.session.organizationId, userId: 'user-1' });
    await manager.deactivateUser(ctx, 'user-1');

    await expect(auth.validate(result.tokens.access)).rejects.toMatchObject({ reason: 'revoked' });
    // And a refresh of the same session is likewise rejected.
    if (result.tokens.refresh !== undefined) {
      await expect(auth.refresh(result.tokens.refresh)).rejects.toMatchObject({ reason: 'revoked' });
    }
  });
});

describe('toDeviceSession projection', () => {
  it('drops token hashes and copies device metadata + timestamps', () => {
    const record = makeSessionRecord({
      id: 'sess-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deviceId: 'dev-A',
      deviceName: 'Phone',
    });

    const projected = toDeviceSession(record, 'sess-1');

    expect(projected).toEqual({
      sessionId: 'sess-1',
      userId: 'user-1',
      organizationId: 'org-1',
      method: 'password',
      deviceId: 'dev-A',
      deviceName: 'Phone',
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      expiresAt: record.expiresAt,
      current: true,
    });
  });
});
