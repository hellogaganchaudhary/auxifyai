/**
 * Property-based test for **Property 51: MFA is required whenever any MFA
 * condition holds** (design "Property 51"; Req 33.5, 33.6, 33.7).
 *
 * **Validates: Requirements 33.5, 33.6, 33.7**
 *
 * Property 51 (design): _For any_ user, the Auth_Service requires a second
 * factor before establishing a session if and only if at least one of the
 * following holds: MFA is enabled for that user (Req 33.5), the user holds a
 * privileged role of `super_admin` or `admin` (Req 33.6), or an applicable
 * Organization policy mandates MFA (Req 33.7).
 *
 * The property is exercised against the pure decision core
 * {@link resolveMfaRequirement} (with {@link hasPrivilegedRole}), which is the
 * single place the Auth_Service consults to gate session establishment. An
 * arbitrary is built over the THREE independent conditions — the per-user MFA
 * flag, the user's roles (drawn from the full {@link ROLES} set so the
 * privileged-role condition is sometimes true and sometimes not), and the
 * org-policy flag — and the core's `required` verdict is cross-checked against
 * an INDEPENDENT boolean oracle: the disjunction of the three conditions. The
 * reported `reasons` are checked to be exactly consistent with which
 * condition(s) held: a required verdict names at least one true condition (and
 * names a condition only when it is true), and a not-required verdict carries no
 * reasons and arises only when all three conditions are false.
 *
 * A secondary property drives the real {@link AuthService.signInPassword}
 * through the deterministic fakes (imported directly from `./fakes.js`, matching
 * the module convention): presenting valid credentials WITHOUT a second factor
 * raises {@link MfaRequiredError} exactly when the requirement holds, and
 * otherwise establishes a session with `mfaSatisfied: false`. The pure-core iff
 * remains the primary property.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ROLES, type Role } from '@auxify/types';

import { AuthService, MfaRequiredError, hasPrivilegedRole, resolveMfaRequirement } from './index.js';
import type { MfaRequirementInput, MfaRequirementReason } from './index.js';
import {
  CapturingAuditRecorder,
  FakeAuthProvider,
  FakeTokenHasher,
  InMemoryIdentityLinkStore,
  InMemoryMfaEnrollmentStore,
  InMemorySessionStore,
  MutableAuthClock,
  SequentialTokenGenerator,
  makeIdentity,
  sequentialAuthIdGenerator,
} from './fakes.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Arbitrary over the three independent MFA conditions
// ---------------------------------------------------------------------------

/** The three independent conditions that each, alone, force MFA (Req 33.5-33.7). */
interface Conditions {
  /** Whether MFA is enabled for the user (Req 33.5). */
  mfaEnabledForUser: boolean;
  /** The user's roles, drawn from the full role set (drives Req 33.6). */
  roles: Role[];
  /** Whether an applicable Organization policy mandates MFA (Req 33.7). */
  orgPolicyMandatesMfa: boolean;
}

/**
 * Generate the three conditions independently: a per-user flag, an arbitrary
 * subset of the full {@link ROLES} set (so the privileged-role condition is
 * sometimes true via `super_admin`/`admin` and sometimes not — the empty set is
 * included), and an org-policy flag.
 */
const conditionsArb: fc.Arbitrary<Conditions> = fc.record({
  mfaEnabledForUser: fc.boolean(),
  roles: fc.subarray([...ROLES]),
  orgPolicyMandatesMfa: fc.boolean(),
});

/** The independent oracle: MFA is required iff any single condition holds. */
function mfaRequiredOracle(c: Conditions): boolean {
  return c.mfaEnabledForUser || hasPrivilegedRole(c.roles) || c.orgPolicyMandatesMfa;
}

/** Project the generated conditions into the pure core's input shape. */
function toInput(c: Conditions): MfaRequirementInput {
  return {
    roles: c.roles,
    userMfaEnabled: c.mfaEnabledForUser,
    orgMfaRequired: c.orgPolicyMandatesMfa,
  };
}

// ---------------------------------------------------------------------------
// AuthService harness (deterministic fakes) for the secondary property
// ---------------------------------------------------------------------------

const SIGN_IN_EMAIL = 'user@example.com';
const SIGN_IN_PASSWORD = 'correct horse battery staple';

/**
 * Construct an {@link AuthService} wired with deterministic fakes whose sole
 * password credential resolves to an identity carrying the generated MFA-
 * relevant facts. The identity's `mfaEnabled`/`roles`/`orgMfaRequired` mirror
 * the three conditions, so a credentials-only sign-in attempt exercises the same
 * requirement the pure core resolves.
 */
function makeServiceFor(c: Conditions): AuthService {
  const identity = makeIdentity({
    userId: 'u-1',
    organizationId: 'org-1',
    roles: c.roles,
    mfaEnabled: c.mfaEnabledForUser,
    orgMfaRequired: c.orgPolicyMandatesMfa,
  });
  return new AuthService({
    provider: new FakeAuthProvider({
      passwords: [{ email: SIGN_IN_EMAIL, password: SIGN_IN_PASSWORD, identity }],
    }),
    sessions: new InMemorySessionStore(),
    identityLinks: new InMemoryIdentityLinkStore(),
    mfaFactors: new InMemoryMfaEnrollmentStore(),
    audit: new CapturingAuditRecorder(),
    tokenGenerator: new SequentialTokenGenerator(),
    tokenHasher: new FakeTokenHasher(),
    idGenerator: sequentialAuthIdGenerator(),
    clock: new MutableAuthClock(),
  });
}

// ---------------------------------------------------------------------------
// Property 51
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 51: MFA is required whenever any MFA condition holds', () => {
  it('resolveMfaRequirement.required is true iff any condition holds, with reasons consistent with which held (Validates: Requirements 33.5, 33.6, 33.7)', () => {
    fc.assert(
      fc.property(conditionsArb, (c) => {
        const result = resolveMfaRequirement(toInput(c));

        // The if-and-only-if core: required exactly when any single condition is
        // true — enabled per user (33.5), a privileged role (33.6), or org
        // policy (33.7).
        const expected = mfaRequiredOracle(c);
        expect(result.required).toBe(expected);

        // `required` is precisely "at least one reason was reported".
        expect(result.required).toBe(result.reasons.length > 0);

        // Each reason is reported exactly when its underlying condition holds —
        // a required verdict names at least one true condition and never names a
        // false one.
        const reasonHeld: Record<MfaRequirementReason, boolean> = {
          user_enabled: c.mfaEnabledForUser,
          privileged_role: hasPrivilegedRole(c.roles),
          org_policy: c.orgPolicyMandatesMfa,
        };
        for (const reason of ['user_enabled', 'privileged_role', 'org_policy'] as const) {
          expect(result.reasons.includes(reason)).toBe(reasonHeld[reason]);
        }

        if (result.required) {
          // A required result names at least one condition that actually held.
          expect(result.reasons.length).toBeGreaterThan(0);
          expect(result.reasons.every((r) => reasonHeld[r])).toBe(true);
        } else {
          // A not-required result holds only when all three conditions are false.
          expect(result.reasons).toEqual([]);
          expect(c.mfaEnabledForUser).toBe(false);
          expect(hasPrivilegedRole(c.roles)).toBe(false);
          expect(c.orgPolicyMandatesMfa).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('AuthService.signInPassword raises MfaRequiredError without a second factor exactly when the requirement holds (Validates: Requirements 33.5, 33.6, 33.7)', async () => {
    await fc.assert(
      fc.asyncProperty(conditionsArb, async (c) => {
        const service = makeServiceFor(c);
        const required = mfaRequiredOracle(c);

        // A credentials-only sign-in (no mfaCode) must be gated exactly when the
        // requirement holds — the AuthService consults the same pure core.
        if (required) {
          await expect(
            service.signInPassword({ email: SIGN_IN_EMAIL, password: SIGN_IN_PASSWORD }),
          ).rejects.toBeInstanceOf(MfaRequiredError);
        } else {
          const result = await service.signInPassword({
            email: SIGN_IN_EMAIL,
            password: SIGN_IN_PASSWORD,
          });
          // No required factor, so the session establishes with none satisfied.
          expect(result.session.mfaSatisfied).toBe(false);
          expect(result.session.userId).toBe('u-1');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
