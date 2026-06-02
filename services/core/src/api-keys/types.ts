/**
 * API_Key_Manager domain types and injectable ports (Req 21.1-21.7, 35.4).
 *
 * The API_Key_Manager issues, lists, verifies, rotates, and revokes the API
 * keys that grant programmatic access to the platform, scoped to a
 * tenant/principal. Its single most important security invariant is that it
 * stores ONLY a one-way hash of each key — never the raw secret — and returns
 * the raw key exactly once, at creation time (Req 21.1, 35.4).
 *
 * These are the camelCase domain shapes the service returns to its callers,
 * mirroring the design's `APIKey` entity (id, organizationId, ownerId, prefix,
 * hash, active, expiresAt, rateLimit, lastUsedAt). The service composes only the
 * narrow ports declared here — a tenant-scoped {@link ApiKeyStore}, the shared
 * {@link import('../audit/index.js').AuditRecorder}, an injectable
 * {@link KeyRandomSource} (a cryptographically-secure RNG), an injectable
 * {@link KeyHasher} (SHA-256 by default), a {@link KeyIdGenerator}, and an
 * optional {@link ProviderCredentialRotator} — so it stays pure orchestration
 * and fully unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * Tenancy: every management method takes the caller's {@link TenantContext} so
 * persistence is automatically confined to the Organization (Req 1.2, 1.4).
 * Authentication ({@link ApiKeyManager.authenticate}) is the deliberate
 * exception — it runs *before* a principal/tenant is established, so it resolves
 * a presented key to its owning Organization by hash through the store's
 * tenant-agnostic {@link ApiKeyStore.findByHash}.
 */

import type { TenantContext } from '@auxify/types';

export type { AuditRecorder, AuditEvent } from '../audit/index.js';

/**
 * A key's configured request rate limit (Req 21.7).
 *
 * Modelled as a fixed count per rolling window: at most {@link requestsPerWindow}
 * uses are permitted within any {@link windowSeconds}-second window. The
 * {@link ApiKeyManager.recordUse} method records each use and rejects a use that
 * would exceed this limit.
 */
export interface RateLimit {
  /** The maximum number of requests permitted within each rolling window. */
  requestsPerWindow: number;
  /** The rolling window length, in seconds. */
  windowSeconds: number;
}

/** The default rate limit applied to a key when the caller supplies none. */
export const DEFAULT_RATE_LIMIT: RateLimit = {
  requestsPerWindow: 1000,
  windowSeconds: 60,
};

/**
 * A persisted API key record — the design's `APIKey` (Req 21.1-21.7, 35.4).
 *
 * SECURITY: this record contains only the one-way {@link hash} of the key and a
 * non-secret {@link prefix} for display; the raw key is never stored anywhere
 * (Req 21.1, 35.4). A key is usable for authentication only while
 * {@link active} is `true`, it has not been revoked ({@link revokedAt} unset),
 * and it has not expired ({@link expiresAt} in the future) — Req 21.3-21.5.
 */
export interface ApiKeyRecord {
  /** The key's stable unique id (safe to display; not the secret). */
  id: string;
  /** The Organization that owns the key (its tenant scope). */
  organizationId: string;
  /** The principal the key was issued to / acts on behalf of. */
  ownerId: string;
  /** A human-friendly label for the key (metadata). */
  name: string;
  /** The non-secret display prefix that masked listings reveal (Req 21.2). */
  prefix: string;
  /** The SHA-256 hex hash of the full raw key. The raw key is NEVER stored (Req 21.1, 35.4). */
  hash: string;
  /** Whether the key is currently enabled; set `false` on revocation (Req 21.5). */
  active: boolean;
  /** The key's configured rate limit (Req 21.7). */
  rateLimit: RateLimit;
  /** The ISO-8601 creation timestamp. */
  createdAt: string;
  /** The ISO-8601 expiry; when set and in the past, the key is invalid (Req 21.4). */
  expiresAt?: string;
  /** The ISO-8601 revocation timestamp; when set, the key is rejected (Req 21.5). */
  revokedAt?: string;
  /** The ISO-8601 timestamp of the key's most recent recorded use (Req 21.7). */
  lastUsedAt?: string;
  /** When this key was minted by rotating an earlier key, that key's id (Req 21.6 rotation). */
  rotatedFromId?: string;
}

/**
 * The masked, secret-free projection of a key returned by listings and as the
 * metadata accompanying a creation/rotation (Req 21.2).
 *
 * It deliberately OMITS both the {@link ApiKeyRecord.hash} and the raw secret:
 * it reveals only the non-secret {@link prefix} (and a {@link masked} display
 * string derived from it), so a key can never be reconstructed from a listing.
 */
export interface MaskedKey {
  /** The key's stable id. */
  id: string;
  /** The owning Organization. */
  organizationId: string;
  /** The owning principal. */
  ownerId: string;
  /** The key's label. */
  name: string;
  /** The non-secret display prefix (Req 21.2). */
  prefix: string;
  /** A ready-to-render masked display string that reveals only the prefix (Req 21.2). */
  masked: string;
  /** Whether the key is currently enabled. */
  active: boolean;
  /** The key's rate limit (Req 21.7). */
  rateLimit: RateLimit;
  /** The ISO-8601 creation timestamp. */
  createdAt: string;
  /** The ISO-8601 expiry, when set (Req 21.4). */
  expiresAt?: string;
  /** The ISO-8601 revocation timestamp, when revoked (Req 21.5). */
  revokedAt?: string;
  /** The ISO-8601 last-used timestamp, when used (Req 21.7). */
  lastUsedAt?: string;
  /** The id of the key this one was rotated from, when applicable. */
  rotatedFromId?: string;
}

/** Fields a caller supplies to create a key (Req 21.1). */
export interface KeyInput {
  /** A human-friendly label for the key; defaults to an empty string. */
  name?: string;
  /** The principal the key is issued to; defaults to the acting `ctx.userId`. */
  ownerId?: string;
  /** The key's rate limit; defaults to {@link DEFAULT_RATE_LIMIT} (Req 21.7). */
  rateLimit?: RateLimit;
  /** An optional ISO-8601 expiry after which the key is invalid (Req 21.4). */
  expiresAt?: string;
  /** An explicit key id (defaults to a generated id). */
  id?: string;
}

/**
 * The one-time result of creating or rotating a key (Req 21.1).
 *
 * SECURITY: {@link plaintext} is the raw secret, returned EXACTLY ONCE here and
 * never persisted or returned again. The caller must convey it to the key owner
 * immediately; it is unrecoverable thereafter. {@link key} is the masked,
 * secret-free metadata safe to retain and display (Req 21.1, 21.2).
 */
export interface CreatedKey {
  /** The raw secret — returned ONCE, never stored, never logged (Req 21.1, 35.4). */
  plaintext: string;
  /** The masked, secret-free metadata for the created/rotated key. */
  key: MaskedKey;
}

/** Optional narrowing for {@link ApiKeyManager.list}. */
export interface KeyScope {
  /** Restrict the listing to a single owning principal. */
  ownerId?: string;
  /** When `true`, list only currently-active keys; otherwise list all (default). */
  activeOnly?: boolean;
}

/** Why authenticating a presented key failed (Req 21.3, 21.4, 21.5). */
export type KeyAuthFailureReason = 'unknown' | 'revoked' | 'inactive' | 'expired';

/**
 * The verdict from authenticating (verifying) a presented key
 * (Req 21.3, 21.4, 21.5).
 *
 * `authenticated: true` is returned only when the key is known, active, not
 * revoked, and unexpired, and it carries the masked key (whose
 * `organizationId`/`ownerId` identify the resolved principal). Every other case
 * is `authenticated: false` with a {@link KeyAuthFailureReason}, and never leaks
 * whether a similar key exists.
 */
export type KeyAuthResult =
  | { authenticated: true; key: MaskedKey }
  | { authenticated: false; reason: KeyAuthFailureReason };

/**
 * A cryptographically-secure source of random bytes for minting key secrets
 * (Req 21.1) — injectable so tests can supply a deterministic source.
 *
 * Production wires {@link import('./key-crypto.js').systemKeyRandomSource},
 * backed by `node:crypto`'s CSPRNG. A key's entropy comes entirely from this
 * source, so a non-cryptographic implementation must never be used outside
 * tests.
 */
export interface KeyRandomSource {
  /**
   * Return `byteLength` cryptographically-random bytes.
   *
   * @param byteLength The number of random bytes to produce.
   */
  randomBytes(byteLength: number): Uint8Array;
}

/**
 * A one-way hasher for key secrets (Req 21.1, 35.4) — injectable so tests can
 * substitute a deterministic hasher.
 *
 * The default {@link import('./key-crypto.js').sha256KeyHasher} computes a
 * SHA-256 hex digest. Because keys are 256-bit, high-entropy secrets, a fast
 * cryptographic digest is appropriate (unlike a low-entropy password, which
 * would require a slow KDF).
 */
export interface KeyHasher {
  /**
   * Compute the stored hash of a raw key.
   *
   * @param plaintext The raw key secret.
   * @returns The hex-encoded one-way hash to persist and compare against.
   */
  hash(plaintext: string): string;
}

/** Generates unique key ids (injectable for deterministic tests). */
export interface KeyIdGenerator {
  /** A unique key id. */
  id(): string;
}

/**
 * The seam that rotates an Organization's upstream AI-provider credentials
 * (Req 21.6).
 *
 * Modelled as a narrow port so the API_Key_Manager never hard-wires the secret
 * store / provider SDKs: production injects an implementation that mints fresh
 * provider credentials and persists them in the secret manager, while tests
 * substitute a capturing fake.
 */
export interface ProviderCredentialRotator {
  /**
   * Rotate the given Organization's provider credentials (Req 21.6).
   *
   * @param organizationId The Organization whose provider credentials to rotate.
   */
  rotate(organizationId: string): Promise<void>;
}

/**
 * The tenant-scoped persistence port for API keys (Req 21.1-21.7).
 *
 * Every management method takes the caller's {@link TenantContext} so
 * persistence is automatically scoped to the Organization (Req 1.2, 1.4); the
 * service never touches a backend directly. The concrete implementation is a
 * tenant-scoped repository over `api_keys`; tests substitute the in-memory
 * {@link import('./fakes.js').InMemoryApiKeyStore}.
 *
 * SECURITY: the store persists the {@link ApiKeyRecord} as given — which already
 * contains only the hash (Req 21.1, 35.4). {@link findByHash} is the single
 * tenant-agnostic method: authentication happens before a tenant context
 * exists, so a presented key is resolved to its owning record by its hash alone.
 */
export interface ApiKeyStore {
  /** Persist a new key record within the caller's Organization (Req 21.1). */
  insert(ctx: TenantContext, record: ApiKeyRecord): Promise<ApiKeyRecord>;
  /** Fetch a key by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<ApiKeyRecord | null>;
  /** List the caller's Organization's keys, optionally narrowed by {@link KeyScope} (Req 21.2). */
  listByScope(ctx: TenantContext, scope?: KeyScope): Promise<ApiKeyRecord[]>;
  /**
   * Set a key's `active` flag (and, when deactivating, its revocation
   * timestamp) within the caller's Organization (Req 21.5). Returns the updated
   * record, or `null` if no key matched.
   */
  setActive(
    ctx: TenantContext,
    id: string,
    active: boolean,
    revokedAt?: string,
  ): Promise<ApiKeyRecord | null>;
  /**
   * Record a use of a key: append the usage timestamp and advance `lastUsedAt`
   * within the caller's Organization (Req 21.7). Returns the updated record, or
   * `null` if no key matched.
   */
  recordUsage(ctx: TenantContext, id: string, at: string): Promise<ApiKeyRecord | null>;
  /**
   * Count the uses of a key recorded at or after `sinceIso`, within the
   * caller's Organization, for rate-limit enforcement (Req 21.7).
   */
  countUsagesSince(ctx: TenantContext, id: string, sinceIso: string): Promise<number>;
  /**
   * Resolve a key by its stored hash, across every Organization, for
   * authentication (Req 21.3) — the one tenant-agnostic lookup, since
   * authentication precedes the establishment of a tenant context. Returns the
   * matching record, or `null`.
   */
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
}
