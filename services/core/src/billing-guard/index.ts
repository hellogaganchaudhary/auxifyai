/**
 * Billing_Guard (Req 43.1, 43.2, 43.3, 43.4, 43.5).
 *
 * The credit-only billing governance gate consulted before the platform adopts
 * any billable dependency — an AI model billed via Bedrock/Azure AI Foundry
 * (Req 43.1), a web-search provider adapter (Req 43.2), or any hosting, storage,
 * database, cache, or networking service (Req 43.3). It denies by default:
 * adoption proceeds only when the dependency is billable through AWS or Azure
 * credits and that billing compliance can be verified, or when an owner has
 * granted explicit approval; otherwise the guard blocks adoption — flagging the
 * dependency for owner approval when no credit-billable option exists at all
 * (Req 43.4, 43.5; Property 45). Every block is recorded through the injected
 * AuditRecorder port (Req 37.1), and both blocks are terminal — there is no
 * implicit fallback to a non-credit path.
 *
 * Surface:
 *   - {@link BillingGuard} — the gate; `verify(dependency, options?)` returns a
 *     structured {@link BillingDecision}, and `verifyOrThrow` throws
 *     {@link BillingBlockedError} on a block.
 *   - {@link BillingStatusProvider} / {@link BillingGuardOptions} — the injected
 *     billing-compliance port (explicitly NOT the Budget_Manager) and
 *     construction dependencies.
 *   - {@link decideBilling} — the pure, side-effect-free decision core,
 *     reusable and directly testable.
 *   - {@link BillingBlockedError} — the typed block raised by `verifyOrThrow`,
 *     projecting to a `billing_blocked` PlatformError.
 *   - {@link BillableDependency}, {@link BillingComplianceStatus},
 *     {@link BillingDecision}, {@link BillingDenialCode}, {@link CreditProvider},
 *     {@link DependencyCategory}, {@link VerifyOptions} — the domain types, with
 *     the {@link CREDIT_PROVIDERS} / {@link DEPENDENCY_CATEGORIES} value lists.
 */

export {
  BillingGuard,
  decideBilling,
  type BillingGuardOptions,
  type BillingStatusProvider,
} from './billing-guard.js';

export { BillingBlockedError, BILLING_BLOCKED_CODE } from './errors.js';

export {
  CREDIT_PROVIDERS,
  DEPENDENCY_CATEGORIES,
  type BillableDependency,
  type BillingComplianceStatus,
  type BillingDecision,
  type BillingDenialCode,
  type CreditProvider,
  type DependencyCategory,
  type VerifyOptions,
} from './types.js';
