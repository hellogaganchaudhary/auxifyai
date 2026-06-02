/**
 * Property-based test for **Property 52: Session invalidation is immediate and
 * scoped** (design "Property 52"; Req 20.5, 33.11, 33.13).
 *
 * **Validates: Requirements 20.5, 33.11, 33.13**
 *
 * Property 52 (design): _For any_ sign-out, device revocation, or user
 * deactivation, the targeted session tokens are rejected on all subsequent use;
 * device revocation invalidates only the revoked device's tokens while leaving
 * other devices' tokens valid, and deactivation invalidates all of the user's
 * sessions and blocks further authentication.
 *
 * The property is exercised end-to-end across the SAME session model the
 * {@link AuthService} and {@link DeviceManager} share: a single
 * {@link InMemorySessionStore} (re-exported by the device fakes) is wired into
 * BOTH a real {@link AuthService} and a real {@link DeviceManager}, with both
 * services reading the SAME fixed instant (an {@link MutableAuthClock} and a
 * {@link MutableDeviceClock} pinned to one ISO time). A scenario establishes N
 * REAL signed-in sessions through {@link AuthService.signInPassword} — each on
 * one of a small pool of device ids, so several sessions share a device — and so
 * each carries a live raw access token. An invalidation is then driven THROUGH
 * the Device_Manager and the effect observed THROUGH `AuthService.validate`:
 *
 *   - **Sign-out** ({@link DeviceManager.revokeSession} of one session): exactly
 *     that session's access token is rejected afterward; every OTHER session —
 *     even one bound to the same device — still validates (Req 33.13).
 *   - **Device revocation** ({@link DeviceManager.revokeDevice} of one device id,
 *     the HEART of Property 52): every session bound to the revoked device is
 *     rejected, while sessions on OTHER devices STILL validate (scoped); the
 *     returned count equals that device's active-session count (Req 33.11).
 *   - **User deactivation** ({@link DeviceManager.deactivateUser}): ALL of the
 *     user's session tokens are rejected, the {@link InMemoryDeactivationStore}
 *     reports the user deactivated, and a deactivation-aware sign-in path
 *     consults it and refuses further authentication (Req 20.5).
 *
 * Immediacy is asserted directly: every relevant token validates BEFORE the
 * operation and is rejected immediately AFTER, with NO clock advance — the
 * rejection is a consequence of the revocation alone, not of expiry. A rejected
 * validation is checked to be the precise {@link InvalidSessionError} with reason
 * `'revoked'`.
 *
 * The fakes are imported directly from `./fakes.js` (the device fakes) and
 * `../auth/fakes.js` (the auth fakes), matching the established module
 * convention.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Role, TenantContext } from '@auxify/types';

import { AuthService, InvalidSessionError } from '../auth/index.js';
import {
  CapturingAuditRecorder,
  FakeAuthProvider,
  FakeTokenHasher,
  InMemoryIdentityLinkStore,
  InMemoryMfaEnrollmentStore,
  MutableAuthClock,
  SequentialTokenGenerator,
  makeIdentity,
  sequentialAuthIdGenerator,
} from '../auth/fakes.js';
import { DeviceManager } from '../device/index.js';
import {
  InMemoryDeactivationStore,
  InMemorySessionStore,
  MutableDeviceClock,
  makeDeviceTenant,
} from './fakes.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 150;

/** The single password credential every harness signs in with. */
const EMAIL = 'user@example.com';
const PASSWORD = 'correct horse battery staple';

/** The signed-in user and Organization shared by every scenario. */
const USER_ID = 'user-1';
const ORG_ID = 'org-1';

/** Non-privileged roles, so MFA is never required and sign-in always establishes a session. */
const SIGN_IN_ROLES: Role[] = ['standard_user'];

/** The fixed instant BOTH the auth clock and the device clock are pinned to. */
const NOW_ISO = '2026-01-01T00:00:00.000Z';

/** A small device-id pool so generated sessions spread across — and share — devices. */
const DEVICE_POOL = ['device-alpha', 'device-beta', 'device-gamma', 'device-delta'] as const;

// ---------------------------------------------------------------------------
// Harness: ONE shared session store backing a real AuthService + DeviceManager
// ---------------------------------------------------------------------------

/** A session established through {@link AuthService.signInPassword} with its live access token. */
interface EstablishedSession {
  /** The established session's id (the handle a sign-out targets). */
  sessionId: string;
  /** The device the session is bound to. */
  deviceId: string;
  /** The raw access token returned once at sign-in (presented to `validate`). */
  accessToken: string;
}

/** The wired services that share a single {@link InMemorySessionStore} and a single instant. */
interface Harness {
  store: InMemorySessionStore;
  authService: AuthService;
  deviceManager: DeviceManager;
  deactivation: InMemoryDeactivationStore;
  ctx: TenantContext;
}

/**
 * Wire a real {@link AuthService} and a real {@link DeviceManager} over the SAME
 * {@link InMemorySessionStore}, with both clocks pinned to {@link NOW_ISO} so the
 * two services agree on "now" for every session-active check. A revocation by
 * the Device_Manager is therefore immediately visible to `AuthService.validate`.
 */
function makeHarness(): Harness {
  const store = new InMemorySessionStore();
  const deactivation = new InMemoryDeactivationStore();
  const identity = makeIdentity({
    userId: USER_ID,
    organizationId: ORG_ID,
    roles: SIGN_IN_ROLES,
    mfaEnabled: false,
    orgMfaRequired: false,
  });

  const authService = new AuthService({
    provider: new FakeAuthProvider({
      passwords: [{ email: EMAIL, password: PASSWORD, identity }],
    }),
    sessions: store,
    identityLinks: new InMemoryIdentityLinkStore(),
    mfaFactors: new InMemoryMfaEnrollmentStore(),
    audit: new CapturingAuditRecorder(),
    tokenGenerator: new SequentialTokenGenerator(),
    tokenHasher: new FakeTokenHasher(),
    idGenerator: sequentialAuthIdGenerator(),
    clock: new MutableAuthClock(NOW_ISO),
  });

  const deviceManager = new DeviceManager({
    sessions: store,
    audit: new CapturingAuditRecorder(),
    deactivation,
    clock: new MutableDeviceClock(NOW_ISO),
  });

  // The acting administrator's context; the deactivation fact is scoped to ORG_ID.
  const ctx = makeDeviceTenant({ organizationId: ORG_ID, userId: 'admin-1' });

  return { store, authService, deviceManager, deactivation, ctx };
}

/**
 * Establish one REAL signed-in session per device id, in order, returning each
 * session's id, device, and the live raw access token issued at sign-in.
 */
async function establishSessions(
  svc: AuthService,
  deviceIds: readonly string[],
): Promise<EstablishedSession[]> {
  const established: EstablishedSession[] = [];
  for (const deviceId of deviceIds) {
    const result = await svc.signInPassword({
      email: EMAIL,
      password: PASSWORD,
      device: { deviceId },
    });
    established.push({
      sessionId: result.session.id,
      deviceId,
      accessToken: result.tokens.access,
    });
  }
  return established;
}

/** Assert the access token validates and resolves to the expected live session. */
async function expectValid(svc: AuthService, session: EstablishedSession): Promise<void> {
  const identity = await svc.validate(session.accessToken);
  expect(identity.sessionId).toBe(session.sessionId);
  expect(identity.userId).toBe(USER_ID);
}

/** Assert the access token is rejected with the precise `revoked` {@link InvalidSessionError}. */
async function expectRevoked(svc: AuthService, accessToken: string): Promise<void> {
  let caught: unknown;
  try {
    await svc.validate(accessToken);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidSessionError);
  expect((caught as InvalidSessionError).reason).toBe('revoked');
}

/**
 * A deactivation-aware sign-in gate (the "prevent the user from authenticating"
 * half of Req 20.5): it consults {@link InMemoryDeactivationStore.isDeactivated}
 * and refuses before delegating to {@link AuthService.signInPassword}.
 *
 * @returns `true` when the sign-in was refused because the user is deactivated.
 */
async function signInGuarded(
  svc: AuthService,
  deactivation: InMemoryDeactivationStore,
  ctx: TenantContext,
  userId: string,
): Promise<boolean> {
  if (await deactivation.isDeactivated(ctx, userId)) {
    return true;
  }
  await svc.signInPassword({ email: EMAIL, password: PASSWORD });
  return false;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generate one device id per session from the small {@link DEVICE_POOL}; the
 * array length is the session count N (>= 1) and the pool size guarantees some
 * sessions share a device while others differ.
 */
const deviceIdsArb: fc.Arbitrary<string[]> = fc.array(fc.constantFrom(...DEVICE_POOL), {
  minLength: 1,
  maxLength: 6,
});

/** A seed used to pick a target session/device deterministically per run. */
const seedArb: fc.Arbitrary<number> = fc.nat();

// ---------------------------------------------------------------------------
// Property 52
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 52: Session invalidation is immediate and scoped', () => {
  it('sign-out rejects only the targeted session immediately, leaving every other session valid (Validates: Requirements 33.13)', async () => {
    await fc.assert(
      fc.asyncProperty(deviceIdsArb, seedArb, async (deviceIds, seed) => {
        const h = makeHarness();
        const sessions = await establishSessions(h.authService, deviceIds);

        // Immediacy (before): every token validates prior to any invalidation.
        for (const session of sessions) {
          await expectValid(h.authService, session);
        }

        const target = sessions[seed % sessions.length];
        if (target === undefined) {
          throw new Error('unreachable: at least one session is always established');
        }

        // Sign-out of a single session (Req 33.13).
        await h.deviceManager.revokeSession(h.ctx, target.sessionId);

        // Immediacy (after): the targeted token is rejected now, no clock advance.
        await expectRevoked(h.authService, target.accessToken);

        // Scope: every OTHER session — including any on the SAME device — survives.
        for (const session of sessions) {
          if (session.sessionId !== target.sessionId) {
            await expectValid(h.authService, session);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('device revocation rejects only the revoked device\'s tokens while other devices stay valid, returning that device\'s active count (Validates: Requirements 33.11)', async () => {
    await fc.assert(
      fc.asyncProperty(deviceIdsArb, seedArb, async (deviceIds, seed) => {
        const h = makeHarness();
        const sessions = await establishSessions(h.authService, deviceIds);

        // Immediacy (before): every token validates prior to revocation.
        for (const session of sessions) {
          await expectValid(h.authService, session);
        }

        const uniqueDevices = [...new Set(deviceIds)];
        const targetDevice = uniqueDevices[seed % uniqueDevices.length];
        if (targetDevice === undefined) {
          throw new Error('unreachable: at least one device is always present');
        }
        const expectedCount = sessions.filter((s) => s.deviceId === targetDevice).length;

        // Revoke exactly one device (Req 33.11); the count is that device's active sessions.
        const revokedCount = await h.deviceManager.revokeDevice(h.ctx, USER_ID, targetDevice);
        expect(revokedCount).toBe(expectedCount);

        // Scope (the heart of Property 52): only the revoked device's tokens die;
        // every other device's tokens still validate — immediately, no clock advance.
        for (const session of sessions) {
          if (session.deviceId === targetDevice) {
            await expectRevoked(h.authService, session.accessToken);
          } else {
            await expectValid(h.authService, session);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('user deactivation rejects ALL of the user\'s tokens immediately and blocks further authentication (Validates: Requirements 20.5)', async () => {
    await fc.assert(
      fc.asyncProperty(deviceIdsArb, async (deviceIds) => {
        const h = makeHarness();
        const sessions = await establishSessions(h.authService, deviceIds);

        // Immediacy (before): every token validates and the user is not yet deactivated.
        for (const session of sessions) {
          await expectValid(h.authService, session);
        }
        expect(await h.deactivation.isDeactivated(h.ctx, USER_ID)).toBe(false);

        // Deactivate the user (Req 20.5): every active session is revoked.
        const revokedCount = await h.deviceManager.deactivateUser(h.ctx, USER_ID);
        expect(revokedCount).toBe(sessions.length);

        // Immediacy (after): ALL of the user's tokens are rejected now.
        for (const session of sessions) {
          await expectRevoked(h.authService, session.accessToken);
        }

        // Further authentication is blocked: the fact is recorded and the
        // deactivation-aware sign-in path consults it and refuses (Req 20.5).
        expect(await h.deactivation.isDeactivated(h.ctx, USER_ID)).toBe(true);
        const refused = await signInGuarded(h.authService, h.deactivation, h.ctx, USER_ID);
        expect(refused).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
