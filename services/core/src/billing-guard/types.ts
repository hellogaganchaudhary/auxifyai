/**
 * Domain types for the Billing_Guard (Req 43.1, 43.2, 43.3, 43.4, 43.5).
 *
 * The Billing_Guard is the governance gate that decides whether the platform
 * may adopt a billable dependency. Adoption proceeds only when the dependency
 * is billable through AWS or Azure credits and that billing compliance can be
 * verified, or when an owner has granted explicit approval; otherwise the guard
 * blocks adoption — flagging the dependency for owner approval when no
 * credit-billable option exists at all (Property 45). These types describe the
 * inputs and outputs of {@link import('./billing-guard.js').BillingGuard.verify}:
 *
 *   - {@link BillableDependency} — the service whose adoption is being gated.
 *   - {@link BillingComplianceStatus} — the facts the injectable
 *     compliance port reports for a dependency: whether it is credit-billable,
 *     which credit source bills it, whether compliance is verifiable, and
 *     whether an owner has already approved it.
 *   - {@link BillingDecision} — the returned verdict, a structured
 *     allow/block that callers can inspect, mirroring Access_Control's
 *     {@link import('../access/index.js').AuthzDecision}.
 *   - {@link BillingDenialCode} — the fail-closed reason a block came from, so
 *     callers and the audit record can distinguish a missing credit-billable
 *     option from an unverifiable one from a status that could not be obtained.
 */

/**
 * The credit source that pays for a billable dependency (Req 43.1, 43.2, 43.3).
 *
 * Every billable dependency the platform adopts must be paid through one of
 * these — AWS Credits or Microsoft Azure Credits — so the platform incurs zero
 * unauthorized spend.
 */
export type CreditProvider = 'aws' | 'azure';

/** All {@link CreditProvider} values, for iteration, validation, and test generators. */
export const CREDIT_PROVIDERS: readonly CreditProvider[] = ['aws', 'azure'] as const;

/**
 * The kind of billable dependency being gated, aligned to the requirement that
 * introduces it:
 *   - `ai_model` — AI model billing via AWS Bedrock or Azure AI Foundry (Req 43.1).
 *   - `web_search` — web search billing via a credit-billable provider adapter (Req 43.2).
 *   - `hosting` / `storage` / `database` / `cache` / `networking` — platform
 *     infrastructure provisioned on AWS or Azure credits (Req 43.3).
 *   - `other` — any further billable capability the platform may adopt.
 */
export type DependencyCategory =
  | 'ai_model'
  | 'web_search'
  | 'hosting'
  | 'storage'
  | 'database'
  | 'cache'
  | 'networking'
  | 'other';

/** All {@link DependencyCategory} values, for iteration, validation, and test generators. */
export const DEPENDENCY_CATEGORIES: readonly DependencyCategory[] = [
  'ai_model',
  'web_search',
  'hosting',
  'storage',
  'database',
  'cache',
  'networking',
  'other',
] as const;

/**
 * A billable dependency the platform may adopt — the subject of a Billing_Guard
 * decision (Req 43.1-43.5).
 *
 * The owning `organizationId` ties the adoption decision (and its audit record)
 * to the tenant that initiated it, so a blocked attempt is logged in the
 * adopting Organization's trail.
 */
export interface BillableDependency {
  /** The dependency's stable, human-meaningful id, e.g. `bedrock-anthropic`. */
  id: string;
  /** A human-readable name for the dependency. */
  name: string;
  /** The kind of billable capability, aligned to Req 43.1-43.3. */
  category: DependencyCategory;
  /** The Organization adopting the dependency, used to scope the audit record. */
  organizationId: string;
  /** Optional free-form description of the capability the dependency provides. */
  description?: string;
}

/**
 * The billing-compliance facts the injectable compliance port reports for a
 * {@link BillableDependency} (Req 43.1-43.5).
 *
 * This is the single source of truth the Billing_Guard consults; it never reads
 * the underlying registry itself. `creditBillable` answers whether *any*
 * AWS/Azure credit-billable option exists for the capability (Req 43.4);
 * `verifiable` answers whether that billing compliance can actually be verified
 * (Req 43.5); `ownerApproved` records whether an owner has granted explicit
 * approval to adopt the dependency regardless (Req 43.4, 43.5).
 */
export interface BillingComplianceStatus {
  /** Whether the dependency can be billed through AWS or Azure credits (Req 43.1-43.4). */
  creditBillable: boolean;
  /** Which credit source bills it, present when {@link creditBillable} is `true`. */
  creditProvider?: CreditProvider;
  /** Whether the dependency's billing compliance can be verified (Req 43.5). */
  verifiable: boolean;
  /** Whether an owner has granted explicit approval to adopt the dependency (Req 43.4, 43.5). */
  ownerApproved?: boolean;
}

/**
 * The fail-closed reason a {@link BillingDecision} blocked adoption.
 *
 * Each value maps to a requirement so a caller (and the audit record) can tell
 * the blocks apart:
 *   - `no_credit_billable_option` — no AWS/Azure credit-billable option exists
 *     for the capability; the dependency is flagged for explicit owner approval
 *     and remains blocked until approved (Req 43.4).
 *   - `unverifiable` — a credit-billable option exists but its billing
 *     compliance cannot be verified; adoption is blocked until compliance is
 *     verified or an owner approves (Req 43.5).
 *   - `verification_unavailable` — the compliance status itself could not be
 *     obtained (the port was unavailable or errored); the guard fails closed and
 *     blocks rather than assuming compliance (Req 43.5).
 */
export type BillingDenialCode =
  | 'no_credit_billable_option'
  | 'unverifiable'
  | 'verification_unavailable';

/**
 * The verdict returned by {@link import('./billing-guard.js').BillingGuard.verify}.
 *
 * `allowed` is `true` only when the dependency is credit-billable *and*
 * verifiable, or an owner has explicitly approved it; in every other case it is
 * `false` and `denialCode` names the fail-closed reason. `reason` is a
 * human-readable explanation suitable for logs and audit metadata.
 * `flaggedForOwnerApproval` is `true` only when no credit-billable option exists
 * (Req 43.4), signalling that an owner must approve before adoption can proceed.
 * `creditProvider` is attached when adoption is allowed on a credit-billable
 * basis, naming the credit source that pays for it.
 */
export interface BillingDecision {
  /** Whether adoption may proceed. Fail-closed: `false` unless verified-credit-billable or owner-approved. */
  allowed: boolean;
  /** A human-readable explanation of the verdict. */
  reason: string;
  /** The fail-closed reason for a block, present only when `allowed` is `false`. */
  denialCode?: BillingDenialCode;
  /** Whether the dependency is flagged for explicit owner approval (Req 43.4). */
  flaggedForOwnerApproval: boolean;
  /** The credit source paying for the dependency, present when allowed on a credit-billable basis. */
  creditProvider?: CreditProvider;
}

/**
 * Optional request metadata for a Billing_Guard decision.
 *
 * These fields are copied into the audit record on a block so an operator can
 * trace who attempted the adoption and from where (Req 37.1); they never affect
 * the verdict.
 */
export interface VerifyOptions {
  /** Originating IP address, recorded on a block (Req 37.1). */
  ip?: string;
  /** Originating user agent, recorded on a block (Req 37.1). */
  userAgent?: string;
}
