/**
 * Unit tests for the Billing_Guard (Req 43.1, 43.2, 43.3, 43.4, 43.5).
 *
 * These exercise the full fail-closed decision model through {@link BillingGuard}:
 *   - a verified AWS/Azure credit-billable dependency is allowed and audits
 *     nothing (Req 43.1, 43.2, 43.3);
 *   - a dependency with no credit-billable option is blocked, flagged for owner
 *     approval, and audited (Req 43.4);
 *   - a credit-billable but unverifiable dependency is blocked (not flagged) and
 *     audited until verified/approved (Req 43.5);
 *   - an explicit owner approval admits an otherwise-blocked dependency
 *     (Req 43.4, 43.5);
 *   - a status that cannot be obtained — port returns `undefined` or throws —
 *     fails closed with `verification_unavailable` and is audited (Req 43.5);
 *   - blocks are scoped to the adopting Organization (tenant scoping, Req 37.1);
 *   - `verifyOrThrow` raises a typed {@link BillingBlockedError} projecting to a
 *     `billing_blocked` PlatformError; and
 *   - every block — at any rule — is audited exactly once, allows audit nothing.
 */

import { describe, expect, it } from 'vitest';

import { BillingGuard, decideBilling } from './billing-guard.js';
import { BILLING_BLOCKED_CODE, BillingBlockedError } from './errors.js';
import {
  CapturingAuditRecorder,
  FakeBillingStatusProvider,
  makeDependency,
} from './fakes.js';
import type { BillingComplianceStatus } from './types.js';

/** Build a Billing_Guard over the given statuses + a capturing audit recorder. */
function makeGuard(
  statuses: Record<string, BillingComplianceStatus> = {},
  throwError?: Error,
): {
  guard: BillingGuard;
  audit: CapturingAuditRecorder;
  statusProvider: FakeBillingStatusProvider;
} {
  const audit = new CapturingAuditRecorder();
  const statusProvider = new FakeBillingStatusProvider(statuses, throwError);
  const guard = new BillingGuard({ statusProvider, auditRecorder: audit });
  return { guard, audit, statusProvider };
}

// ---------------------------------------------------------------------------
// Rule 5 — verified credit-billable: allow (Req 43.1, 43.2, 43.3)
// ---------------------------------------------------------------------------

describe('BillingGuard — verified credit-billable adoption is allowed (Req 43.1-43.3)', () => {
  it('allows an AWS-credit-billable, verifiable AI model and audits nothing', async () => {
    const { guard, audit } = makeGuard({
      'bedrock-anthropic': { creditBillable: true, creditProvider: 'aws', verifiable: true },
    });
    const decision = await guard.verify(
      makeDependency({ id: 'bedrock-anthropic', category: 'ai_model' }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.creditProvider).toBe('aws');
    expect(decision.flaggedForOwnerApproval).toBe(false);
    expect(decision.denialCode).toBeUndefined();
    expect(audit.count).toBe(0);
  });

  it('allows an Azure-credit-billable, verifiable web-search provider', async () => {
    const { guard, audit } = makeGuard({
      'azure-search': { creditBillable: true, creditProvider: 'azure', verifiable: true },
    });
    const decision = await guard.verify(
      makeDependency({ id: 'azure-search', category: 'web_search' }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.creditProvider).toBe('azure');
    expect(audit.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — no credit-billable option: block + flag for owner approval (Req 43.4)
// ---------------------------------------------------------------------------

describe('BillingGuard — no credit-billable option (Req 43.4)', () => {
  it('blocks, flags for owner approval, and audits when no credit-billable option exists', async () => {
    const { guard, audit } = makeGuard({
      'exotic-gpu': { creditBillable: false, verifiable: false },
    });
    const dependency = makeDependency({ id: 'exotic-gpu', category: 'hosting' });
    const decision = await guard.verify(dependency);

    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('no_credit_billable_option');
    expect(decision.flaggedForOwnerApproval).toBe(true);

    expect(audit.count).toBe(1);
    const { ctx, event } = audit.recorded[0]!;
    expect(ctx.organizationId).toBe('org-1');
    expect(event.action).toBe('billing.blocked');
    expect(event.resourceId).toBe('exotic-gpu');
    expect(event.metadata).toMatchObject({
      dependencyCategory: 'hosting',
      denialCode: 'no_credit_billable_option',
      flaggedForOwnerApproval: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — credit-billable but unverifiable: block (not flagged) (Req 43.5)
// ---------------------------------------------------------------------------

describe('BillingGuard — credit-billable but unverifiable (Req 43.5)', () => {
  it('blocks without flagging for owner approval and audits the block', async () => {
    const { guard, audit } = makeGuard({
      'maybe-billable': { creditBillable: true, creditProvider: 'aws', verifiable: false },
    });
    const decision = await guard.verify(makeDependency({ id: 'maybe-billable' }));

    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('unverifiable');
    expect(decision.flaggedForOwnerApproval).toBe(false);
    expect(audit.count).toBe(1);
    expect(audit.recorded[0]!.event.metadata).toMatchObject({ denialCode: 'unverifiable' });
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — explicit owner approval admits the dependency (Req 43.4, 43.5)
// ---------------------------------------------------------------------------

describe('BillingGuard — explicit owner approval (Req 43.4, 43.5)', () => {
  it('allows a non-credit-billable dependency when an owner has approved it', async () => {
    const { guard, audit } = makeGuard({
      'approved-dep': { creditBillable: false, verifiable: false, ownerApproved: true },
    });
    const decision = await guard.verify(makeDependency({ id: 'approved-dep' }));
    expect(decision.allowed).toBe(true);
    expect(decision.flaggedForOwnerApproval).toBe(false);
    expect(audit.count).toBe(0);
  });

  it('allows an unverifiable credit-billable dependency when an owner has approved it', async () => {
    const { guard } = makeGuard({
      'approved-dep': {
        creditBillable: true,
        creditProvider: 'azure',
        verifiable: false,
        ownerApproved: true,
      },
    });
    const decision = await guard.verify(makeDependency({ id: 'approved-dep' }));
    expect(decision.allowed).toBe(true);
    expect(decision.creditProvider).toBe('azure');
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — status unavailable: fail closed (Req 43.5)
// ---------------------------------------------------------------------------

describe('BillingGuard — fail-closed when status is unavailable (Req 43.5)', () => {
  it('blocks with verification_unavailable when no status exists for the dependency', async () => {
    const { guard, audit } = makeGuard(); // empty registry → undefined status
    const decision = await guard.verify(makeDependency({ id: 'unknown-dep' }));
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('verification_unavailable');
    expect(decision.flaggedForOwnerApproval).toBe(false);
    expect(audit.count).toBe(1);
    expect(audit.recorded[0]!.event.metadata).toMatchObject({
      denialCode: 'verification_unavailable',
    });
  });

  it('blocks with verification_unavailable when the status provider throws (registry unavailable)', async () => {
    const { guard, audit } = makeGuard({}, new Error('registry down'));
    const decision = await guard.verify(makeDependency({ id: 'any-dep' }));
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('verification_unavailable');
    // The thrown cause never leaks into the verdict reason.
    expect(decision.reason).not.toContain('registry down');
    expect(audit.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant scoping of the audit record (Req 37.1)
// ---------------------------------------------------------------------------

describe('BillingGuard — block audit is scoped to the adopting Organization (Req 37.1)', () => {
  it('records the block in the dependency\u2019s owning Organization', async () => {
    const { guard, audit } = makeGuard({
      'dep-x': { creditBillable: false, verifiable: false },
    });
    await guard.verify(makeDependency({ id: 'dep-x', organizationId: 'org-42' }));
    expect(audit.count).toBe(1);
    expect(audit.recorded[0]!.ctx.organizationId).toBe('org-42');
  });

  it('copies request ip/user-agent metadata into the block record', async () => {
    const { guard, audit } = makeGuard({
      'dep-x': { creditBillable: false, verifiable: false },
    });
    await guard.verify(makeDependency({ id: 'dep-x' }), {
      ip: '203.0.113.7',
      userAgent: 'adoption-cli/1.0',
    });
    const { event } = audit.recorded[0]!;
    expect(event.ip).toBe('203.0.113.7');
    expect(event.userAgent).toBe('adoption-cli/1.0');
  });
});

// ---------------------------------------------------------------------------
// verifyOrThrow + typed-error projection (Req 43.5, 46.8)
// ---------------------------------------------------------------------------

describe('BillingGuard.verifyOrThrow', () => {
  it('returns the allow decision when adoption is permitted', async () => {
    const { guard } = makeGuard({
      'ok-dep': { creditBillable: true, creditProvider: 'aws', verifiable: true },
    });
    const decision = await guard.verifyOrThrow(makeDependency({ id: 'ok-dep' }));
    expect(decision.allowed).toBe(true);
  });

  it('throws BillingBlockedError carrying the decision, code, and dependency id on a block', async () => {
    const { guard, audit } = makeGuard({
      'blocked-dep': { creditBillable: false, verifiable: false },
    });
    await expect(
      guard.verifyOrThrow(makeDependency({ id: 'blocked-dep' })),
    ).rejects.toBeInstanceOf(BillingBlockedError);
    // The block was audited exactly once before throwing.
    expect(audit.count).toBe(1);

    try {
      await guard.verifyOrThrow(makeDependency({ id: 'blocked-dep' }));
    } catch (error) {
      const blocked = error as BillingBlockedError;
      expect(blocked.code).toBe('no_credit_billable_option');
      expect(blocked.dependencyId).toBe('blocked-dep');
      expect(blocked.decision.allowed).toBe(false);
    }
  });

  it('projects the block into a billing_blocked PlatformError with secret-free details', async () => {
    const decision = decideBilling({ creditBillable: false, verifiable: false });
    const error = new BillingBlockedError('blocked-dep', decision);
    const platform = error.toPlatformError('corr-123');
    expect(platform.category).toBe('billing_blocked');
    expect(platform.code).toBe(BILLING_BLOCKED_CODE);
    expect(platform.correlationId).toBe('corr-123');
    expect(platform.retriable).toBe(false);
    expect(platform.details).toEqual({
      dependencyId: 'blocked-dep',
      denialCode: 'no_credit_billable_option',
      flaggedForOwnerApproval: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Audit cardinality: every block audited once, allows audit nothing
// ---------------------------------------------------------------------------

describe('BillingGuard — every block is audited exactly once', () => {
  it('records exactly one billing.blocked event per blocked verify, none for allows', async () => {
    const { guard, audit } = makeGuard({
      allow: { creditBillable: true, creditProvider: 'aws', verifiable: true },
      flag: { creditBillable: false, verifiable: false },
      unverifiable: { creditBillable: true, creditProvider: 'azure', verifiable: false },
      // `unknown` intentionally absent → verification_unavailable
    });

    await guard.verify(makeDependency({ id: 'allow' })); // allow
    await guard.verify(makeDependency({ id: 'flag' })); // block (no credit option)
    await guard.verify(makeDependency({ id: 'unverifiable' })); // block (unverifiable)
    await guard.verify(makeDependency({ id: 'unknown' })); // block (unavailable)

    const blocks = audit.withAction('billing.blocked');
    expect(blocks).toHaveLength(3);
    expect(audit.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// decideBilling — the pure decision core
// ---------------------------------------------------------------------------

describe('decideBilling — pure decision core (Req 43.1-43.5)', () => {
  it('blocks an undefined status with verification_unavailable', () => {
    expect(decideBilling(undefined)).toMatchObject({
      allowed: false,
      denialCode: 'verification_unavailable',
      flaggedForOwnerApproval: false,
    });
  });

  it('allows owner-approved over any other rule', () => {
    expect(
      decideBilling({ creditBillable: false, verifiable: false, ownerApproved: true }),
    ).toMatchObject({ allowed: true, flaggedForOwnerApproval: false });
  });

  it('flags a non-credit-billable dependency for owner approval', () => {
    expect(decideBilling({ creditBillable: false, verifiable: true })).toMatchObject({
      allowed: false,
      denialCode: 'no_credit_billable_option',
      flaggedForOwnerApproval: true,
    });
  });

  it('blocks a credit-billable-but-unverifiable dependency without flagging', () => {
    expect(
      decideBilling({ creditBillable: true, creditProvider: 'aws', verifiable: false }),
    ).toMatchObject({
      allowed: false,
      denialCode: 'unverifiable',
      flaggedForOwnerApproval: false,
    });
  });

  it('allows a verified credit-billable dependency and carries the credit provider', () => {
    expect(
      decideBilling({ creditBillable: true, creditProvider: 'azure', verifiable: true }),
    ).toMatchObject({ allowed: true, creditProvider: 'azure', flaggedForOwnerApproval: false });
  });
});
