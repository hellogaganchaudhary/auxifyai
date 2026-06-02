/**
 * The {@link EncryptedSecretStore} (Req 34.7, 35.1, 35.2, 35.3, 35.5).
 *
 * The platform service that persists secrets BY REFERENCE in encrypted form: it
 * encrypts a plaintext secret into an authenticated {@link EncryptionEnvelope}
 * and hands the {@link SecretBackend} only ciphertext, so the secret value never
 * appears in a persisted record, a log line, or a status projection (Req 34.7).
 * In production the {@link SecretBackend} is AWS Secrets Manager or Azure Key
 * Vault and the {@link KeyProvider} is AWS KMS or Azure Key Vault; at-rest
 * encryption is AES-256-GCM (Req 35.2) and the transport to those services is
 * TLS 1.3 (Req 35.2, enforced at the deployment/transport layer — see the
 * Security_Gateway). This service is pure orchestration over its injected ports,
 * so it is fully unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * Two defenses are built in beyond confidentiality:
 *
 *   - Tenant + reference binding (Req 1.2, 1.4, 35.3): every ciphertext binds
 *     additional authenticated data derived from the `(organizationId, reference)`
 *     pair, so an envelope lifted from one tenant or reference can never be
 *     decrypted under another — a cross-tenant replay fails closed at the GCM
 *     authentication tag.
 *   - Rotation-safety (Req 35.1): new secrets encrypt under the
 *     {@link KeyProvider}'s active key, while reads resolve the SPECIFIC key the
 *     envelope names, so rotating the active key never strands existing secrets.
 *
 * Residency (Req 35.5): when a {@link ResidencyResolver} is configured, the
 * resolved region is stamped onto each {@link StoredSecretRecord} so a
 * region-aware backend pins the secret's storage to the Organization's
 * configured residency region.
 *
 * Field-level encryption (Req 35.3): {@link EncryptedSecretStore.encryptField}
 * and {@link EncryptedSecretStore.decryptField} expose the same AES-256-GCM
 * envelope core as a serialized-string pair, so a caller can encrypt a designated
 * sensitive column value in place without going through the secret backend.
 */

import type { TenantContext } from '@auxify/types';

import { decryptToString, deserializeEnvelope, encrypt, serializeEnvelope } from './crypto.js';
import { SecretNotFoundError } from './errors.js';
import {
  systemEncryptionClock,
  type EncryptionClock,
  type KeyProvider,
  type ResidencyResolver,
  type SecretBackend,
  type SecretMetadata,
  type SecretReference,
  type StoredSecretRecord,
} from './types.js';

/** Construction options for the {@link EncryptedSecretStore}. */
export interface EncryptedSecretStoreOptions {
  /** The key-management / envelope-encryption seam (Req 35.1); KMS / Key Vault in production. */
  keys: KeyProvider;
  /** The tenant-scoped persistence seam for ciphertext (Req 34.7); Secrets Manager / Key Vault in production. */
  backend: SecretBackend;
  /** Optional resolver of an Organization's configured residency region (Req 35.5). */
  residency?: ResidencyResolver;
  /** Optional clock for record timestamps (defaults to {@link systemEncryptionClock}), for deterministic tests. */
  clock?: EncryptionClock;
}

/**
 * Persists secrets by reference in AES-256-GCM-encrypted form, binding each
 * ciphertext to its tenant + reference and pinning storage to the configured
 * residency region (Req 34.7, 35.1, 35.2, 35.3, 35.5).
 */
export class EncryptedSecretStore {
  private readonly keys: KeyProvider;
  private readonly backend: SecretBackend;
  private readonly residency?: ResidencyResolver;
  private readonly clock: EncryptionClock;

  constructor(options: EncryptedSecretStoreOptions) {
    this.keys = options.keys;
    this.backend = options.backend;
    this.residency = options.residency;
    this.clock = options.clock ?? systemEncryptionClock;
  }

  /**
   * Encrypt and persist a secret under `reference` within the caller's
   * Organization, returning only its non-secret {@link SecretMetadata}
   * (Req 34.7, 35.1, 35.3, 35.5).
   *
   * Draws the active data key (so the secret is encrypted under the current key,
   * Req 35.1), binds the `(organizationId, reference)` AAD so the ciphertext can
   * never be replayed under another tenant or reference (Req 35.3), resolves the
   * Organization's residency region when a resolver is configured (Req 35.5),
   * and persists the serialized ciphertext envelope through the backend. When a
   * secret already exists under the reference, its original `createdAt` is
   * preserved and only `updatedAt` advances. The plaintext is NEVER returned,
   * logged, or persisted (Req 34.7).
   *
   * @param ctx The tenant scope to store the secret in.
   * @param reference The non-secret handle the secret is stored and resolved under.
   * @param plaintext The secret value to encrypt.
   * @returns The non-secret {@link SecretMetadata} describing where and when it is held.
   */
  async putSecret(
    ctx: TenantContext,
    reference: SecretReference,
    plaintext: string | Uint8Array,
  ): Promise<SecretMetadata> {
    const key = await this.keys.activeKey();
    const aad = this.aadFor(ctx, reference);
    const envelope = encrypt(plaintext, key, aad);

    const region = this.residency !== undefined ? await this.residency.regionFor(ctx) : undefined;
    const nowIso = new Date(this.clock.now()).toISOString();
    const existing = await this.backend.get(ctx, reference);
    const createdAt = existing?.createdAt ?? nowIso;

    const record: StoredSecretRecord = {
      organizationId: ctx.organizationId,
      reference,
      envelope: serializeEnvelope(envelope),
      ...(region !== undefined ? { region } : {}),
      createdAt,
      updatedAt: nowIso,
    };
    await this.backend.put(ctx, record);

    return this.toMetadata(record, envelope.keyId);
  }

  /**
   * Resolve and decrypt the secret stored under `reference` within the caller's
   * Organization (Req 34.7, 35.1, 35.3).
   *
   * Fetches the ciphertext record (failing closed with {@link SecretNotFoundError}
   * when absent), resolves the SPECIFIC key the envelope names — so a secret
   * written before a key rotation still decrypts (Req 35.1) — reconstructs the
   * identical `(organizationId, reference)` AAD, and decrypts. Any tampering, a
   * wrong key, or a cross-tenant replay fails closed in the crypto core.
   *
   * @param ctx The tenant scope to read from.
   * @param reference The non-secret handle the secret is stored under.
   * @returns The decrypted plaintext secret as a UTF-8 string.
   * @throws {SecretNotFoundError} If no secret is stored under the reference.
   * @throws {import('./errors.js').UnknownEncryptionKeyError} If the envelope's key id is unknown.
   * @throws {import('./errors.js').DecryptionError} If authentication fails (tampering / wrong key / AAD mismatch).
   */
  async getSecret(ctx: TenantContext, reference: SecretReference): Promise<string> {
    const record = await this.requireRecord(ctx, reference);
    const envelope = deserializeEnvelope(record.envelope);
    const key = await this.keys.keyById(envelope.keyId);
    const aad = this.aadFor(ctx, reference);
    return decryptToString(envelope, key, aad);
  }

  /**
   * Read a secret's non-secret {@link SecretMetadata} WITHOUT decrypting it
   * (Req 34.7).
   *
   * The safe projection for a status view or an audit event: it reports where
   * and when the secret is held and which key it is under, but never touches the
   * plaintext or the key material.
   *
   * @param ctx The tenant scope to read from.
   * @param reference The non-secret handle the secret is stored under.
   * @returns The metadata, or `null` when no secret is stored under the reference.
   */
  async getMetadata(
    ctx: TenantContext,
    reference: SecretReference,
  ): Promise<SecretMetadata | null> {
    const record = await this.backend.get(ctx, reference);
    if (record === null) {
      return null;
    }
    // Read the key id from the envelope header only; the value is never decrypted.
    const envelope = deserializeEnvelope(record.envelope);
    return this.toMetadata(record, envelope.keyId);
  }

  /**
   * Remove the secret stored under `reference` within the caller's Organization
   * (a no-op when none exists).
   *
   * @param ctx The tenant scope to delete from.
   * @param reference The non-secret handle the secret is stored under.
   */
  async deleteSecret(ctx: TenantContext, reference: SecretReference): Promise<void> {
    await this.backend.delete(ctx, reference);
  }

  /**
   * Encrypt a designated sensitive field value into a serialized envelope string
   * for storage in place (field-level encryption, Req 35.3).
   *
   * Reuses the same AES-256-GCM envelope core as the secret path under the active
   * key, optionally binding a caller-supplied AAD (for example a column or record
   * identity) so a ciphertext cannot be moved between fields. The returned string
   * is the serialized {@link EncryptionEnvelope}, safe to persist in a single
   * column; it contains no plaintext or key material.
   *
   * @param plaintext The field value to encrypt.
   * @param aad Optional additional authenticated data binding the field's context.
   * @returns The serialized ciphertext envelope string.
   */
  async encryptField(plaintext: string | Uint8Array, aad?: Uint8Array): Promise<string> {
    const key = await this.keys.activeKey();
    return serializeEnvelope(encrypt(plaintext, key, aad));
  }

  /**
   * Decrypt a serialized field envelope produced by {@link encryptField}
   * (field-level encryption, Req 35.3).
   *
   * Resolves the specific key the envelope names (rotation-safe, Req 35.1) and
   * fails closed via the crypto core on any tampering or AAD mismatch.
   *
   * @param serializedEnvelope The serialized envelope string from {@link encryptField}.
   * @param aad The identical additional authenticated data bound at encryption, when any.
   * @returns The decrypted field value as a UTF-8 string.
   * @throws {import('./errors.js').UnknownEncryptionKeyError} If the envelope's key id is unknown.
   * @throws {import('./errors.js').DecryptionError} If authentication fails or the value is malformed.
   */
  async decryptField(serializedEnvelope: string, aad?: Uint8Array): Promise<string> {
    const envelope = deserializeEnvelope(serializedEnvelope);
    const key = await this.keys.keyById(envelope.keyId);
    return decryptToString(envelope, key, aad);
  }

  /**
   * A secret-free, log-safe description of this store (Req 34.7).
   *
   * Deliberately reports only the composed component class names — never a
   * secret, a key, or a ciphertext — so the store is safe to interpolate into a
   * log line or diagnostic.
   */
  describe(): string {
    return `EncryptedSecretStore(backend=${this.backend.constructor.name}, keys=${this.keys.constructor.name}, residency=${this.residency !== undefined})`;
  }

  /** Alias of {@link describe} so default string coercion never leaks secrets (Req 34.7). */
  toString(): string {
    return this.describe();
  }

  // --- internals ---------------------------------------------------------

  /** Fetch a record or fail closed with {@link SecretNotFoundError} (Req 34.7). */
  private async requireRecord(
    ctx: TenantContext,
    reference: SecretReference,
  ): Promise<StoredSecretRecord> {
    const record = await this.backend.get(ctx, reference);
    if (record === null) {
      throw new SecretNotFoundError(ctx.organizationId, reference);
    }
    return record;
  }

  /**
   * Derive the additional authenticated data binding a ciphertext to its tenant
   * and reference (Req 1.4, 35.3).
   *
   * UTF-8 of `${organizationId}:${reference}` — the exact same bytes must be
   * reconstructed at decryption, so an envelope is only ever decryptable under
   * the tenant and reference it was written for.
   */
  private aadFor(ctx: TenantContext, reference: SecretReference): Uint8Array {
    return new TextEncoder().encode(`${ctx.organizationId}:${reference}`);
  }

  /** Project a stored record into its non-secret {@link SecretMetadata}. */
  private toMetadata(record: StoredSecretRecord, keyId: string): SecretMetadata {
    return {
      organizationId: record.organizationId,
      reference: record.reference,
      keyId,
      ...(record.region !== undefined ? { region: record.region } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
