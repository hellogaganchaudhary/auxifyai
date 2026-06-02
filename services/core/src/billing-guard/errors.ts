/**
 * Billing_Guard typed error (Req 43.4, 43.5).
 *
 * {@link BillingBlockedError} is the typed block that
 * {@link import('./billing-guard.js').BillingGuard.verifyOrThrow} raises when
 * adoption of a billable dependency is refused. It carries the structured
 * {@link BillingDecision} so a caller catching it can inspect the block reason
 * (`denialCode`) and whether the dependency was flagged for owner approval
 * (`flaggedForOwnerApproval`) without re-deriving them — the same verdict that
 * the non-throwing `verify` returns. Keeping the block as an error (rather than
 * only a return value) lets adoption-path callers fail closed with a single
 * `throw` site while preserving the full decision for logging.
 *
 * It projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) under the `billing_blocked` category (HTTP 403, Req 43.5) so the
 * same wire shape crosses the REST_API, the WebSocket_Gateway, and the SDK, and
 * carries structured, secret-free `details` — never a provider credential
 * (Req 34.7).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { BillingDecision, BillingDenialCode } from './types.js';

/** The stable machine-readable code for a blocked dependency adoption (Req 43.5). */
export const BILLING_BLOCKED_CODE = 'BILLING_COMPLIANCE_BLOCKED' as const;

/**
 * Thrown by `verifyOrThrow` when a dependency's adoption is blocked (Req 43.4,
 * 43.5).
 *
 * The original {@link BillingDecision} is attached as {@link decision} (and its
 * {@link BillingDenialCode} surfaced as {@link code}) so callers can branch on
 * the exact fail-closed reason that refused the adoption. {@link dependencyId}
 * identifies the dependency that was blocked.
 */
export class BillingBlockedError extends Error {
  /** The structured block verdict, including the fail-closed reason. */
  readonly decision: BillingDecision;
  /** The fail-closed reason for the block, for convenient branching. */
  readonly code: BillingDenialCode | undefined;
  /** The id of the dependency whose adoption was blocked. */
  readonly dependencyId: string;

  constructor(dependencyId: string, decision: BillingDecision) {
    super(decision.reason);
    this.name = 'BillingBlockedError';
    this.dependencyId = dependencyId;
    this.decision = decision;
    this.code = decision.denialCode;
  }

  /**
   * Project this block into the platform-wide serializable error shape
   * (category `billing_blocked`, code {@link BILLING_BLOCKED_CODE}) (Req 43.5,
   * 46.8). Terminal for the operation — there is no implicit fallback to a
   * non-credit path — so it is not retriable by the category default. The
   * structured `details` carry only the blocked dependency id, the fail-closed
   * reason, and whether it was flagged for owner approval; never a credential.
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'billing_blocked',
      code: BILLING_BLOCKED_CODE,
      message: this.message,
      correlationId,
      details: {
        dependencyId: this.dependencyId,
        denialCode: this.code,
        flaggedForOwnerApproval: this.decision.flaggedForOwnerApproval,
      },
    });
  }
}
