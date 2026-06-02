/**
 * The pure AES-256-GCM authenticated-envelope core (Req 35.1, 35.3).
 *
 * This is the platform's field-level / at-rest encryption primitive, built
 * entirely on Node's built-in `node:crypto` (no third-party dependency). It
 * turns a plaintext value plus a {@link DataKey} into a self-describing,
 * authenticated {@link EncryptionEnvelope} and back, and is the single place the
 * GCM mechanics live — every other module (the
 * {@link import('./encrypted-secret-store.js').EncryptedSecretStore}, and any
 * designated-sensitive-field encryption) composes these functions rather than
 * touching `node:crypto` directly.
 *
 * Confidentiality AND integrity come from GCM: {@link encrypt} draws a fresh
 * random {@link GCM_IV_BYTES}-byte IV per call so the same plaintext never
 * yields the same ciphertext, and emits a {@link GCM_AUTH_TAG_BYTES}-byte
 * authentication tag that binds the ciphertext together with any additional
 * authenticated data (AAD). {@link decrypt} verifies that tag and FAILS CLOSED —
 * a wrong key, an altered ciphertext / IV / tag, or missing / mismatched AAD all
 * raise a typed {@link DecryptionError} rather than returning forged plaintext.
 * GCM's tag comparison is itself constant-time, so no manual compare is needed.
 *
 * The envelope's binary fields are base64-encoded (via {@link Buffer}) so the
 * envelope is JSON- and database-column-safe, but the public surface is kept in
 * `string` / `Uint8Array` only — `Buffer` never leaks into a signature.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { DecryptionError } from './errors.js';
import {
  DATA_KEY_BYTES,
  ENCRYPTION_ALGORITHM,
  ENVELOPE_VERSION,
  GCM_AUTH_TAG_BYTES,
  GCM_IV_BYTES,
  type DataKey,
  type EncryptionEnvelope,
} from './types.js';

/** The `node:crypto` cipher identifier for AES-256 in Galois/Counter Mode. */
const GCM_CIPHER = 'aes-256-gcm' as const;

/**
 * Encrypt a value into a self-describing, authenticated {@link EncryptionEnvelope}
 * (Req 35.1, 35.3).
 *
 * Generates a fresh random {@link GCM_IV_BYTES}-byte IV for THIS call (so two
 * encryptions of the same plaintext under the same key produce different
 * ciphertexts), encrypts under the supplied {@link DataKey}, binds the optional
 * `aad` into the authentication tag, and stamps the envelope with the current
 * {@link ENVELOPE_VERSION}, the {@link ENCRYPTION_ALGORITHM}, and the key's id so
 * the value stays rotation-safe and the envelope is fully self-contained. The
 * returned envelope carries NO plaintext and NO key material.
 *
 * @param plaintext The value to encrypt; a `string` is UTF-8 encoded.
 * @param key The data key to encrypt under (its {@link DataKey.material} must be
 *   exactly {@link DATA_KEY_BYTES} bytes).
 * @param aad Optional additional authenticated data bound into the tag (not
 *   stored); decryption must supply the identical bytes.
 * @returns The authenticated envelope with its binary fields base64-encoded.
 * @throws {RangeError} If the key material is not {@link DATA_KEY_BYTES} bytes.
 */
export function encrypt(
  plaintext: string | Uint8Array,
  key: DataKey,
  aad?: Uint8Array,
): EncryptionEnvelope {
  assertKeyLength(key);

  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(GCM_CIPHER, key.material, iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  if (aad !== undefined) {
    cipher.setAAD(aad);
  }

  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: ENVELOPE_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    keyId: key.keyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
    aad: aad !== undefined,
  };
}

/**
 * Decrypt an {@link EncryptionEnvelope} back to its raw bytes, failing closed on
 * any tampering (Req 35.1, 35.3).
 *
 * Validates the envelope's version, algorithm, and field lengths, then verifies
 * the GCM authentication tag over the ciphertext and the supplied `aad`. Any
 * mismatch — a wrong key, an altered ciphertext / IV / tag, or AAD that differs
 * from (or is missing relative to) what was bound at encryption time — raises a
 * typed {@link DecryptionError}; the function NEVER returns forged plaintext.
 *
 * @param envelope The authenticated envelope produced by {@link encrypt}.
 * @param key The data key to decrypt under (must match the envelope's key id).
 * @param aad The identical additional authenticated data bound at encryption,
 *   when the envelope records `aad: true`.
 * @returns The decrypted raw bytes.
 * @throws {DecryptionError} On an unsupported version/algorithm, malformed
 *   fields, or a failed authentication (wrong key / tampering / AAD mismatch).
 */
export function decrypt(
  envelope: EncryptionEnvelope,
  key: DataKey,
  aad?: Uint8Array,
): Uint8Array {
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new DecryptionError(`unsupported envelope version ${String(envelope.version)}`);
  }
  if (envelope.algorithm !== ENCRYPTION_ALGORITHM) {
    throw new DecryptionError(`unsupported algorithm "${String(envelope.algorithm)}"`);
  }
  assertKeyLength(key);

  const iv = decodeBase64(envelope.iv, 'iv');
  const ciphertext = decodeBase64(envelope.ciphertext, 'ciphertext');
  const authTag = decodeBase64(envelope.authTag, 'authentication tag');

  if (iv.byteLength !== GCM_IV_BYTES) {
    throw new DecryptionError('initialization vector has an invalid length');
  }
  if (authTag.byteLength !== GCM_AUTH_TAG_BYTES) {
    throw new DecryptionError('authentication tag has an invalid length');
  }

  try {
    const decipher = createDecipheriv(GCM_CIPHER, key.material, iv, {
      authTagLength: GCM_AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(authTag);
    // The flag and the supplied AAD must agree with what was bound at
    // encryption; if they do not, the tag will not verify in `final()`.
    if (aad !== undefined) {
      decipher.setAAD(aad);
    }
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return Uint8Array.from(plaintext);
  } catch (cause) {
    // Wrap the underlying GCM authentication failure so neither the key material
    // nor any partial plaintext escapes (Req 34.7, 35.1).
    throw new DecryptionError('authentication failed', cause);
  }
}

/**
 * Decrypt an {@link EncryptionEnvelope} and decode the bytes as a UTF-8 string —
 * the convenience wrapper for the common secret/field case (Req 35.3).
 *
 * @param envelope The authenticated envelope produced by {@link encrypt}.
 * @param key The data key to decrypt under.
 * @param aad The additional authenticated data bound at encryption, when any.
 * @returns The decrypted plaintext as a UTF-8 string.
 * @throws {DecryptionError} On any authentication or format failure (fail-closed).
 */
export function decryptToString(
  envelope: EncryptionEnvelope,
  key: DataKey,
  aad?: Uint8Array,
): string {
  return Buffer.from(decrypt(envelope, key, aad)).toString('utf8');
}

/**
 * Serialize an {@link EncryptionEnvelope} to a compact JSON string for storage in
 * a single column or secret-backend value.
 *
 * @param envelope The envelope to serialize.
 * @returns The JSON string form (binary fields already base64-encoded).
 */
export function serializeEnvelope(envelope: EncryptionEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Parse a serialized {@link EncryptionEnvelope} string back into an envelope,
 * validating its shape and failing closed on anything malformed.
 *
 * Structural validation here keeps {@link decrypt} focused on the authenticated
 * path: a value that is not a well-formed envelope can never reach the cipher.
 *
 * @param serialized The JSON string produced by {@link serializeEnvelope}.
 * @returns The parsed envelope.
 * @throws {DecryptionError} If the string is not a well-formed envelope.
 */
export function deserializeEnvelope(serialized: string): EncryptionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (cause) {
    throw new DecryptionError('envelope is not valid JSON', cause);
  }
  if (!isEnvelopeShape(parsed)) {
    throw new DecryptionError('value is not a well-formed encryption envelope');
  }
  return parsed;
}

/** Assert the key material is exactly {@link DATA_KEY_BYTES} (256-bit AES) before use. */
function assertKeyLength(key: DataKey): void {
  if (key.material.byteLength !== DATA_KEY_BYTES) {
    throw new RangeError(
      `Encryption key "${key.keyId}" must be ${String(DATA_KEY_BYTES)} bytes, got ${String(key.material.byteLength)}`,
    );
  }
}

/**
 * Decode a base64 envelope field, failing closed with a {@link DecryptionError}
 * when it is not a string.
 *
 * An empty value is permitted: empty plaintext encrypts to empty ciphertext, so
 * the `ciphertext` field can legitimately be the empty string. The fixed-length
 * `iv` and `authTag` fields are length-validated by the caller after decoding.
 */
function decodeBase64(value: string, field: string): Buffer {
  if (typeof value !== 'string') {
    throw new DecryptionError(`${field} is missing`);
  }
  return Buffer.from(value, 'base64');
}

/** Structural type guard for a deserialized {@link EncryptionEnvelope}. */
function isEnvelopeShape(value: unknown): value is EncryptionEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === ENVELOPE_VERSION &&
    typeof candidate.algorithm === 'string' &&
    typeof candidate.keyId === 'string' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.ciphertext === 'string' &&
    typeof candidate.authTag === 'string' &&
    typeof candidate.aad === 'boolean'
  );
}
