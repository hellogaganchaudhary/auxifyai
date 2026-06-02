/**
 * Compliance_Manager typed errors (Req 38.1, 38.6).
 *
 * These make the manager's validation and fail-closed conditions explicit and
 * testable, and each projects into the platform-wide serializable
 * {@link PlatformError} shape (Req 46.8) so the same wire shape crosses the
 * REST_API, the WebSocket_Gateway, and the SDK, carrying structured, secret-free
 * `details`:
 *
 *   - {@link InvalidRetentionPolicyError} — a retention policy is structurally
 *     invalid (a finite period below the {@link MIN_RETENTION_DAYS} minimum, a
 *     non-integer/negative period, an unknown disposition, or a scope that
 *     crosses the caller's Organization) and could never behave sensibly
 *     (Req 38.1); surfaced as `validation`;
 *   - {@link LegalHoldNotFoundError} — a release targets a hold that does not
 *     exist within the caller's Organization; surfaced as `not_found`;
 *   - {@link ComplianceBlockedError} — the fail-closed block raised when an
 *     operation's retention/privacy compliance cannot be verified (Req 38.6);
 *     surfaced as `compliance_blocked` (HTTP 451). It carries the structured
 *     {@link ComplianceDecision} so a caller catching it can inspect the
 *     fail-closed reason without re-deriving it.
 *
 * A cap/condition that is an ordinary outcome (a resource simply being within
 * retention, or a verifiable operation being allowed) is never an error — only a
 * structurally-impossible configuration or an unverifiable operation throws.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { ComplianceDecision, ComplianceDenialCode } from './types.js';

/** Stable machine-readable code for an invalid retention policy (Req 38.1). */
export const INVALID_RETENTION_POLICY_CODE = 'INVALID_RETENTION_POLICY' as const;

/** Stable machine-readable code for a missing legal hold. */
export const LEGAL_HOLD_NOT_FOUND_CODE = 'LEGAL_HOLD_NOT_FOUND' as const;

/** Stable machine-readable code for a fail-closed compliance block (Req 38.6). */
export const COMPLIANCE_BLOCKED_CODE = 'COMPLIANCE_BLOCKED' as const;

/**
 * Thrown when a retention policy is structurally invalid and could never behave
 * sensibly (Req 38.1).
 *
 * `reason` explains the problem (e.g. a finite retention period below the
 * 30-day minimum, a non-integer period, or a scope in a different
 * Organization). Surfaced as `validation`.
 */
export class InvalidRetentionPolicyError extends Error {
  constructor(reason: string) {
    super(`Invalid retention policy: ${reason}`);
    this.name = 'InvalidRetentionPolicyError';
  }

  /**
   * Project into the platform-wide serializable error shape (`validation`,
   * {@link INVALID_RETENTION_POLICY_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_RETENTION_POLICY_CODE,
      message: this.message,
      correlationId,
    });
  }
}

/**
 * Thrown when releasing a legal hold that does not exist within the caller's
 * Organization (tenant scoping already prevents cross-tenant reads, so "not in
 * my tenant" surfaces as "not found").
 */
export class LegalHoldNotFoundError extends Error {
  /** The hold id that was looked up. */
  readonly holdId: string;

  constructor(holdId: string) {
    super(`Legal hold "${holdId}" was not found in the current organization`);
    this.name = 'LegalHoldNotFoundError';
    this.holdId = holdId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: LEGAL_HOLD_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { holdId: this.holdId },
    });
  }
}

/**
 * The fail-closed block raised when an operation's retention/privacy compliance
 * cannot be verified (Req 38.6).
 *
 * The original {@link ComplianceDecision} is attached as {@link decision} (and
 * its {@link ComplianceDenialCode} surfaced as {@link code}) so callers can
 * branch on the exact fail-closed reason. The block is recorded in the
 * Audit_Service before this is thrown (Req 38.6). It projects into the
 * platform-wide `compliance_blocked` category (HTTP 451, Req 38.6) — terminal
 * for the operation, there is no implicit fallback to a non-compliant path.
 */
export class ComplianceBlockedError extends Error {
  /** The structured block verdict, including the fail-closed reason. */
  readonly decision: ComplianceDecision;
  /** The fail-closed reason for the block, for convenient branching. */
  readonly code: ComplianceDenialCode | undefined;
  /** A label for the operation that was blocked. */
  readonly operationKind: string;

  constructor(operationKind: string, decision: ComplianceDecision) {
    super(decision.reason);
    this.name = 'ComplianceBlockedError';
    this.operationKind = operationKind;
    this.decision = decision;
    this.code = decision.denialCode;
  }

  /**
   * Project this block into the platform-wide serializable error shape
   * (category `compliance_blocked`, code {@link COMPLIANCE_BLOCKED_CODE})
   * (Req 38.6, 46.8). The structured `details` carry only the blocked operation
   * label and the fail-closed reason; never sensitive content.
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'compliance_blocked',
      code: COMPLIANCE_BLOCKED_CODE,
      message: this.message,
      correlationId,
      details: { operationKind: this.operationKind, denialCode: this.code },
    });
  }
}
