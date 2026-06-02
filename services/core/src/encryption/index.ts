/**
 * Encryption + secret storage (Req 34.7, 35.1, 35.2, 35.3, 35.5): the platform's
 * field-level / at-rest encryption primitive and its by-reference secret store.
 *
 * Two layers compose here. The pure {@link encrypt} / {@link decrypt} /
 * {@link decryptToString} core turns a value plus a {@link DataKey} into a
 * self-describing, authenticated AES-256-GCM {@link EncryptionEnvelope} and back
 * — built entirely on Node's built-in `node:crypto` (no third-party
 * dependency), generating a fresh random IV per encryption and FAILING CLOSED on
 * any tampering (a wrong key, an altered ciphertext / IV / tag, or missing /
 * mismatched additional authenticated data raises a {@link DecryptionError})
 * (Req 35.1, 35.3). The {@link serializeEnvelope} / {@link deserializeEnvelope}
 * pair render an envelope to a JSON- and column-safe string.
 *
 * On top of that core, the {@link EncryptedSecretStore} persists secrets BY
 * REFERENCE in encrypted form (Req 34.7): {@link EncryptedSecretStore.putSecret}
 * encrypts under the {@link KeyProvider}'s active key, binds the ciphertext to
 * its `(organizationId, reference)` via additional authenticated data so it can
 * never be replayed under another tenant or reference (Req 1.4, 35.3), pins
 * storage to the configured residency region when a {@link ResidencyResolver} is
 * present (Req 35.5), and hands the {@link SecretBackend} only ciphertext;
 * {@link EncryptedSecretStore.getSecret} resolves the SPECIFIC key the envelope
 * names so a secret written before a key rotation still decrypts (Req 35.1);
 * {@link EncryptedSecretStore.getMetadata} reports non-secret
 * {@link SecretMetadata} without decrypting; and
 * {@link EncryptedSecretStore.encryptField} /
 * {@link EncryptedSecretStore.decryptField} expose the same envelope core as a
 * serialized-string pair for designated-sensitive-field encryption (Req 35.3).
 * The plaintext, the key material, and the raw ciphertext are never returned,
 * logged, or surfaced in a projection (Req 34.7). At-rest encryption is
 * AES-256-GCM (Req 35.2); TLS 1.3 in transit (Req 35.2) is enforced by the
 * deployment/transport layer (the Security_Gateway's TLS requirement).
 *
 * In production the {@link KeyProvider} is AWS KMS or Azure Key Vault and the
 * {@link SecretBackend} is AWS Secrets Manager or Azure Key Vault; the service is
 * pure orchestration over these injectable ports, so it is fully unit-testable
 * with the in-memory fakes in `./fakes.js` (an {@link InMemoryKeyProvider}
 * supporting rotation, a tenant-scoped {@link InMemorySecretBackend}, a
 * {@link FixedResidencyResolver}, and a {@link MutableEncryptionClock}). Those
 * fakes are intentionally NOT re-exported from this barrel — following the
 * established convention, the tests import them directly from `./fakes.js`.
 *
 * The typed errors ({@link UnknownEncryptionKeyError}, {@link DecryptionError},
 * {@link SecretNotFoundError}) project into the serializable
 * {@link import('@auxify/types').PlatformError} (Req 46.8). Names are
 * deliberately distinct from the Integration_Service's narrow `SecretStore` port
 * (this module's persistence seam is the {@link SecretBackend} and its service
 * the {@link EncryptedSecretStore}), and the clock is surfaced as
 * {@link EncryptionClock} / {@link systemEncryptionClock}, so a plain re-export
 * never collides at the package barrel.
 */

export {
  encrypt,
  decrypt,
  decryptToString,
  serializeEnvelope,
  deserializeEnvelope,
} from './crypto.js';

export {
  EncryptedSecretStore,
  type EncryptedSecretStoreOptions,
} from './encrypted-secret-store.js';

export {
  UnknownEncryptionKeyError,
  DecryptionError,
  SecretNotFoundError,
  UNKNOWN_ENCRYPTION_KEY_CODE,
  DECRYPTION_FAILED_CODE,
  SECRET_NOT_FOUND_CODE,
} from './errors.js';

export {
  systemEncryptionClock,
  ENCRYPTION_ALGORITHM,
  DATA_KEY_BYTES,
  GCM_IV_BYTES,
  GCM_AUTH_TAG_BYTES,
  ENVELOPE_VERSION,
  type EncryptionAlgorithm,
  type DataKey,
  type KeyProvider,
  type EncryptionEnvelope,
  type SecretReference,
  type SecretMetadata,
  type StoredSecretRecord,
  type SecretBackend,
  type ResidencyResolver,
  type EncryptionClock,
} from './types.js';
