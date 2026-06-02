/**
 * Feature: auxify-ai-platform, Property 55: Fail-closed compliance blocks
 * unverifiable operations.
 *
 * Validates: Requirements 38.6
 *
 * Design statement (Property 55): "For any operation whose compliance with the
 * Organization's configured retention and privacy policy cannot be verified, the
 * Compliance_Manager blocks the operation and records the blocked operation in
 * the Audit_Service."
 *
 * What "cannot be verified" maps to in the code (READ from `retention.ts`'s pure
 * {@link decideCompliance} and the manager's {@link ComplianceManager.verifyCompliance}):
 * an operation is allowed iff **both** its `retentionVerified` and
 * `privacyVerified` preconditions are explicitly `true`. Every other shape — a
 * precondition that is `false`, or absent (`undefined`) — is unverifiable and
 * must fail closed, never allow-by-default. The fail-closed reason is one of:
 *
 *   - `verification_unavailable` — neither precondition was supplied at all;
 *   - `retention_unverifiable`   — retention compliance is not `true`;
 *   - `privacy_unverifiable`     — retention is verified but privacy is not.
 *
 * The suite pins three facets:
 *  1. (pure iff, the cleanest unit) For ANY operation, {@link decideCompliance}
 *     allows it iff retention AND privacy are both verified; otherwise it blocks
 *     fail-closed with exactly the expected {@link ComplianceDenialCode} — there
 *     is no allow-by-default path.
 *  2. (end-to-end block + audit) For ANY unverifiable operation, the real
 *     {@link ComplianceManager} (wired to the in-memory fakes) blocks it
 *     (`allowed: false`, and {@link ComplianceManager.verifyOrThrow} throws
 *     {@link ComplianceBlockedError}) AND records exactly one `compliance.blocked`
 *     event in the Audit_Service carrying the blocked operation's details
 *     (operation kind + resource id) and the fail-closed denial code.
 *  3. (control) An operation whose retention AND privacy compliance ARE verified
 *     is allowed and is NOT spuriously blocked — the same manager records no
 *     `compliance.blocked` event.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import {
  ComplianceBlockedError,
  ComplianceManager,
  RETENTION_RESOURCE_KINDS,
  decideCompliance,
  type ComplianceDenialCode,
  type ComplianceOperation,
} from '../compliance/index.js';
import {
  CapturingAuditRecorder,
  InMemoryLegalHoldStore,
  InMemoryRetentionPolicyStore,
  MutableComplianceClock,
} from './fakes.js';

/** At least 100 generated iterations, per the spec's PBT minimum. */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Independent oracle: re-derive the spec's fail-closed rule (Req 38.6) here in
// the test, so we decide the expected verdict WITHOUT consulting the module.
// ---------------------------------------------------------------------------

/** The expected fail-closed verdict for an operation, re-derived from the spec. */
interface ExpectedVerdict {
  allowed: boolean;
  denialCode?: ComplianceDenialCode;
}

/** Whether an operation's compliance can be verified: both preconditions are explicitly `true`. */
function isVerifiable(op: ComplianceOperation): boolean {
  return op.retentionVerified === true && op.privacyVerified === true;
}

/** The verdict the Compliance_Manager must reach, derived independently of the module. */
function expectedVerdict(op: ComplianceOperation): ExpectedVerdict {
  const retentionSupplied = op.retentionVerified !== undefined;
  const privacySupplied = op.privacyVerified !== undefined;
  if (!retentionSupplied && !privacySupplied) {
    return { allowed: false, denialCode: 'verification_unavailable' };
  }
  if (op.retentionVerified !== true) {
    return { allowed: false, denialCode: 'retention_unverifiable' };
  }
  if (op.privacyVerified !== true) {
    return { allowed: false, denialCode: 'privacy_unverifiable' };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** A non-empty operation label, e.g. `conversation.export` (recorded on a block). */
const kindArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'conversation.export',
    'file.share',
    'document.archive',
    'data.migrate',
    'subject.access',
  ),
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
);

/** A non-empty Organization id (scopes the audit record). */
const orgIdArb: fc.Arbitrary<string> = fc.constantFrom('org-1', 'org-2', 'org-3', 'org-tenant-x');

/** A non-empty resource id. */
const resourceIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter((s) => s.trim().length > 0);

/**
 * The tri-state of a verification precondition: explicitly verified (`true`),
 * explicitly unverified (`false`), or absent (`undefined`). Only `true`
 * contributes to a verifiable operation.
 */
const verificationArb: fc.Arbitrary<boolean | undefined> = fc.constantFrom<boolean | undefined>(
  true,
  false,
  undefined,
);

/** An arbitrary, fully-shaped {@link ComplianceOperation} across all verification states. */
const operationArb: fc.Arbitrary<ComplianceOperation> = fc.record({
  kind: kindArb,
  organizationId: orgIdArb,
  resourceKind: fc.option(fc.constantFrom(...RETENTION_RESOURCE_KINDS), { nil: undefined }),
  resourceId: fc.option(resourceIdArb, { nil: undefined }),
  retentionVerified: verificationArb,
  privacyVerified: verificationArb,
});

/** Only operations that CANNOT be verified compliant (not both preconditions `true`). */
const unverifiableOperationArb: fc.Arbitrary<ComplianceOperation> = operationArb.filter(
  (op) => !isVerifiable(op),
);

/** Only operations that CAN be verified compliant (both preconditions `true`). */
const verifiableOperationArb: fc.Arbitrary<ComplianceOperation> = fc.record({
  kind: kindArb,
  organizationId: orgIdArb,
  resourceKind: fc.option(fc.constantFrom(...RETENTION_RESOURCE_KINDS), { nil: undefined }),
  resourceId: fc.option(resourceIdArb, { nil: undefined }),
  retentionVerified: fc.constant<boolean>(true),
  privacyVerified: fc.constant<boolean>(true),
});

// ---------------------------------------------------------------------------
// Manager harness: the REAL ComplianceManager over deterministic in-memory fakes.
// ---------------------------------------------------------------------------

interface Harness {
  manager: ComplianceManager;
  audit: CapturingAuditRecorder;
}

/** Build a real {@link ComplianceManager} wired to fresh in-memory fakes. */
function makeManager(): Harness {
  const audit = new CapturingAuditRecorder();
  const manager = new ComplianceManager({
    policies: new InMemoryRetentionPolicyStore(),
    holds: new InMemoryLegalHoldStore(),
    audit,
    clock: new MutableComplianceClock(),
  });
  return { manager, audit };
}

/** A {@link TenantContext} scoped to the operation's Organization. */
function tenantFor(op: ComplianceOperation): TenantContext {
  return { organizationId: op.organizationId, userId: 'user-1' };
}

// ---------------------------------------------------------------------------
// Property 55.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 55: Fail-closed compliance blocks unverifiable operations', () => {
  it('decideCompliance allows an operation iff retention AND privacy are verified, else blocks fail-closed with the expected denial code — never allow-by-default (Validates: Requirements 38.6)', () => {
    fc.assert(
      fc.property(operationArb, (op) => {
        const decision = decideCompliance(op);
        const expected = expectedVerdict(op);

        // The core biconditional: allowed IFF both preconditions are verified.
        expect(decision.allowed).toBe(isVerifiable(op));
        expect(decision.allowed).toBe(expected.allowed);

        if (expected.allowed) {
          // An allow carries no fail-closed reason.
          expect(decision.denialCode).toBeUndefined();
        } else {
          // Fail-closed: the verdict blocks and names the exact reason.
          expect(decision.allowed).toBe(false);
          expect(decision.denialCode).toBe(expected.denialCode);
          expect(typeof decision.reason).toBe('string');
          expect(decision.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('blocks EVERY unverifiable operation and records exactly one compliance.blocked audit event carrying the blocked operation details + denial code (Validates: Requirements 38.6)', async () => {
    await fc.assert(
      fc.asyncProperty(unverifiableOperationArb, async (op) => {
        const { manager, audit } = makeManager();
        const ctx = tenantFor(op);
        const expected = expectedVerdict(op);

        // Fail-closed: the manager blocks the operation rather than allowing it.
        const decision = await manager.verifyCompliance(ctx, op);
        expect(decision.allowed).toBe(false);
        expect(decision.denialCode).toBe(expected.denialCode);

        // The blocked operation is recorded in the Audit_Service — exactly once.
        const blocked = audit.withAction('compliance.blocked');
        expect(blocked).toHaveLength(1);

        const recorded = blocked[0];
        expect(recorded).toBeDefined();
        if (recorded === undefined) return; // narrows for TS

        // Scoped to the operation's Organization.
        expect(recorded.ctx.organizationId).toBe(op.organizationId);
        // The blocked operation's details: its kind, and its resource id (falling
        // back to the kind when the operation targets no specific resource).
        expect(recorded.event.resourceId).toBe(op.resourceId ?? op.kind);
        expect(recorded.event.metadata?.operationKind).toBe(op.kind);
        // The fail-closed denial code travels with the record.
        expect(recorded.event.metadata?.denialCode).toBe(decision.denialCode);
        expect(recorded.event.metadata?.reason).toBe(decision.reason);

        // verifyOrThrow fails closed with a typed block carrying the same reason,
        // and audits a second block (one per verification attempt).
        await expect(manager.verifyOrThrow(ctx, op)).rejects.toBeInstanceOf(ComplianceBlockedError);
        const blockedError = await manager.verifyOrThrow(ctx, op).then(
          () => undefined,
          (e: unknown) => e as ComplianceBlockedError,
        );
        expect(blockedError).toBeInstanceOf(ComplianceBlockedError);
        expect(blockedError?.code).toBe(decision.denialCode);
        expect(blockedError?.decision.allowed).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('control: an operation whose retention AND privacy compliance ARE verified is allowed and is NOT spuriously blocked or audited (Validates: Requirements 38.6)', async () => {
    await fc.assert(
      fc.asyncProperty(verifiableOperationArb, async (op) => {
        const { manager, audit } = makeManager();
        const ctx = tenantFor(op);

        const decision = await manager.verifyCompliance(ctx, op);

        // Verifiable: allowed, with no fail-closed reason.
        expect(decision.allowed).toBe(true);
        expect(decision.denialCode).toBeUndefined();

        // Not spuriously blocked: nothing is recorded as a compliance block.
        expect(audit.withAction('compliance.blocked')).toHaveLength(0);
        expect(audit.count).toBe(0);

        // verifyOrThrow returns the allow decision rather than throwing.
        const viaThrow = await manager.verifyOrThrow(ctx, op);
        expect(viaThrow.allowed).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
