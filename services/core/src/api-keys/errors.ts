/**
 * API_Key_Manager domain errors (Req 21.1-21.7).
 *
 * These make the manager's not-found and invalid-input conditions explicit and
 * testable, and each projects into the platform-wide serializable
 * {@link PlatformError} shape (Req 46.8):
 *   - {@link ApiKeyNotFoundError} — a get/revoke/rotate targets a key absent
 *     within the caller's Organization (tenant scoping already prevents
 *     cross-tenant reads, so "not in my tenant" surfaces as "not found");
 *   - {@link KeyRateLimitExceededError} — a recorded use would exceed the key's
 *     configured rate limit (Req 21.7), projected as a `rate_limited` error;
 *   - {@link InvalidKeyExpiryError} — a creation supplied an unparseable or
 *     already-past expiry (Req 21.4).
 *
 * SECURITY: a failed *authentication* is deliberately NOT modelled as a thrown
 * error — {@link import('./api-key-manager.js').ApiKeyManager.authenticate}
 * returns a structured {@link import('./types.js').KeyAuthResult} that never
 * leaks whether a similar key exists. These errors cover the management surface
 * only, and none of them ever carries a raw key value.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { RateLimit } from './types.js';

/** Stable machine-readable code for a missing API key. */
export const API_KEY_NOT_FOUND_CODE = 'API_KEY_NOT_FOUND' as const;

/** Stable machine-readable code for an exceeded key rate limit (Req 21.7). */
export const KEY_RATE_LIMIT_EXCEEDED_CODE = 'KEY_RATE_LIMIT_EXCEEDED' as const;

/** Stable machine-readable code for an invalid key expiry (Req 21.4). */
export const INVALID_KEY_EXPIRY_CODE = 'INVALID_KEY_EXPIRY' as const;

/**
 * Thrown when an API key referenced by a management operation does not exist
 * within the caller's Organization.
 */
export class ApiKeyNotFoundError extends Error {
  /** The key id that was looked up (safe to surface; not the secret). */
  readonly keyId: string;

  constructor(keyId: string) {
    super(`API key "${keyId}" was not found in the current organization`);
    this.name = 'ApiKeyNotFoundError';
    this.keyId = keyId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: API_KEY_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { keyId: this.keyId },
    });
  }
}

/**
 * Thrown when recording a use of a key would exceed its configured rate limit
 * (Req 21.7). Carries the limit and the current count for the caller and for a
 * retry-after hint.
 */
export class KeyRateLimitExceededError extends Error {
  /** The key whose limit was exceeded. */
  readonly keyId: string;
  /** The key's configured rate limit. */
  readonly rateLimit: RateLimit;

  constructor(keyId: string, rateLimit: RateLimit) {
    super(
      `API key "${keyId}" exceeded its rate limit of ${rateLimit.requestsPerWindow} ` +
        `requests per ${rateLimit.windowSeconds}s`,
    );
    this.name = 'KeyRateLimitExceededError';
    this.keyId = keyId;
    this.rateLimit = rateLimit;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8, 45.7). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'rate_limited',
      code: KEY_RATE_LIMIT_EXCEEDED_CODE,
      message: this.message,
      correlationId,
      retryAfterSeconds: this.rateLimit.windowSeconds,
      details: { keyId: this.keyId, rateLimit: this.rateLimit },
    });
  }
}

/**
 * Thrown when a key creation supplies an `expiresAt` that is not a valid
 * ISO-8601 timestamp or is already in the past (Req 21.4).
 */
export class InvalidKeyExpiryError extends Error {
  /** The rejected expiry value. */
  readonly expiresAt: string;

  constructor(expiresAt: string, reason: string) {
    super(`Invalid API key expiry "${expiresAt}": ${reason}`);
    this.name = 'InvalidKeyExpiryError';
    this.expiresAt = expiresAt;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_KEY_EXPIRY_CODE,
      message: this.message,
      correlationId,
      details: { expiresAt: this.expiresAt },
    });
  }
}
