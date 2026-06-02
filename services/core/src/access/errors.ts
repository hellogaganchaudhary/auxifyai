/**
 * Access_Control errors (Req 1.3, 1.7, 19.4, 19.5, 19.6).
 *
 * {@link AccessDeniedError} is the typed denial that {@link
 * import('./access-control.js').AccessControl.authorizeOrThrow} raises when a
 * request is refused. It carries the structured {@link AuthzDecision} so a
 * caller catching it can inspect the denial stage (`denialCode`) and reason
 * without re-deriving them — the same verdict that the non-throwing
 * `authorize` returns. Keeping the denial as an error (rather than only a
 * return value) lets request-path callers fail closed with a single `throw`
 * site while preserving the full decision for logging.
 */

import type { AuthzDecision, AuthzDenialCode } from './types.js';

/**
 * Thrown by `authorizeOrThrow` when authorization is denied.
 *
 * The original {@link AuthzDecision} is attached as {@link decision} (and its
 * {@link AuthzDenialCode} surfaced as {@link code}) so callers can branch on the
 * exact fail-closed stage that refused the request.
 */
export class AccessDeniedError extends Error {
  /** The structured denial verdict, including the deciding policy decision when present. */
  readonly decision: AuthzDecision;
  /** The fail-closed stage that produced the denial, for convenient branching. */
  readonly code: AuthzDenialCode | undefined;

  constructor(decision: AuthzDecision) {
    super(decision.reason);
    this.name = 'AccessDeniedError';
    this.decision = decision;
    this.code = decision.denialCode;
  }
}
