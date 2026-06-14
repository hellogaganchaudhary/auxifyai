/**
 * Auth_Service domain errors (Req 33.2-33.5, 33.9, 33.12, 33.13).
 *
 * These make the service's failure conditions explicit and testable, and each
 * projects into the platform-wide serializable {@link PlatformError} shape
 * (Req 46.8):
 *   - {@link AuthenticationFailedError} — credentials (or a required second
 *     factor) did not verify (Req 33.2-33.5, 33.12), projected as an
 *     `authentication` error. It is deliberately uniform across "no such user",
 *     "wrong password", and "bad MFA code" so it never leaks which was wrong.
 *   - {@link MfaRequiredError} — authentication succeeded but a required second
 *     factor was not supplied, so the caller must collect one and retry
 *     (Req 33.5); projected as an `authentication` error with a stable code the
 *     client branches on.
 *   - {@link InvalidSessionError} — a presented access/refresh token or session
 *     is unknown, expired, or revoked (Req 33.9, 33.13), projected as an
 *     `authentication` error.
 *   - {@link MfaFactorNotFoundError} — an enrollment verification targets a
 *     factor absent within the caller's Organization (Req 33.5), projected as a
 *     `not_found` error.
 *
 * SECURITY: none of these errors ever carries a password, an MFA secret, or a
 * raw token. A failed *sign-in* is surfaced through
 * {@link AuthenticationFailedError} only after the failure has been recorded in
 * the Audit_Service (Req 33.12), and its message is intentionally generic.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { AuthMethod, MfaRequirementReason } from './types.js';

/** Stable machine-readable code for a failed authentication (Req 33.12). */
export const AUTHENTICATION_FAILED_CODE = 'AUTHENTICATION_FAILED' as const;

/** Stable machine-readable code for a required-but-missing second factor (Req 33.5). */
export const MFA_REQUIRED_CODE = 'MFA_REQUIRED' as const;

/** Stable machine-readable code for an invalid/expired/revoked session or token (Req 33.9, 33.13). */
export const INVALID_SESSION_CODE = 'INVALID_SESSION' as const;

/** Stable machine-readable code for a missing MFA factor enrollment (Req 33.5). */
export const MFA_FACTOR_NOT_FOUND_CODE = 'MFA_FACTOR_NOT_FOUND' as const;

/**
 * Thrown when authentication is denied — invalid credentials, a failed external
 * verification, or an invalid second factor (Req 33.2-33.5, 33.12).
 *
 * The message is deliberately generic and the error carries only the
 * authentication {@link method}, never the attempted identity or secret, so it
 * cannot be used to probe which accounts exist.
 */
export class AuthenticationFailedError extends Error {
  /** The authentication method that failed (Req 33.2, 33.3, 33.4). */
  readonly method: AuthMethod;

  constructor(method: AuthMethod) {
    super('Authentication failed');
    this.name = 'AuthenticationFailedError';
    this.method = method;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authentication',
      code: AUTHENTICATION_FAILED_CODE,
      message: this.message,
      correlationId,
      details: { method: this.method },
    });
  }
}

/**
 * Thrown when credentials verified but a required second factor was not supplied
 * (Req 33.5).
 *
 * Carries the {@link reasons} the requirement was triggered so the client can
 * explain why a second factor is needed, and never carries a secret.
 */
export class MfaRequiredError extends Error {
  /** Every condition that triggered the MFA requirement (Req 33.5, 33.6, 33.7). */
  readonly reasons: MfaRequirementReason[];

  constructor(reasons: MfaRequirementReason[]) {
    super('Multi-factor authentication is required to complete sign-in');
    this.name = 'MfaRequiredError';
    this.reasons = reasons;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authentication',
      code: MFA_REQUIRED_CODE,
      message: this.message,
      correlationId,
      details: { reasons: this.reasons },
    });
  }
}

/**
 * Thrown when a presented access/refresh token or session is unknown, expired,
 * or revoked (Req 33.9, 33.13).
 */
export class InvalidSessionError extends Error {
  /** A short, non-secret reason for the rejection. */
  readonly reason: 'unknown' | 'expired' | 'revoked';

  constructor(reason: 'unknown' | 'expired' | 'revoked') {
    super(`Session is not valid: ${reason}`);
    this.name = 'InvalidSessionError';
    this.reason = reason;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authentication',
      code: INVALID_SESSION_CODE,
      message: this.message,
      correlationId,
      details: { reason: this.reason },
    });
  }
}

/**
 * Thrown when an MFA enrollment verification targets a factor that does not
 * exist within the caller's Organization (Req 33.5).
 */
export class MfaFactorNotFoundError extends Error {
  /** The factor id that was looked up (safe to surface; not a secret). */
  readonly factorId: string;

  constructor(factorId: string) {
    super(`MFA factor "${factorId}" was not found in the current organization`);
    this.name = 'MfaFactorNotFoundError';
    this.factorId = factorId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: MFA_FACTOR_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { factorId: this.factorId },
    });
  }
}
