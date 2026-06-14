/**
 * The API_Key_Manager — issues, lists, verifies, rotates, and revokes the API
 * keys that grant programmatic platform access (Req 21.1-21.7, 35.4).
 *
 * It is the single place that:
 *   - mints a key from a cryptographically-secure random source, returns the
 *     raw secret EXACTLY ONCE, and persists only its one-way hash plus a
 *     non-secret display prefix and metadata (Req 21.1, 35.4);
 *   - lists keys in masked, prefix-only form that never exposes the secret or
 *     its hash (Req 21.2);
 *   - authenticates a presented key only while it is active, unexpired, and not
 *     revoked, comparing hashes in constant time (Req 21.3, 21.4, 21.5);
 *   - revokes a key so subsequent authentication is immediately rejected
 *     (Req 21.5);
 *   - rotates a key by minting a replacement and invalidating the old one, and
 *     rotates an Organization's provider credentials on demand (Req 21.6);
 *   - records each use with its timestamp and enforces the key's configured
 *     rate limit (Req 21.7).
 *
 * Every mutation — create, rotate, revoke, and provider-credential rotation — is
 * recorded through the injected {@link AuditRecorder} port (Req 37.1). All
 * dependencies are injected so the manager is pure orchestration and fully
 * unit-testable with the fakes in `./fakes.js`: a tenant-scoped
 * {@link ApiKeyStore}, the {@link AuditRecorder}, a {@link KeyRandomSource}
 * (CSPRNG), a {@link KeyHasher} (SHA-256), a {@link KeyIdGenerator}, a clock,
 * and an optional {@link ProviderCredentialRotator}.
 *
 * Tenant isolation is inherited from the store: every management method takes a
 * {@link TenantContext} and the store confines the operation to the caller's
 * Organization (Req 1.2, 1.4). Authentication is the deliberate exception — it
 * runs before a tenant context exists and resolves a presented key by hash
 * through {@link ApiKeyStore.findByHash}.
 *
 * SECURITY: a raw key value is never persisted, logged, or echoed. It exists
 * only transiently inside {@link create}/{@link rotate} and is handed back to
 * the caller once via {@link CreatedKey.plaintext}; audit metadata and errors
 * carry only the key id and non-secret prefix.
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import { ApiKeyNotFoundError, InvalidKeyExpiryError, KeyRateLimitExceededError } from './errors.js';
import {
  constantTimeEqual,
  extractPrefix,
  generateRawKey,
  maskKeyPrefix,
  sha256KeyHasher,
  systemKeyRandomSource,
} from './key-crypto.js';
import {
  DEFAULT_RATE_LIMIT,
  type ApiKeyRecord,
  type ApiKeyStore,
  type AuditRecorder,
  type CreatedKey,
  type KeyAuthResult,
  type KeyHasher,
  type KeyIdGenerator,
  type KeyInput,
  type KeyRandomSource,
  type KeyScope,
  type MaskedKey,
  type ProviderCredentialRotator,
} from './types.js';

/** Default key-id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: KeyIdGenerator = {
  id: () => `key_${randomUUID()}`,
};

/** Construction dependencies for the {@link ApiKeyManager} (all injectable). */
export interface ApiKeyManagerOptions {
  /** The tenant-scoped key store (a repository in production, a fake in tests). */
  store: ApiKeyStore;
  /** The append-only audit sink; every key mutation is recorded through it (Req 37.1). */
  audit: AuditRecorder;
  /**
   * The cryptographically-secure random source for minting secrets (Req 21.1);
   * defaults to {@link systemKeyRandomSource}.
   */
  random?: KeyRandomSource;
  /** The one-way key hasher (Req 21.1, 35.4); defaults to {@link sha256KeyHasher}. */
  hasher?: KeyHasher;
  /** The key-id generator; defaults to `crypto.randomUUID`. */
  idGenerator?: KeyIdGenerator;
  /** The clock for timestamps and expiry/rate-limit checks; defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * The optional provider-credential rotation seam (Req 21.6). When omitted,
   * {@link ApiKeyManager.rotateProviderCredentials} records the rotation intent
   * in the Audit_Service but performs no external rotation.
   */
  providerCredentialRotator?: ProviderCredentialRotator;
}

/**
 * Project a stored {@link ApiKeyRecord} into its masked, secret-free
 * {@link MaskedKey} form (Req 21.2). The {@link ApiKeyRecord.hash} is dropped
 * here, so the hash never crosses the service boundary.
 */
export function toMaskedKey(record: ApiKeyRecord): MaskedKey {
  const masked: MaskedKey = {
    id: record.id,
    organizationId: record.organizationId,
    ownerId: record.ownerId,
    name: record.name,
    prefix: record.prefix,
    masked: maskKeyPrefix(record.prefix),
    active: record.active,
    rateLimit: record.rateLimit,
    createdAt: record.createdAt,
  };
  if (record.expiresAt !== undefined) masked.expiresAt = record.expiresAt;
  if (record.revokedAt !== undefined) masked.revokedAt = record.revokedAt;
  if (record.lastUsedAt !== undefined) masked.lastUsedAt = record.lastUsedAt;
  if (record.rotatedFromId !== undefined) masked.rotatedFromId = record.rotatedFromId;
  return masked;
}

/**
 * The API_Key_Manager. Construct once with its injected dependencies, then call
 * its lifecycle methods with the acting principal's {@link TenantContext} (all
 * but {@link authenticate}, which precedes the tenant context).
 */
export class ApiKeyManager {
  private readonly store: ApiKeyStore;
  private readonly audit: AuditRecorder;
  private readonly random: KeyRandomSource;
  private readonly hasher: KeyHasher;
  private readonly ids: KeyIdGenerator;
  private readonly now: () => Date;
  private readonly providerCredentialRotator: ProviderCredentialRotator | undefined;

  constructor(options: ApiKeyManagerOptions) {
    this.store = options.store;
    this.audit = options.audit;
    this.random = options.random ?? systemKeyRandomSource;
    this.hasher = options.hasher ?? sha256KeyHasher;
    this.ids = options.idGenerator ?? defaultIdGenerator;
    this.now = options.now ?? (() => new Date());
    this.providerCredentialRotator = options.providerCredentialRotator;
  }

  /**
   * Create a new API key (Req 21.1, 21.2, 35.4).
   *
   * Mints a high-entropy raw key from the injected CSPRNG, persists ONLY its
   * SHA-256 hash plus a non-secret display prefix and metadata, records a
   * `api_key.create` audit event, and returns the raw key EXACTLY ONCE in
   * {@link CreatedKey.plaintext} alongside the masked metadata. The raw key is
   * never stored and cannot be retrieved again.
   *
   * @param ctx The acting principal's tenant context (scopes the new key).
   * @param input Optional name, owner, rate limit, and expiry (Req 21.4, 21.7).
   * @returns The one-time {@link CreatedKey} (raw secret + masked metadata).
   * @throws InvalidKeyExpiryError when `input.expiresAt` is unparseable or past.
   */
  async create(ctx: TenantContext, input: KeyInput = {}): Promise<CreatedKey> {
    const expiresAt = this.normalizeExpiry(input.expiresAt);
    const rawKey = generateRawKey(this.random);
    const record: ApiKeyRecord = {
      id: input.id ?? this.ids.id(),
      organizationId: ctx.organizationId,
      ownerId: input.ownerId ?? ctx.userId,
      name: input.name ?? '',
      prefix: extractPrefix(rawKey),
      hash: this.hasher.hash(rawKey),
      active: true,
      rateLimit: input.rateLimit ?? DEFAULT_RATE_LIMIT,
      createdAt: this.now().toISOString(),
    };
    if (expiresAt !== undefined) record.expiresAt = expiresAt;

    const stored = await this.store.insert(ctx, record);
    await this.audit.record(ctx, {
      action: 'api_key.create',
      resourceType: 'api_key',
      resourceId: stored.id,
      metadata: { prefix: stored.prefix, ownerId: stored.ownerId },
    });

    // SECURITY: the raw key is returned here exactly once and never again.
    return { plaintext: rawKey, key: toMaskedKey(stored) };
  }

  /**
   * List the caller's Organization's keys in masked, prefix-only form
   * (Req 21.2). The returned items never include the secret or its hash.
   *
   * @param ctx The acting principal's tenant context.
   * @param scope Optional narrowing by owner and/or active-only.
   * @returns The masked keys.
   */
  async list(ctx: TenantContext, scope?: KeyScope): Promise<MaskedKey[]> {
    const records = await this.store.listByScope(ctx, scope);
    return records.map(toMaskedKey);
  }

  /**
   * Fetch a single key's masked metadata by id within the caller's Organization
   * (Req 21.2).
   *
   * @throws ApiKeyNotFoundError when no key matches in the tenant.
   */
  async get(ctx: TenantContext, keyId: string): Promise<MaskedKey> {
    const record = await this.store.findById(ctx, keyId);
    if (record === null) throw new ApiKeyNotFoundError(keyId);
    return toMaskedKey(record);
  }

  /**
   * Authenticate (verify) a presented raw key (Req 21.3, 21.4, 21.5).
   *
   * Hashes the presented key and resolves the matching stored record by hash,
   * comparing in constant time, then returns `authenticated: true` only when the
   * key is known, active, not revoked, and unexpired. Every other case returns
   * `authenticated: false` with a reason and never reveals whether a similar key
   * exists. This method does not mutate state — recording the use and enforcing
   * the rate limit is {@link recordUse}'s job (Req 21.7).
   *
   * @param presented The raw key string presented by the client.
   * @returns The structured {@link KeyAuthResult}.
   */
  async authenticate(presented: string): Promise<KeyAuthResult> {
    const presentedHash = this.hasher.hash(presented);
    const record = await this.store.findByHash(presentedHash);
    if (record === null || !constantTimeEqual(record.hash, presentedHash)) {
      return { authenticated: false, reason: 'unknown' };
    }
    if (record.revokedAt !== undefined) {
      return { authenticated: false, reason: 'revoked' };
    }
    if (!record.active) {
      return { authenticated: false, reason: 'inactive' };
    }
    if (this.isExpired(record)) {
      return { authenticated: false, reason: 'expired' };
    }
    return { authenticated: true, key: toMaskedKey(record) };
  }

  /**
   * Verify a presented raw key — an alias for {@link authenticate} matching the
   * "verify a stored, non-revoked record" lifecycle vocabulary.
   */
  async verify(presented: string): Promise<KeyAuthResult> {
    return this.authenticate(presented);
  }

  /**
   * Revoke a key so subsequent authentication is immediately rejected
   * (Req 21.5).
   *
   * Marks the key inactive and stamps its revocation time, then records a
   * `api_key.revoke` audit event. A subsequent {@link authenticate} of the same
   * key fails with reason `revoked`.
   *
   * @param ctx The acting principal's tenant context.
   * @param keyId The key to revoke.
   * @returns The revoked key's masked metadata.
   * @throws ApiKeyNotFoundError when no key matches in the tenant.
   */
  async revoke(ctx: TenantContext, keyId: string): Promise<MaskedKey> {
    const revokedAt = this.now().toISOString();
    const updated = await this.store.setActive(ctx, keyId, false, revokedAt);
    if (updated === null) throw new ApiKeyNotFoundError(keyId);
    await this.audit.record(ctx, {
      action: 'api_key.revoke',
      resourceType: 'api_key',
      resourceId: keyId,
      metadata: { prefix: updated.prefix, ownerId: updated.ownerId },
    });
    return toMaskedKey(updated);
  }

  /**
   * Rotate a key: mint a fresh replacement and invalidate the old one
   * (Req 21.6).
   *
   * The new key inherits the old key's owner, name, and rate limit (and expiry,
   * unless overridden) and records its origin via `rotatedFromId`; the old key
   * is revoked so it can no longer authenticate. Records a `api_key.rotate`
   * audit event and returns the new key's raw secret EXACTLY ONCE.
   *
   * @param ctx The acting principal's tenant context.
   * @param keyId The key to rotate.
   * @param overrides Optional name/rate-limit/expiry overrides for the new key.
   * @returns The one-time {@link CreatedKey} for the replacement.
   * @throws ApiKeyNotFoundError when no key matches in the tenant.
   */
  async rotate(
    ctx: TenantContext,
    keyId: string,
    overrides: Pick<KeyInput, 'name' | 'rateLimit' | 'expiresAt'> = {},
  ): Promise<CreatedKey> {
    const existing = await this.store.findById(ctx, keyId);
    if (existing === null) throw new ApiKeyNotFoundError(keyId);

    const expiresAt =
      overrides.expiresAt !== undefined
        ? this.normalizeExpiry(overrides.expiresAt)
        : existing.expiresAt;
    const rawKey = generateRawKey(this.random);
    const replacement: ApiKeyRecord = {
      id: this.ids.id(),
      organizationId: ctx.organizationId,
      ownerId: existing.ownerId,
      name: overrides.name ?? existing.name,
      prefix: extractPrefix(rawKey),
      hash: this.hasher.hash(rawKey),
      active: true,
      rateLimit: overrides.rateLimit ?? existing.rateLimit,
      createdAt: this.now().toISOString(),
      rotatedFromId: existing.id,
    };
    if (expiresAt !== undefined) replacement.expiresAt = expiresAt;

    const stored = await this.store.insert(ctx, replacement);
    // Invalidate the old key so it can no longer authenticate (Req 21.5, 21.6).
    await this.store.setActive(ctx, existing.id, false, this.now().toISOString());

    await this.audit.record(ctx, {
      action: 'api_key.rotate',
      resourceType: 'api_key',
      resourceId: stored.id,
      metadata: {
        prefix: stored.prefix,
        ownerId: stored.ownerId,
        rotatedFromId: existing.id,
      },
    });

    // SECURITY: the replacement raw key is returned here exactly once.
    return { plaintext: rawKey, key: toMaskedKey(stored) };
  }

  /**
   * Rotate the Organization's upstream AI-provider credentials (Req 21.6).
   *
   * Delegates to the injected {@link ProviderCredentialRotator} when present
   * (production mints fresh provider credentials and persists them in the secret
   * manager) and records a `provider_credentials.rotate` audit event. The
   * platform schedules this at least every 90 days to satisfy Req 21.6.
   *
   * @param ctx The acting principal's tenant context.
   */
  async rotateProviderCredentials(ctx: TenantContext): Promise<void> {
    if (this.providerCredentialRotator !== undefined) {
      await this.providerCredentialRotator.rotate(ctx.organizationId);
    }
    await this.audit.record(ctx, {
      action: 'provider_credentials.rotate',
      resourceType: 'organization',
      resourceId: ctx.organizationId,
      metadata: { rotatedAt: this.now().toISOString() },
    });
  }

  /**
   * Record a use of a key and enforce its configured rate limit (Req 21.7).
   *
   * Counts the key's uses within its rolling rate-limit window; if recording
   * another would exceed {@link RateLimit.requestsPerWindow}, it rejects with a
   * {@link KeyRateLimitExceededError} and records nothing. Otherwise it appends
   * the usage timestamp and advances `lastUsedAt`.
   *
   * @param ctx The acting principal's tenant context.
   * @param keyId The key that was used.
   * @returns The updated masked key (with the advanced `lastUsedAt`).
   * @throws ApiKeyNotFoundError when no key matches in the tenant.
   * @throws KeyRateLimitExceededError when the use would exceed the limit.
   */
  async recordUse(ctx: TenantContext, keyId: string): Promise<MaskedKey> {
    const record = await this.store.findById(ctx, keyId);
    if (record === null) throw new ApiKeyNotFoundError(keyId);

    const now = this.now();
    const windowStart = new Date(
      now.getTime() - record.rateLimit.windowSeconds * 1000,
    ).toISOString();
    const usedInWindow = await this.store.countUsagesSince(ctx, keyId, windowStart);
    if (usedInWindow >= record.rateLimit.requestsPerWindow) {
      throw new KeyRateLimitExceededError(keyId, record.rateLimit);
    }

    const updated = await this.store.recordUsage(ctx, keyId, now.toISOString());
    if (updated === null) throw new ApiKeyNotFoundError(keyId);
    return toMaskedKey(updated);
  }

  /** Whether a record has an expiry that is at or before "now" (Req 21.4). */
  private isExpired(record: ApiKeyRecord): boolean {
    if (record.expiresAt === undefined) return false;
    return new Date(record.expiresAt).getTime() <= this.now().getTime();
  }

  /**
   * Validate and normalize a supplied expiry (Req 21.4): it must be a valid
   * ISO-8601 timestamp strictly in the future.
   */
  private normalizeExpiry(expiresAt: string | undefined): string | undefined {
    if (expiresAt === undefined) return undefined;
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidKeyExpiryError(expiresAt, 'not a valid ISO-8601 timestamp');
    }
    if (parsed.getTime() <= this.now().getTime()) {
      throw new InvalidKeyExpiryError(expiresAt, 'expiry must be in the future');
    }
    return parsed.toISOString();
  }
}
