/**
 * API_Key_Manager (Req 21.1-21.7, 35.4).
 *
 * The service that issues, lists, verifies, rotates, and revokes the API keys
 * granting programmatic access to the platform, scoped to a tenant/principal.
 * Its defining security property is that it stores ONLY a one-way SHA-256 hash
 * of each key — never the raw secret — and returns the raw key EXACTLY ONCE, at
 * creation time (Req 21.1, 35.4).
 *
 * Surface:
 *   - {@link ApiKeyManager} — the service; one method per acceptance criterion:
 *     `create` returns the raw key once and stores only its hash (Req 21.1);
 *     `list`/`get` return masked, prefix-only metadata (Req 21.2);
 *     `authenticate`/`verify` accept a key only while active, unexpired, and
 *     unrevoked, comparing hashes in constant time (Req 21.3, 21.4, 21.5);
 *     `revoke` immediately rejects subsequent authentication (Req 21.5);
 *     `rotate` mints a replacement and invalidates the old key, and
 *     `rotateProviderCredentials` rotates an Organization's provider credentials
 *     (Req 21.6); `recordUse` records the usage timestamp and enforces the key's
 *     rate limit (Req 21.7). Every mutation is recorded through the injected
 *     {@link AuditRecorder} (Req 37.1).
 *   - {@link toMaskedKey} — the pure record→masked projection that drops the
 *     hash so it never crosses the service boundary (Req 21.2).
 *   - The injectable ports the service composes — {@link ApiKeyStore},
 *     {@link KeyRandomSource}, {@link KeyHasher}, {@link KeyIdGenerator},
 *     {@link ProviderCredentialRotator} — and the production crypto primitives
 *     {@link systemKeyRandomSource} / {@link sha256KeyHasher}, the key
 *     format/masking helpers ({@link API_KEY_PREFIX}, {@link generateRawKey},
 *     {@link extractPrefix}, {@link maskKeyPrefix}, {@link encodeBase62}), and
 *     the {@link constantTimeEqual} comparator.
 *   - Domain types ({@link ApiKeyRecord}, {@link MaskedKey}, {@link KeyInput},
 *     {@link CreatedKey}, {@link KeyScope}, {@link KeyAuthResult},
 *     {@link RateLimit}, {@link DEFAULT_RATE_LIMIT}) and the typed errors
 *     ({@link ApiKeyNotFoundError}, {@link KeyRateLimitExceededError},
 *     {@link InvalidKeyExpiryError}).
 *
 * The in-memory test fakes (an {@link ApiKeyStore}, a capturing audit recorder,
 * a deterministic RNG and hasher, builders) live in `./fakes.js` and are
 * intentionally NOT re-exported from this barrel — they would collide with the
 * equally-named audit-recorder fakes of sibling modules at the package barrel.
 * Following the established convention, the tests import them directly from
 * `./fakes.js`.
 */

export {
  ApiKeyManager,
  toMaskedKey,
  type ApiKeyManagerOptions,
} from './api-key-manager.js';

export {
  API_KEY_PREFIX,
  KEY_SECRET_BYTES,
  KEY_DISPLAY_PREFIX_LENGTH,
  systemKeyRandomSource,
  sha256KeyHasher,
  generateRawKey,
  extractPrefix,
  maskKeyPrefix,
  encodeBase62,
  constantTimeEqual,
} from './key-crypto.js';

export {
  ApiKeyNotFoundError,
  KeyRateLimitExceededError,
  InvalidKeyExpiryError,
  API_KEY_NOT_FOUND_CODE,
  KEY_RATE_LIMIT_EXCEEDED_CODE,
  INVALID_KEY_EXPIRY_CODE,
} from './errors.js';

export {
  DEFAULT_RATE_LIMIT,
  type RateLimit,
  type ApiKeyRecord,
  type MaskedKey,
  type KeyInput,
  type CreatedKey,
  type KeyScope,
  type KeyAuthResult,
  type KeyAuthFailureReason,
  type KeyRandomSource,
  type KeyHasher,
  type KeyIdGenerator,
  type ProviderCredentialRotator,
  type ApiKeyStore,
} from './types.js';
