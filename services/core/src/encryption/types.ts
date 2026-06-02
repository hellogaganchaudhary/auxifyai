/**
 * Platform encryption + secret-storage domain types and injectable ports
 * (Req 34.7, 35.1, 35.2, 35.3, 35.5).
 *
 * These are the platform-wide data-protection primitives the design specifies:
 * authenticated symmetric encryption of designated sensitive fields (Req 35.1,
 * 35.3) and a secret store that persists secrets BY REFERENCE in encrypted form,
 * excluding the secret value from every persisted record, log line, and UI
 * projection (Req 34.7). They are deliberately named distinctly from the
 * Integration_Service's narrow `SecretStore` port (which holds connector
 * credentials by reference) so both can coexist in the package barrel: this
 * module's persistence seam is the {@link SecretBackend} and its service is the
 * {@link EncryptedSecretStore}.
 *
 * The design's two seams are modelled explicitly so production wiring stays
 * decoupled from any single cloud provider and key never appears in source:
 *
 *   - {@link KeyProvider} — the envelope-encryption / key-management seam. It
 *     yields the active {@link DataKey} used to encrypt new values and resolves a
 *     past key by id to decrypt an existing {@link EncryptionEnvelope}, so a key
 *     rotation (a new active key) never strands data encrypted under an older key
 *     (Req 35.1). In production it is backed by AWS KMS or Azure Key Vault; tests
 *     substitute the in-memory provider in `./fakes.js`. A data key is NEVER
 *     hardcoded — it always comes from this port.
 *   - {@link SecretBackend} — the tenant-scoped, region-pinnable persistence seam
 *     for already-encrypted secret blobs (Req 34.7, 35.5). In production it is
 *     backed by AWS Secrets Manager or Azure Key Vault; tests substitute the
 *     in-memory backend in `./fakes.js`. It only ever sees ciphertext.
 *
 * Tenancy (Req 1.2, 1.4): every secret carries its `organizationId`; the
 * {@link SecretBackend} requires a {@link TenantContext} on every method and
 * confines the operation to the caller's Organization, and the
 * {@link EncryptedSecretStore} binds each ciphertext to its
 * `(organizationId, reference)` via additional authenticated data so an envelope
 * can never be replayed under a different tenant or reference.
 */

import type { TenantContext } from '@auxify/types';

/**
 * The authenticated symmetric encryption algorithm the platform uses for
 * field-level and at-rest encryption (Req 35.1, 35.3).
 *
 * AES-256 in Galois/Counter Mode provides confidentiality AND integrity: the
 * authentication tag makes any tampering with the ciphertext, the IV, or the
 * additional authenticated data detectable at decryption time, so a forged or
 * corrupted envelope fails closed rather than yielding garbage plaintext.
 */
export type EncryptionAlgorithm = 'AES-256-GCM';

/** The one supported {@link EncryptionAlgorithm}, named for envelopes and guards. */
export const ENCRYPTION_ALGORITHM: EncryptionAlgorithm = 'AES-256-GCM';

/** The required AES-256 key length in bytes (256 bits). */
export const DATA_KEY_BYTES = 32 as const;

/** The recommended GCM initialization-vector length in bytes (96 bits). */
export const GCM_IV_BYTES = 12 as const;

/** The GCM authentication-tag length in bytes (128 bits). */
export const GCM_AUTH_TAG_BYTES = 16 as const;

/** The current {@link EncryptionEnvelope} format version. */
export const ENVELOPE_VERSION = 1 as const;

/**
 * A data-encryption key resolved from the {@link KeyProvider} (Req 35.1).
 *
 * The {@link keyId} identifies which key encrypted a given value and is recorded
 * in every {@link EncryptionEnvelope}, so decryption can resolve the exact key
 * even after the active key has rotated (Req 35.1). The raw {@link material} is
 * 256-bit AES key bytes and is NEVER persisted, logged, or placed in an envelope
 * — it lives only transiently in memory while a value is being (de)encrypted.
 */
export interface DataKey {
  /** The stable id of this key, recorded in the envelope for rotation-safe decryption. */
  keyId: string;
  /** The raw 256-bit ({@link DATA_KEY_BYTES}) AES key material — never persisted or logged. */
  material: Uint8Array;
}

/**
 * The injectable key-management / envelope-encryption seam (Req 35.1).
 *
 * Encryption draws the {@link activeKey} (so a rotation simply changes which key
 * new values use), while decryption resolves the specific key the envelope names
 * via {@link keyById} — so values encrypted under a retired key still decrypt
 * after rotation. Production wires a KMS/Key-Vault-backed provider; tests
 * substitute {@link import('./fakes.js').InMemoryKeyProvider}. A key is ALWAYS
 * obtained through this port and never hardcoded.
 */
export interface KeyProvider {
  /**
   * Resolve the current active data key used to encrypt NEW values (Req 35.1).
   * After a rotation this returns the new key; previously-encrypted envelopes
   * continue to name their original key id.
   */
  activeKey(): Promise<DataKey>;
  /**
   * Resolve a specific data key by id to decrypt an existing envelope (Req 35.1).
   *
   * @throws {import('./errors.js').UnknownEncryptionKeyError} when the id is unknown.
   */
  keyById(keyId: string): Promise<DataKey>;
}

/**
 * A self-describing, authenticated ciphertext envelope (Req 35.1, 35.3).
 *
 * Every field needed to decrypt — the {@link algorithm}, the {@link keyId} that
 * names the encrypting {@link DataKey} (the rotation seam), the per-encryption
 * {@link iv}, the {@link ciphertext}, and the {@link authTag} — travels with the
 * value, so the persisted form is fully self-contained and a key rotation never
 * strands old data. The {@link iv} is unique per encryption and the
 * {@link authTag} authenticates the ciphertext together with any bound
 * {@link aad}; tampering with any part is detected at decryption. Binary fields
 * are base64-encoded so the envelope is JSON- and column-safe. The envelope
 * carries NO plaintext and NO key material.
 */
export interface EncryptionEnvelope {
  /** The envelope format version (currently {@link ENVELOPE_VERSION}). */
  version: typeof ENVELOPE_VERSION;
  /** The authenticated algorithm used (currently {@link ENCRYPTION_ALGORITHM}). */
  algorithm: EncryptionAlgorithm;
  /** The id of the {@link DataKey} that encrypted this value, for rotation-safe decryption (Req 35.1). */
  keyId: string;
  /** The base64-encoded, unique-per-encryption initialization vector. */
  iv: string;
  /** The base64-encoded ciphertext. */
  ciphertext: string;
  /** The base64-encoded GCM authentication tag binding the ciphertext (and any AAD). */
  authTag: string;
  /**
   * Whether additional authenticated data was bound at encryption time. The AAD
   * value itself is NOT stored (it is reconstructed by the caller, e.g. from the
   * tenant + reference); this flag records that decryption must supply it.
   */
  aad: boolean;
}

/** An opaque, NON-SECRET handle a secret is stored and resolved under in the {@link EncryptedSecretStore}. */
export type SecretReference = string;

/**
 * Non-secret metadata about a stored secret (Req 34.7, 35.5).
 *
 * Describes WHERE and WHEN a secret is held — never its value. Safe to surface
 * in a status projection, return from a write, or record in an audit event.
 */
export interface SecretMetadata {
  /** The Organization the secret belongs to (its tenant scope). */
  organizationId: string;
  /** The non-secret reference the secret is stored under. */
  reference: SecretReference;
  /** The data-key id the secret's envelope is encrypted under (rotation visibility, Req 35.1). */
  keyId: string;
  /** The configured data-residency region the secret is pinned to, when one applies (Req 35.5). */
  region?: string;
  /** The ISO-8601 instant the secret was first written. */
  createdAt: string;
  /** The ISO-8601 instant the secret was last written. */
  updatedAt: string;
}

/**
 * A persisted, ALREADY-ENCRYPTED secret blob as the {@link SecretBackend} holds
 * it (Req 34.7, 35.3).
 *
 * The {@link envelope} is the serialized {@link EncryptionEnvelope} string — the
 * backend only ever sees ciphertext, never the plaintext secret. The metadata
 * fields let a region-aware backend pin storage to the configured residency
 * region (Req 35.5) and let the {@link EncryptedSecretStore} report
 * {@link SecretMetadata} without decrypting.
 */
export interface StoredSecretRecord {
  /** The Organization the secret belongs to. */
  organizationId: string;
  /** The non-secret reference the secret is stored under. */
  reference: SecretReference;
  /** The serialized {@link EncryptionEnvelope} string — ciphertext only, never plaintext. */
  envelope: string;
  /** The configured residency region the secret is pinned to, when one applies (Req 35.5). */
  region?: string;
  /** The ISO-8601 instant the secret was first written. */
  createdAt: string;
  /** The ISO-8601 instant the secret was last written. */
  updatedAt: string;
}

/**
 * The tenant-scoped persistence seam for already-encrypted secret blobs
 * (Req 34.7, 35.5).
 *
 * Every method takes the caller's {@link TenantContext} so persistence is
 * automatically scoped to the Organization (Req 1.2, 1.4). The backend stores
 * and returns only ciphertext envelopes — it never sees a plaintext secret or
 * any key material. Modelling it as a narrow port keeps the
 * {@link EncryptedSecretStore} decoupled from the concrete secret manager (AWS
 * Secrets Manager, Azure Key Vault, …); tests substitute
 * {@link import('./fakes.js').InMemorySecretBackend}. A region-aware backend uses
 * {@link StoredSecretRecord.region} to pin storage to the configured residency
 * region (Req 35.5).
 */
export interface SecretBackend {
  /**
   * Create or replace the encrypted secret held under `record.reference` within
   * the caller's Organization. Implementations MUST persist only the ciphertext
   * envelope and MUST NOT log or echo it as if it were sensitive plaintext.
   */
  put(ctx: TenantContext, record: StoredSecretRecord): Promise<void>;
  /** Fetch the encrypted record under `reference`, or `null` when none exists. */
  get(ctx: TenantContext, reference: SecretReference): Promise<StoredSecretRecord | null>;
  /** Remove the encrypted record under `reference` (a no-op when absent). */
  delete(ctx: TenantContext, reference: SecretReference): Promise<void>;
}

/**
 * The injectable resolver of an Organization's configured data-residency region
 * (Req 35.5).
 *
 * When residency is configured for an Organization, the {@link EncryptedSecretStore}
 * stamps the resolved region onto each {@link StoredSecretRecord} so a
 * region-aware {@link SecretBackend} pins the secret's storage to that region.
 * Returning `undefined` means no residency constraint applies. Wiring this as a
 * port keeps residency policy out of the encryption logic and unit-testable.
 */
export interface ResidencyResolver {
  /** The configured residency region for the context's Organization, or `undefined` when unconstrained. */
  regionFor(ctx: TenantContext): Promise<string | undefined>;
}

/** The clock the {@link EncryptedSecretStore} reads for record timestamps (injectable for tests). */
export interface EncryptionClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link EncryptionClock}, backed by the global `Date.now`. */
export const systemEncryptionClock: EncryptionClock = { now: () => Date.now() };
