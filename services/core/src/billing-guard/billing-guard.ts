/**
 * Billing_Guard — the credit-only billing governance gate (Req 43.1, 43.2,
 * 43.3, 43.4, 43.5).
 *
 * The Billing_Guard is the governance control consulted before the platform
 * adopts any billable dependency — an AI model billed via Bedrock/Azure AI
 * Foundry (Req 43.1), a web-search provider adapter (Req 43.2), or any hosting,
 * storage, database, cache, or networking service (Req 43.3). It composes the
 * platform's fail-closed policy into a single verdict: adoption proceeds *only*
 * when the dependency is billable through AWS or Azure credits and that billing
 * compliance can be verified, or when an owner has granted explicit approval;
 * otherwise it blocks (and audits), flagging the dependency for owner approval
 * when no credit-billable option exists at all (Property 45).
 *
 * ## Fail-closed decision model
 *
 * `verify` reads the dependency's {@link BillingComplianceStatus} from the
 * injected {@link BillingStatusProvider} port and applies these rules in order;
 * the first matching rule decides:
 *
 *   1. **Status unavailable (Req 43.5).** If the status cannot be obtained (the
 *      port is unavailable or throws), the guard fails closed: it blocks with
 *      `verification_unavailable` rather than assuming compliance. A billing
 *      check that cannot run is treated exactly like a failed one.
 *   2. **Owner-approved (Req 43.4, 43.5).** An explicit owner approval admits
 *      the dependency regardless of credit-billability or verifiability — the
 *      owner has accepted the spend. Adoption proceeds.
 *   3. **No credit-billable option (Req 43.4).** If no AWS/Azure credit-billable
 *      option exists, the dependency is blocked and *flagged for explicit owner
 *      approval*; it remains blocked until an owner approves.
 *   4. **Unverifiable compliance (Req 43.5).** A credit-billable option exists
 *      but its billing compliance cannot be verified — the dependency is blocked
 *      until compliance is verified or an owner approves. It is *not* flagged for
 *      owner approval (a credit-billable option does exist), distinguishing it
 *      from rule 3.
 *   5. **Verified credit-billable (Req 43.1-43.3).** The dependency is
 *      credit-billable and verifiable — adoption proceeds, naming the credit
 *      source that pays for it.
 *
 * Because every rule except the last can only block, the model is fail-closed by
 * construction: a dependency defaults to blocked unless it is positively
 * verified credit-billable or explicitly owner-approved (Property 45). Both
 * blocks are terminal for the adoption — there is no implicit fallback to a
 * non-credit path.
 *
 * ## Auditing every block (Req 37.1)
 *
 * Every block — at any rule — is recorded through the injected
 * {@link AuditRecorder} port as a `billing.blocked` event scoped to the adopting
 * Organization, carrying the dependency id/category, the fail-closed reason, and
 * whether it was flagged for owner approval. Allowed adoptions record nothing,
 * mirroring Access_Control's audit-on-deny contract (Property 3).
 *
 * ## Dependency injection
 *
 * The billing-compliance registry and the Audit_Service are injected via the
 * constructor as the narrow {@link BillingStatusProvider} and
 * {@link AuditRecorder} ports, so production wires the real registry and
 * {@link import('../audit/index.js').AuditService} while tests substitute fakes.
 * The guard never imports the concurrently-built Budget_Manager (task 19.4): it
 * depends only on its own narrow status port.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import { BillingBlockedError } from './errors.js';
import type {
  BillableDependency,
  BillingComplianceStatus,
  BillingDecision,
  BillingDenialCode,
  VerifyOptions,
} from './types.js';

/**
 * The narrow billing-compliance port the Billing_Guard depends on (Req 43.1-43.5).
 *
 * Production wires a provider backed by the billing-compliance registry; tests
 * pass a fake. Keeping the dependency as a one-method port (rather than a
 * concrete class — and explicitly *not* the concurrently-built Budget_Manager)
 * inverts the dependency so the guard can be unit- and property-tested without
 * any external service. An implementation that cannot determine a dependency's
 * status MUST signal that — by returning `undefined` or by throwing — so the
 * guard can fail closed (Req 43.5); it must never fabricate a compliant status.
 */
export interface BillingStatusProvider {
  /**
   * Resolve the {@link BillingComplianceStatus} for `dependency`, or `undefined`
   * when the status cannot be determined. May reject; the guard treats a
   * rejection identically to an undetermined status and fails closed.
   */
  getStatus(dependency: BillableDependency): Promise<BillingComplianceStatus | undefined>;
}

/** Construction dependencies for {@link BillingGuard} (all injected). */
export interface BillingGuardOptions {
  /** The billing-compliance registry port (or a fake) reporting per-dependency status (Req 43.1-43.5). */
  statusProvider: BillingStatusProvider;
  /** The Audit_Service (or a fake) recording every block (Req 37.1). */
  auditRecorder: AuditRecorder;
}

/** Build a blocked {@link BillingDecision}. */
function block(
  denialCode: BillingDenialCode,
  reason: string,
  flaggedForOwnerApproval: boolean,
): BillingDecision {
  return { allowed: false, reason, denialCode, flaggedForOwnerApproval };
}

/**
 * Decide adoption purely from a dependency's compliance status (Req 43.1-43.5)
 * — pure and side-effect-free.
 *
 * Applies the fail-closed decision model: an `undefined` status blocks with
 * `verification_unavailable`; an explicit owner approval allows; a missing
 * credit-billable option blocks and flags for owner approval; an unverifiable
 * credit-billable option blocks without flagging; and a verified credit-billable
 * dependency is allowed. Exposed separately from {@link BillingGuard} so the
 * decision logic is directly testable without the audit side effect.
 *
 * @param status The dependency's compliance status, or `undefined` when it could not be obtained.
 * @returns The structured {@link BillingDecision}.
 */
export function decideBilling(status: BillingComplianceStatus | undefined): BillingDecision {
  // Rule 1 — status unavailable: fail closed (Req 43.5).
  if (status === undefined) {
    return block(
      'verification_unavailable',
      'billing compliance status could not be determined; failing closed',
      false,
    );
  }

  // Rule 2 — explicit owner approval admits the dependency (Req 43.4, 43.5).
  if (status.ownerApproved === true) {
    const decision: BillingDecision = {
      allowed: true,
      reason: 'adoption allowed: explicit owner approval granted',
      flaggedForOwnerApproval: false,
    };
    if (status.creditProvider !== undefined) {
      decision.creditProvider = status.creditProvider;
    }
    return decision;
  }

  // Rule 3 — no credit-billable option: block and flag for owner approval (Req 43.4).
  if (!status.creditBillable) {
    return block(
      'no_credit_billable_option',
      'no AWS or Azure credit-billable option exists; flagged for explicit owner approval before adoption',
      true,
    );
  }

  // Rule 4 — credit-billable but unverifiable: block until verified/approved (Req 43.5).
  if (!status.verifiable) {
    return block(
      'unverifiable',
      'credit-billing compliance cannot be verified; adoption blocked until verified or owner-approved',
      false,
    );
  }

  // Rule 5 — verified credit-billable: allow (Req 43.1-43.3).
  const decision: BillingDecision = {
    allowed: true,
    reason: 'adoption allowed: dependency is credit-billable and verified',
    flaggedForOwnerApproval: false,
  };
  if (status.creditProvider !== undefined) {
    decision.creditProvider = status.creditProvider;
  }
  return decision;
}

/**
 * Billing_Guard. Construct once with the billing-status and Audit_Service ports,
 * then call {@link verify} (non-throwing) or {@link verifyOrThrow}
 * (adoption-path convenience) before adopting any billable dependency.
 */
export class BillingGuard {
  private readonly statusProvider: BillingStatusProvider;
  private readonly auditRecorder: AuditRecorder;

  constructor(options: BillingGuardOptions) {
    this.statusProvider = options.statusProvider;
    this.auditRecorder = options.auditRecorder;
  }

  /**
   * Verify whether `dependency` may be adopted, returning the structured verdict
   * and recording every block (Req 43.1-43.5).
   *
   * The decision is fail-closed: it is `allowed: true` only when the dependency
   * is verified credit-billable or explicitly owner-approved. A status that
   * cannot be obtained — because the port is unavailable or throws — blocks with
   * `verification_unavailable` rather than assuming compliance. Any block records
   * a `billing.blocked` audit event in the adopting Organization before
   * returning.
   *
   * @param dependency The billable dependency whose adoption is being gated.
   * @param options Optional request metadata copied into the audit record on a block.
   * @returns The {@link BillingDecision}; blocks are audited as a side effect.
   */
  async verify(
    dependency: BillableDependency,
    options: VerifyOptions = {},
  ): Promise<BillingDecision> {
    const status = await this.resolveStatus(dependency);
    const decision = decideBilling(status);
    if (!decision.allowed) {
      await this.recordBlock(dependency, decision, options);
    }
    return decision;
  }

  /**
   * Like {@link verify}, but throws {@link BillingBlockedError} on a block (after
   * the block is audited) and resolves to the allow {@link BillingDecision}
   * otherwise. Adoption-path callers use this to fail closed with a single throw
   * site while retaining the full decision on the error.
   */
  async verifyOrThrow(
    dependency: BillableDependency,
    options: VerifyOptions = {},
  ): Promise<BillingDecision> {
    const decision = await this.verify(dependency, options);
    if (!decision.allowed) {
      throw new BillingBlockedError(dependency.id, decision);
    }
    return decision;
  }

  /**
   * Read the dependency's status from the injected port, failing closed to
   * `undefined` if the port throws (Req 43.5). A billing check that cannot run is
   * treated identically to an undetermined status, so a throwing port never
   * leaks an exception into the adoption path.
   */
  private async resolveStatus(
    dependency: BillableDependency,
  ): Promise<BillingComplianceStatus | undefined> {
    try {
      return await this.statusProvider.getStatus(dependency);
    } catch {
      return undefined;
    }
  }

  /**
   * Record a `billing.blocked` audit event for a block and return nothing
   * (Req 37.1). The event is scoped to the adopting Organization; its metadata
   * carries the dependency category, the fail-closed reason, and whether the
   * dependency was flagged for owner approval.
   */
  private async recordBlock(
    dependency: BillableDependency,
    decision: BillingDecision,
    options: VerifyOptions,
  ): Promise<void> {
    const ctx: TenantContext = {
      organizationId: dependency.organizationId,
      userId: 'system',
    };
    await this.auditRecorder.record(ctx, {
      action: 'billing.blocked',
      resourceType: 'billable_dependency',
      resourceId: dependency.id,
      ip: options.ip,
      userAgent: options.userAgent,
      metadata: {
        dependencyCategory: dependency.category,
        denialCode: decision.denialCode,
        reason: decision.reason,
        flaggedForOwnerApproval: decision.flaggedForOwnerApproval,
      },
    });
  }
}
