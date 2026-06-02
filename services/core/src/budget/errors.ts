/**
 * Budget_Manager typed errors (Req 22.2-22.5).
 *
 * The Budget_Manager is mostly *non-throwing*: a cap reached is an ordinary
 * {@link import('./types.js').BudgetDecision} (`allowed: false`) the request
 * path branches on, never an exception, so the caller can log the verdict and
 * return the right {@link import('@auxify/types').PlatformError} category
 * (`quota_exceeded`) itself. Only *invalid configuration* — a budget that can
 * never behave sensibly — is a thrown, fail-closed error:
 *
 *  - {@link InvalidBudgetConfigError} — a non-finite/negative cap, an alert
 *    fraction outside `(0, 1]`, an unknown period, or a non-positive per-model
 *    daily limit (Req 22.2-22.5).
 *
 * It projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, carrying structured, secret-free `details`.
 *
 * A convenience {@link quotaExceededError} builds the `quota_exceeded`
 * {@link PlatformError} a request-path caller surfaces when a
 * {@link import('./types.js').BudgetDecision} blocks a request (Req 22.x), so
 * the mapping from a decision to the wire error lives in one place.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { BudgetDecision } from './types.js';

/** The stable machine-readable code for an invalid budget configuration (Req 22.2-22.5). */
export const INVALID_BUDGET_CONFIG_CODE = 'INVALID_BUDGET_CONFIG' as const;

/** The stable machine-readable code for a budget-cap-blocked request (Req 22.3-22.5). */
export const BUDGET_QUOTA_EXCEEDED_CODE = 'BUDGET_QUOTA_EXCEEDED' as const;

/**
 * Thrown when a budget configuration is structurally invalid and could never
 * behave sensibly (Req 22.2-22.5).
 *
 * `reason` explains the problem (e.g. a negative cap, an alert fraction outside
 * `(0, 1]`, or a non-positive per-model daily limit). Surfaced as `validation`.
 * A cap *reached* at runtime is never this error — it is an ordinary
 * {@link BudgetDecision}.
 */
export class InvalidBudgetConfigError extends Error {
  constructor(reason: string) {
    super(`Invalid budget configuration: ${reason}`);
    this.name = 'InvalidBudgetConfigError';
  }

  /**
   * Project into the platform-wide error shape (`validation`,
   * {@link INVALID_BUDGET_CONFIG_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_BUDGET_CONFIG_CODE,
      message: this.message,
      correlationId,
    });
  }
}

/**
 * Build the `quota_exceeded` {@link PlatformError} a request-path caller surfaces
 * when a {@link BudgetDecision} blocks or restricts a request (Req 22.3-22.5,
 * 46.8).
 *
 * The decision's {@link BudgetDecision.kind} and human-readable
 * {@link BudgetDecision.reason} are carried as structured, secret-free details so
 * the client can render exactly which cap applied without re-deriving it.
 *
 * @param decision The blocking decision (its {@link BudgetDecision.allowed} must be `false`).
 * @param correlationId Ties the error to logs/traces across services (Req 46.7).
 * @returns A `quota_exceeded` platform error describing the block.
 */
export function quotaExceededError(
  decision: BudgetDecision,
  correlationId: string,
): PlatformError {
  return createPlatformError({
    category: 'quota_exceeded',
    code: BUDGET_QUOTA_EXCEEDED_CODE,
    message: decision.reason,
    correlationId,
    details: {
      kind: decision.kind,
      scope: decision.scope,
    },
  });
}
