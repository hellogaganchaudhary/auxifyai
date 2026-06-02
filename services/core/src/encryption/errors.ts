/**
 * Encryption + secret-storage typed errors (Req 34.7, 35.1, 35.3).
 *
 * These are the *fail-closed* rejections the encryption core and the
 * {@link import('./encrypted-secret-store.js').EncryptedSecretStore} raise when
 * a data-protection invariant cannot be honoured. Each projects into the
 * platform-wide serializable {@link PlatformError} (Req 46.8) carrying a stable
 * machine-readable code and only structured, SECRET-FREE `details` — never the
 * plaintext, the key material, or the ciphertext bytes (Req 34.7):
 *
 *  - {@link UnknownEncryptionKeyError} — a {@link import('./types.js').KeyProvider}
 *    was asked for a key id it does not hold, so an envelope naming a retired or
 *    unknown key cannot be decrypted (Req 35.1). Categorized `internal`: a
 *    well-formed deployment always retains the keys its envelopes name, so a
 *    miss is a server-side key-management fault, surfaced without leaking the id
 *    pattern to clients.
 *  - {@link DecryptionError} — authenticated decryption failed: the GCM
 *    authentication tag did not verify, so the key, the ciphertext, the IV, the
 *    tag, or the bound additional authenticated data was wrong or tampered with
 *    (Req 35.1, 35.3). The underlying crypto failure is wrapped so the raw
 *    plaintext attempt and key material never escape. Categorized `internal`
 *    (fail-closed: a forged or corrupted envelope yields an error, never
 *    plaintext).
 *  - {@link SecretNotFoundError} — a read or delete named a reference with no
 *    stored secret in the caller's Organization (Req 34.7). Categorized
 *    `not_found`.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** The stable machine-readable code for a key id the {@link import('./types.js').KeyProvider} does not hold (Req 35.1). */
export const UNKNOWN_ENCRYPTION_KEY_CODE = 'ENCRYPTION_UNKNOWN_KEY' as const;

/** The stable machine-readable code for an authenticated-decryption failure (Req 35.1, 35.3). */
export const DECRYPTION_FAILED_CODE = 'ENCRYPTION_DECRYPTION_FAILED' as const;

/** The stable machine-readable code for a missing secret reference (Req 34.7). */
export const SECRET_NOT_FOUND_CODE = 'ENCRYPTION_SECRET_NOT_FOUND' as const;

/**
 * Thrown by a {@link import('./types.js').KeyProvider} when asked to resolve a
 * key id it does not hold (Req 35.1).
 *
 * An {@link import('./types.js').EncryptionEnvelope} records the id of the key
 * that encrypted it so decryption stays rotation-safe; if that key can no longer
 * be resolved the value cannot be decrypted and the store fails closed rather
 * than returning garbage. The offending id is carried in `details` for
 * operators (it is a non-secret key handle, never the key material).
 * Categorized `internal`.
 */
export class UnknownEncryptionKeyError extends Error {
  /** The non-secret key id that could not be resolved. */
  readonly keyId: string;

  constructor(keyId: string) {
    super(`No encryption key is registered for key id "${keyId}"`);
    this.name = 'UnknownEncryptionKeyError';
    this.keyId = keyId;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `internal`, code {@link UNKNOWN_ENCRYPTION_KEY_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'internal',
      code: UNKNOWN_ENCRYPTION_KEY_CODE,
      message: this.message,
      correlationId,
      details: { keyId: this.keyId },
    });
  }
}

/**
 * Thrown when authenticated decryption fails (Req 35.1, 35.3).
 *
 * AES-256-GCM authenticates the ciphertext together with the IV and any bound
 * additional authenticated data; if any of them — or the key — is wrong or has
 * been tampered with, the tag does not verify and decryption MUST fail closed.
 * The underlying crypto error is wrapped (never re-thrown verbatim) so no
 * plaintext attempt or key material leaks. The `reason` is a short, secret-free
 * label. Categorized `internal`.
 */
export class DecryptionError extends Error {
  /** A short, secret-free reason describing why decryption failed. */
  readonly reason: string;

  /**
   * @param reason A short, secret-free reason (e.g. an unsupported version or a
   *   failed authentication tag).
   * @param cause The underlying error, retained for server-side diagnostics only.
   */
  constructor(reason: string, cause?: unknown) {
    super(`Decryption failed: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'DecryptionError';
    this.reason = reason;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `internal`, code {@link DECRYPTION_FAILED_CODE}) (Req 46.8).
   *
   * The `reason` is the only structured detail and is deliberately free of any
   * plaintext, key material, or ciphertext bytes (Req 34.7).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'internal',
      code: DECRYPTION_FAILED_CODE,
      message: this.message,
      correlationId,
      details: { reason: this.reason },
    });
  }
}

/**
 * Thrown when a secret read or delete names a reference with no stored secret in
 * the caller's Organization (Req 34.7).
 *
 * The reference is a non-secret handle, so it is safe to carry in `details`.
 * Categorized `not_found`.
 */
export class SecretNotFoundError extends Error {
  /** The Organization the lookup was scoped to. */
  readonly organizationId: string;
  /** The non-secret reference that had no stored secret. */
  readonly reference: string;

  constructor(organizationId: string, reference: string) {
    super(`No secret is stored under reference "${reference}"`);
    this.name = 'SecretNotFoundError';
    this.organizationId = organizationId;
    this.reference = reference;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `not_found`, code {@link SECRET_NOT_FOUND_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: SECRET_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { organizationId: this.organizationId, reference: this.reference },
    });
  }
}
