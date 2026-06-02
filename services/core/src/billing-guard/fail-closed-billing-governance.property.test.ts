/**
 * Property-based test for fail-closed credit-only billing governance.
 *
 * Feature: auxify-ai-platform, Property 45: Credit-only billing governance is
 * fail-closed.
 *
 * Design statement (Property 45): "For any billable dependency the platform may
 * adopt, adoption proceeds if and only if the dependency is billable through
 * AWS or Azure credits and that billing compliance can be verified, or an owner
 * has granted explicit approval; otherwise the Billing_Guard blocks adoption
 * (flagging it for owner approval when no credit-billable option exists)."
 *
 * Validates: Requirements 43.1, 43.2, 43.3, 43.4, 43.5
 *
 * Strategy. We drive the real {@link BillingGuard} (and its public
 * {@link decideBilling} core) over the in-package fakes — no external registry
 * or Audit_Service — across >= 100 generated scenarios. Each scenario varies the
 * full input space the guard observes:
 *   - a {@link BillingComplianceStatus} with `creditBillable`, `creditProvider`,
 *     `verifiable`, and `ownerApproved` each independently varied (including
 *     omitted optionals); plus
 *   - the two "status cannot be obtained" cases: the registry has no entry for
 *     the dependency (returns `undefined`) and the registry itself throws.
 *
 * An independent oracle re-derives the documented fail-closed decision model
 * directly from the status (never by calling the guard), and we assert the guard
 * returns exactly that decision, that `allowed` is true ONLY in the
 * owner-approved or verified-credit-billable cases (fail-closed by
 * construction), that every block is audited exactly once while allows audit
 * nothing, and that `verifyOrThrow` throws {@link BillingBlockedError} on a
 * block while returning the allow decision otherwise.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BillingGuard, decideBilling } from './billing-guard.js';
import { BillingBlockedError } from './errors.js';
import {
  CapturingAuditRecorder,
  FakeBillingStatusProvider,
  makeDependency,
} from './fakes.js';
import {
  CREDIT_PROVIDERS,
  DEPENDENCY_CATEGORIES,
  type BillableDependency,
  type BillingComplianceStatus,
  type BillingDecision,
  type BillingDenialCode,
  type CreditProvider,
} from './types.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 300;

/** A distinctive cause the unavailable-registry behavior throws; must never leak into a verdict. */
const REGISTRY_FAILURE = new Error('billing-registry-unreachable-c0ffee');

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * An arbitrary {@link BillingComplianceStatus} exercising every field
 * independently. `creditProvider` and `ownerApproved` are each generated as
 * "present or omitted" so the guard's `!== undefined` / `=== true` checks are
 * probed from both sides.
 */
const statusArb: fc.Arbitrary<BillingComplianceStatus> = fc.record({
  creditBillable: fc.boolean(),
  creditProvider: fc.option(fc.constantFrom<CreditProvider>(...CREDIT_PROVIDERS), {
    nil: undefined,
  }),
  verifiable: fc.boolean(),
  ownerApproved: fc.option(fc.boolean(), { nil: undefined }),
});

/** How the injected billing-compliance port behaves for the scenario's dependency. */
type ProviderBehavior =
  | { kind: 'present'; status: BillingComplianceStatus }
  | { kind: 'absent' }
  | { kind: 'throws' };

const behaviorArb: fc.Arbitrary<ProviderBehavior> = fc.oneof(
  // Weight toward a concrete status so all five decision rules are sampled,
  // while still regularly exercising both fail-closed "no status" cases.
  { weight: 6, arbitrary: statusArb.map((status) => ({ kind: 'present', status }) as const) },
  { weight: 1, arbitrary: fc.constant({ kind: 'absent' } as const) },
  { weight: 1, arbitrary: fc.constant({ kind: 'throws' } as const) },
);

/** A full {@link BillableDependency}; id is non-empty so the registry lookup is well-defined. */
const dependencyArb: fc.Arbitrary<BillableDependency> = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 24 }),
    name: fc.string({ maxLength: 24 }),
    category: fc.constantFrom(...DEPENDENCY_CATEGORIES),
    organizationId: fc.string({ minLength: 1, maxLength: 24 }),
  })
  .map((overrides) => makeDependency(overrides));

interface Scenario {
  dependency: BillableDependency;
  behavior: ProviderBehavior;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  dependency: dependencyArb,
  behavior: behaviorArb,
});

// ---------------------------------------------------------------------------
// Independent oracle — the documented fail-closed decision model
// ---------------------------------------------------------------------------

/** The decision fields the property pins down, independent of human-readable wording. */
interface DecisionShape {
  allowed: boolean;
  flaggedForOwnerApproval: boolean;
  denialCode?: BillingDenialCode;
  creditProvider?: CreditProvider;
}

/** The status the port ultimately surfaces to the guard for a behavior (undefined when it can't be obtained). */
function resolvedStatus(behavior: ProviderBehavior): BillingComplianceStatus | undefined {
  return behavior.kind === 'present' ? behavior.status : undefined;
}

/**
 * Re-derive the expected decision purely from the resolved status, mirroring the
 * documented rule order without consulting the guard:
 *   undefined        -> block(verification_unavailable, not flagged)
 *   ownerApproved    -> allow (carrying creditProvider when present)
 *   !creditBillable  -> block(no_credit_billable_option, flagged)
 *   !verifiable      -> block(unverifiable, not flagged)
 *   else             -> allow (carrying creditProvider when present)
 */
function expectedDecision(status: BillingComplianceStatus | undefined): DecisionShape {
  if (status === undefined) {
    return { allowed: false, flaggedForOwnerApproval: false, denialCode: 'verification_unavailable' };
  }
  if (status.ownerApproved === true) {
    return allow(status.creditProvider);
  }
  if (!status.creditBillable) {
    return { allowed: false, flaggedForOwnerApproval: true, denialCode: 'no_credit_billable_option' };
  }
  if (!status.verifiable) {
    return { allowed: false, flaggedForOwnerApproval: false, denialCode: 'unverifiable' };
  }
  return allow(status.creditProvider);
}

function allow(creditProvider: CreditProvider | undefined): DecisionShape {
  const shape: DecisionShape = { allowed: true, flaggedForOwnerApproval: false };
  if (creditProvider !== undefined) {
    shape.creditProvider = creditProvider;
  }
  return shape;
}

/** Project a real {@link BillingDecision} onto the comparable shape, dropping the free-text reason. */
function project(decision: BillingDecision): DecisionShape {
  const shape: DecisionShape = {
    allowed: decision.allowed,
    flaggedForOwnerApproval: decision.flaggedForOwnerApproval,
  };
  if (decision.denialCode !== undefined) {
    shape.denialCode = decision.denialCode;
  }
  if (decision.creditProvider !== undefined) {
    shape.creditProvider = decision.creditProvider;
  }
  return shape;
}

/** Whether adoption SHOULD proceed under the fail-closed contract. */
function shouldAllow(status: BillingComplianceStatus | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  return status.ownerApproved === true || (status.creditBillable && status.verifiable);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** Build a fresh guard + capturing audit recorder for a scenario (one per assertion, for clean counts). */
function buildGuard(scenario: Scenario): { guard: BillingGuard; audit: CapturingAuditRecorder } {
  const audit = new CapturingAuditRecorder();
  let provider: FakeBillingStatusProvider;
  switch (scenario.behavior.kind) {
    case 'throws':
      provider = new FakeBillingStatusProvider({}, REGISTRY_FAILURE);
      break;
    case 'absent':
      provider = new FakeBillingStatusProvider({});
      break;
    case 'present':
      provider = new FakeBillingStatusProvider({ [scenario.dependency.id]: scenario.behavior.status });
      break;
  }
  const guard = new BillingGuard({ statusProvider: provider, auditRecorder: audit });
  return { guard, audit };
}

/** Explicit witnesses guaranteeing every rule (and both no-status cases) is checked each run. */
function scenario(behavior: ProviderBehavior, dependency: Partial<BillableDependency> = {}): Scenario {
  return { dependency: makeDependency({ id: 'witness', ...dependency }), behavior };
}

const RULE_WITNESSES: Scenario[] = [
  // Rule 5 — verified credit-billable (AWS and Azure), allowed.
  scenario({ kind: 'present', status: { creditBillable: true, creditProvider: 'aws', verifiable: true } }),
  scenario({ kind: 'present', status: { creditBillable: true, creditProvider: 'azure', verifiable: true } }),
  // Rule 4 — credit-billable but unverifiable, blocked (not flagged).
  scenario({ kind: 'present', status: { creditBillable: true, creditProvider: 'aws', verifiable: false } }),
  // Rule 3 — no credit-billable option, blocked AND flagged for owner approval.
  scenario({ kind: 'present', status: { creditBillable: false, verifiable: true } }),
  // Rule 2 — owner approval overrides a non-credit-billable, unverifiable status.
  scenario({ kind: 'present', status: { creditBillable: false, verifiable: false, ownerApproved: true } }),
  // Rule 2 — owner approval on an unverifiable credit-billable status (carries provider).
  scenario({
    kind: 'present',
    status: { creditBillable: true, creditProvider: 'azure', verifiable: false, ownerApproved: true },
  }),
  // Rule 1 — status absent from the registry, fail closed.
  scenario({ kind: 'absent' }),
  // Rule 1 — registry itself throws, fail closed.
  scenario({ kind: 'throws' }),
];

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 45: Credit-only billing governance is fail-closed', () => {
  it('allows adoption iff verified-credit-billable or owner-approved, else blocks (flagging only when no credit option), audits every block exactly once, and verifyOrThrow throws on a block (Validates: Requirements 43.1, 43.2, 43.3, 43.4, 43.5)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (s) => {
        const status = resolvedStatus(s.behavior);

        // --- verify(): the structured verdict matches the independent oracle exactly.
        const { guard, audit } = buildGuard(s);
        const decision = await guard.verify(s.dependency, {
          ip: '198.51.100.7',
          userAgent: 'adoption-cli/1.0',
        });

        expect(project(decision)).toEqual(expectedDecision(status));

        // The pure decision core agrees with the guard for the resolved status.
        expect(project(decideBilling(status))).toEqual(expectedDecision(status));

        // --- Fail-closed: allowed is true ONLY in the two positive cases.
        expect(decision.allowed).toBe(shouldAllow(status));

        // A block always names a fail-closed reason; an allow never does.
        if (decision.allowed) {
          expect(decision.denialCode).toBeUndefined();
          expect(decision.flaggedForOwnerApproval).toBe(false);
        } else {
          expect(decision.denialCode).toBeDefined();
        }

        // Flagging-for-owner-approval happens exactly when no credit-billable option exists.
        const expectFlag = status !== undefined && status.ownerApproved !== true && !status.creditBillable;
        expect(decision.flaggedForOwnerApproval).toBe(expectFlag);

        // --- Audit-on-block: exactly one billing.blocked event per block, none for allows.
        if (decision.allowed) {
          expect(audit.count).toBe(0);
        } else {
          expect(audit.count).toBe(1);
          const blocks = audit.withAction('billing.blocked');
          expect(blocks).toHaveLength(1);
          const captured = blocks[0]!;
          // Scoped to the adopting Organization and naming the dependency.
          expect(captured.ctx.organizationId).toBe(s.dependency.organizationId);
          expect(captured.event.resourceType).toBe('billable_dependency');
          expect(captured.event.resourceId).toBe(s.dependency.id);
          expect(captured.event.metadata).toMatchObject({
            dependencyCategory: s.dependency.category,
            denialCode: decision.denialCode,
            flaggedForOwnerApproval: decision.flaggedForOwnerApproval,
          });
        }

        // --- A thrown registry never leaks its cause into the verdict (Req 43.5).
        if (s.behavior.kind === 'throws') {
          expect(decision.denialCode).toBe('verification_unavailable');
          expect(decision.reason).not.toContain(REGISTRY_FAILURE.message);
        }

        // --- verifyOrThrow(): throws BillingBlockedError on a block, returns the allow otherwise.
        const { guard: guard2 } = buildGuard(s);
        if (decision.allowed) {
          const thrownDecision = await guard2.verifyOrThrow(s.dependency);
          expect(thrownDecision.allowed).toBe(true);
          expect(project(thrownDecision)).toEqual(expectedDecision(status));
        } else {
          await expect(guard2.verifyOrThrow(s.dependency)).rejects.toBeInstanceOf(BillingBlockedError);
          try {
            await guard2.verifyOrThrow(s.dependency);
            expect.unreachable('verifyOrThrow must throw on a block');
          } catch (error) {
            expect(error).toBeInstanceOf(BillingBlockedError);
            const blocked = error as BillingBlockedError;
            expect(blocked.code).toBe(decision.denialCode);
            expect(blocked.dependencyId).toBe(s.dependency.id);
            expect(blocked.decision.allowed).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS, examples: RULE_WITNESSES.map((w) => [w] as [Scenario]) },
    );
  });
});
