/**
 * Unit tests for the API_Key_Manager (Req 21.1-21.7, 35.4).
 *
 * These exercise the full key lifecycle through {@link ApiKeyManager}:
 *   - create returns the raw key exactly once and stores ONLY its hash, plus a
 *     non-secret display prefix and metadata (Req 21.1, 35.4);
 *   - list/get return masked, prefix-only metadata that never exposes the
 *     secret or its hash (Req 21.2);
 *   - authenticate/verify accept a valid key and reject an unknown, revoked,
 *     expired, or rotated-away key (Req 21.3, 21.4, 21.5);
 *   - revoke immediately prevents subsequent authentication (Req 21.5);
 *   - rotate mints a replacement and invalidates the old key (Req 21.6);
 *   - rotateProviderCredentials delegates to the rotator and audits (Req 21.6);
 *   - recordUse stamps usage and enforces the configured rate limit (Req 21.7);
 *   - tenant isolation: a key in one Organization is invisible to another
 *     (Req 1.2, 1.4);
 *   - every mutation (create/rotate/revoke) is recorded in the Audit_Service
 *     (Req 37.1).
 *
 * The crypto helpers (real SHA-256 hashing, constant-time compare, key format)
 * are verified with the production {@link sha256KeyHasher}; the lifecycle tests
 * use the fast injective {@link FakeKeyHasher} for deterministic assertions.
 */

import { describe, expect, it } from 'vitest';

import { ApiKeyManager, toMaskedKey } from './api-key-manager.js';
import { ApiKeyNotFoundError, KeyRateLimitExceededError } from './errors.js';
import {
  API_KEY_PREFIX,
  constantTimeEqual,
  encodeBase62,
  extractPrefix,
  generateRawKey,
  sha256KeyHasher,
} from './key-crypto.js';
import {
  CapturingAuditRecorder,
  CapturingProviderCredentialRotator,
  FakeKeyHasher,
  InMemoryApiKeyStore,
  SequentialRandomSource,
  fixedClock,
  makeTenant,
  sequentialKeyIdGenerator,
} from './fakes.js';
import type { ApiKeyRecord } from './types.js';

/** Construct an ApiKeyManager wired with deterministic fakes. */
function makeManager(
  overrides: Partial<ConstructorParameters<typeof ApiKeyManager>[0]> = {},
): {
  manager: ApiKeyManager;
  store: InMemoryApiKeyStore;
  audit: CapturingAuditRecorder;
} {
  const store = overrides.store instanceof InMemoryApiKeyStore ? overrides.store : new InMemoryApiKeyStore();
  const audit =
    overrides.audit instanceof CapturingAuditRecorder ? overrides.audit : new CapturingAuditRecorder();
  const manager = new ApiKeyManager({
    store,
    audit,
    random: new SequentialRandomSource(),
    hasher: new FakeKeyHasher(),
    idGenerator: sequentialKeyIdGenerator(),
    now: fixedClock(),
    ...overrides,
  });
  return { manager, store, audit };
}

// ---------------------------------------------------------------------------
// create — raw key once, store only the hash (Req 21.1, 35.4)
// ---------------------------------------------------------------------------

describe('ApiKeyManager.create (Req 21.1, 35.4)', () => {
  it('returns the raw plaintext key exactly once and stores only its hash', async () => {
    // Use the REAL SHA-256 hasher so the "stored value is not the raw key"
    // assertion is meaningful (the fake hasher deliberately embeds the input).
    const { manager, store } = makeManager({ hasher: sha256KeyHasher });
    const ctx = makeTenant();

    const created = await manager.create(ctx, { name: 'ci-token' });

    // The raw key is returned once...
    expect(created.plaintext).toMatch(/^axk_/);
    // ...and the stored record holds ONLY the hash, never the raw secret.
    const stored = store.peek(created.key.id)!;
    expect(stored.hash).toBe(sha256KeyHasher.hash(created.plaintext));
    expect(stored.hash).not.toBe(created.plaintext);
    // No field of the stored record equals or embeds the raw key.
    expect(JSON.stringify(stored)).not.toContain(created.plaintext);
  });

  it('stores a non-secret display prefix matching the raw key, and metadata', async () => {
    const { manager, store } = makeManager();
    const ctx = makeTenant({ userId: 'admin-1' });

    const created = await manager.create(ctx, { name: 'svc', ownerId: 'svc-account' });
    const stored = store.peek(created.key.id)!;

    expect(stored.prefix).toBe(extractPrefix(created.plaintext));
    expect(created.plaintext.startsWith(stored.prefix)).toBe(true);
    expect(stored.name).toBe('svc');
    expect(stored.ownerId).toBe('svc-account');
    expect(stored.active).toBe(true);
    expect(stored.organizationId).toBe('org-1');
  });

  it('defaults the owner to the acting user and applies the default rate limit', async () => {
    const { manager } = makeManager();
    const created = await manager.create(makeTenant({ userId: 'user-9' }));
    expect(created.key.ownerId).toBe('user-9');
    expect(created.key.rateLimit).toEqual({ requestsPerWindow: 1000, windowSeconds: 60 });
  });

  it('mints distinct keys on successive creates', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const a = await manager.create(ctx);
    const b = await manager.create(ctx);
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.key.id).not.toBe(b.key.id);
  });

  it('rejects an invalid or past expiry (Req 21.4)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await expect(manager.create(ctx, { expiresAt: 'not-a-date' })).rejects.toThrow(
      /Invalid API key expiry/,
    );
    await expect(manager.create(ctx, { expiresAt: '2020-01-01T00:00:00.000Z' })).rejects.toThrow(
      /must be in the future/,
    );
  });
});

// ---------------------------------------------------------------------------
// list / get — masked, never exposes the secret (Req 21.2)
// ---------------------------------------------------------------------------

describe('ApiKeyManager.list / get (Req 21.2)', () => {
  it('lists keys in masked, prefix-only form without the secret or hash', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const created = await manager.create(ctx, { name: 'k1' });

    const listed = await manager.list(ctx);

    expect(listed).toHaveLength(1);
    const masked = listed[0]!;
    expect(masked.prefix).toBe(created.key.prefix);
    expect(masked.masked.startsWith(masked.prefix)).toBe(true);
    // A MaskedKey has no `hash` field and reveals no raw secret.
    expect((masked as unknown as Record<string, unknown>).hash).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain(created.plaintext);
  });

  it('narrows the listing by owner and by active-only', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const a = await manager.create(ctx, { ownerId: 'owner-a' });
    await manager.create(ctx, { ownerId: 'owner-b' });
    await manager.revoke(ctx, a.key.id);

    expect(await manager.list(ctx, { ownerId: 'owner-b' })).toHaveLength(1);
    const active = await manager.list(ctx, { activeOnly: true });
    expect(active.every((k) => k.active)).toBe(true);
    expect(active.find((k) => k.id === a.key.id)).toBeUndefined();
  });

  it('get throws ApiKeyNotFoundError for an unknown key', async () => {
    const { manager } = makeManager();
    await expect(manager.get(makeTenant(), 'missing')).rejects.toBeInstanceOf(ApiKeyNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// authenticate / verify (Req 21.3, 21.4, 21.5)
// ---------------------------------------------------------------------------

describe('ApiKeyManager.authenticate / verify (Req 21.3, 21.4, 21.5)', () => {
  it('accepts a valid, active, unexpired key', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const created = await manager.create(ctx);

    const result = await manager.authenticate(created.plaintext);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.key.id).toBe(created.key.id);
      expect(result.key.organizationId).toBe('org-1');
    }
  });

  it('rejects an unknown key without leaking existence', async () => {
    const { manager } = makeManager();
    await manager.create(makeTenant());
    const result = await manager.verify('axk_totally-unknown');
    expect(result).toEqual({ authenticated: false, reason: 'unknown' });
  });

  it('rejects a revoked key (Req 21.5)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const created = await manager.create(ctx);
    await manager.revoke(ctx, created.key.id);

    const result = await manager.authenticate(created.plaintext);
    expect(result).toEqual({ authenticated: false, reason: 'revoked' });
  });

  it('rejects an expired key (Req 21.4)', async () => {
    const store = new InMemoryApiKeyStore();
    const audit = new CapturingAuditRecorder();
    // Manager whose clock is AFTER the key's expiry.
    const manager = new ApiKeyManager({
      store,
      audit,
      random: new SequentialRandomSource(),
      hasher: new FakeKeyHasher(),
      idGenerator: sequentialKeyIdGenerator(),
      now: fixedClock('2026-06-01T00:00:00.000Z'),
    });
    const ctx = makeTenant();
    // Create with a clock-independent expiry already in the past relative to now.
    const created = await manager.create(ctx, { expiresAt: '2026-06-02T00:00:00.000Z' });
    // Advance: a new manager whose now() is past expiry.
    const later = new ApiKeyManager({
      store,
      audit,
      hasher: new FakeKeyHasher(),
      now: fixedClock('2026-06-03T00:00:00.000Z'),
    });
    const result = await later.authenticate(created.plaintext);
    expect(result).toEqual({ authenticated: false, reason: 'expired' });
  });

  it('rejects a key after it has been rotated away (Req 21.6)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const original = await manager.create(ctx);

    const rotated = await manager.rotate(ctx, original.key.id);

    // Old key no longer authenticates; the new one does.
    expect((await manager.authenticate(original.plaintext)).authenticated).toBe(false);
    expect((await manager.authenticate(rotated.plaintext)).authenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// revoke (Req 21.5)
// ---------------------------------------------------------------------------

describe('ApiKeyManager.revoke (Req 21.5)', () => {
  it('marks the key inactive with a revocation timestamp and prevents verification', async () => {
    const { manager, store } = makeManager();
    const ctx = makeTenant();
    const created = await manager.create(ctx);

    const masked = await manager.revoke(ctx, created.key.id);

    expect(masked.active).toBe(false);
    expect(masked.revokedAt).toBeDefined();
    expect(store.peek(created.key.id)!.active).toBe(false);
    expect((await manager.verify(created.plaintext)).authenticated).toBe(false);
  });

  it('throws ApiKeyNotFoundError when revoking an unknown key', async () => {
    const { manager } = makeManager();
    await expect(manager.revoke(makeTenant(), 'missing')).rejects.toBeInstanceOf(
      ApiKeyNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// rotate (Req 21.6)
// ---------------------------------------------------------------------------

describe('ApiKeyManager.rotate (Req 21.6)', () => {
  it('issues a new key, invalidates the old, and links them via rotatedFromId', async () => {
    const { manager, store } = makeManager();
    const ctx = makeTenant();
    const original = await manager.create(ctx, { name: 'prod', ownerId: 'owner-x' });

    const rotated = await manager.rotate(ctx, original.key.id);

    expect(rotated.plaintext).not.toBe(original.plaintext);
    expect(rotated.key.rotatedFromId).toBe(original.key.id);
    expect(rotated.key.ownerId).toBe('owner-x');
    expect(rotated.key.name).toBe('prod');
    // The old key is invalidated.
    expect(store.peek(original.key.id)!.active).toBe(false);
    // The new key is active.
    expect(store.peek(rotated.key.id)!.active).toBe(true);
  });

  it('applies overrides for name, rate limit, and expiry on the new key', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const original = await manager.create(ctx, { name: 'old' });

    const rotated = await manager.rotate(ctx, original.key.id, {
      name: 'new',
      rateLimit: { requestsPerWindow: 5, windowSeconds: 1 },
    });
    expect(rotated.key.name).toBe('new');
    expect(rotated.key.rateLimit).toEqual({ requestsPerWindow: 5, windowSeconds: 1 });
  });

  it('throws ApiKeyNotFoundError when rotating an unknown key', async () => {
    const { manager } = makeManager();
    await expect(manager.rotate(makeTenant(), 'missing')).rejects.toBeInstanceOf(
      ApiKeyNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// rotateProviderCredentials (Req 21.6)
// ---------------------------------------------------------------------------

describe('ApiKeyManager.rotateProviderCredentials (Req 21.6)', () => {
  it('delegates to the injected rotator and audits the rotation', async () => {
    const rotator = new CapturingProviderCredentialRotator();
    const { manager, audit } = makeManager({ providerCredentialRotator: rotator });
    const ctx = makeTenant({ organizationId: 'org-42' });

    await manager.rotateProviderCredentials(ctx);

    expect(rotator.rotated).toEqual(['org-42']);
    expect(audit.withAction('provider_credentials.rotate')).toHaveLength(1);
  });

  it('audits even when no rotator is injected', async () => {
    const { manager, audit } = makeManager();
    await manager.rotateProviderCredentials(makeTenant());
    expect(audit.withAction('provider_credentials.rotate')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// recordUse — usage timestamp + rate limit (Req 21.7)
// ---------------------------------------------------------------------------

describe('ApiKeyManager.recordUse (Req 21.7)', () => {
  it('records the usage timestamp and advances lastUsedAt', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const created = await manager.create(ctx);

    const updated = await manager.recordUse(ctx, created.key.id);
    expect(updated.lastUsedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('enforces the configured rate limit, rejecting an over-limit use', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const created = await manager.create(ctx, {
      rateLimit: { requestsPerWindow: 2, windowSeconds: 60 },
    });

    await manager.recordUse(ctx, created.key.id);
    await manager.recordUse(ctx, created.key.id);
    await expect(manager.recordUse(ctx, created.key.id)).rejects.toBeInstanceOf(
      KeyRateLimitExceededError,
    );
  });

  it('throws ApiKeyNotFoundError when recording use of an unknown key', async () => {
    const { manager } = makeManager();
    await expect(manager.recordUse(makeTenant(), 'missing')).rejects.toBeInstanceOf(
      ApiKeyNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// tenant isolation (Req 1.2, 1.4)
// ---------------------------------------------------------------------------

describe('ApiKeyManager tenant isolation (Req 1.2, 1.4)', () => {
  it('does not expose another Organization\u2019s keys in list/get/revoke', async () => {
    const { manager } = makeManager();
    const orgA = makeTenant({ organizationId: 'org-A', userId: 'a' });
    const orgB = makeTenant({ organizationId: 'org-B', userId: 'b' });
    const created = await manager.create(orgA);

    // org-B cannot see org-A's key.
    expect(await manager.list(orgB)).toHaveLength(0);
    await expect(manager.get(orgB, created.key.id)).rejects.toBeInstanceOf(ApiKeyNotFoundError);
    await expect(manager.revoke(orgB, created.key.id)).rejects.toBeInstanceOf(ApiKeyNotFoundError);

    // org-A still sees it.
    expect(await manager.list(orgA)).toHaveLength(1);
  });

  it('authenticate resolves a key across tenants by hash (pre-tenant lookup)', async () => {
    const { manager } = makeManager();
    const orgA = makeTenant({ organizationId: 'org-A' });
    const created = await manager.create(orgA);
    // Authentication has no tenant context; it resolves by hash and succeeds.
    const result = await manager.authenticate(created.plaintext);
    expect(result.authenticated).toBe(true);
    if (result.authenticated) expect(result.key.organizationId).toBe('org-A');
  });
});

// ---------------------------------------------------------------------------
// audit recording on create / rotate / revoke (Req 37.1)
// ---------------------------------------------------------------------------

describe('ApiKeyManager audit recording (Req 37.1)', () => {
  it('records create, rotate, and revoke as audit events without leaking the secret', async () => {
    const { manager, audit } = makeManager();
    const ctx = makeTenant();

    const created = await manager.create(ctx);
    const rotated = await manager.rotate(ctx, created.key.id);
    await manager.revoke(ctx, rotated.key.id);

    expect(audit.withAction('api_key.create')).toHaveLength(1);
    expect(audit.withAction('api_key.rotate')).toHaveLength(1);
    expect(audit.withAction('api_key.revoke')).toHaveLength(1);

    // No audit metadata anywhere carries a raw key value.
    const serialized = JSON.stringify(audit.recorded);
    expect(serialized).not.toContain(created.plaintext);
    expect(serialized).not.toContain(rotated.plaintext);
  });

  it('scopes audit events to the acting Organization and api_key resource type', async () => {
    const { manager, audit } = makeManager();
    const ctx = makeTenant({ organizationId: 'org-7' });
    await manager.create(ctx);
    const event = audit.last!;
    expect(event.ctx.organizationId).toBe('org-7');
    expect(event.event.resourceType).toBe('api_key');
  });
});

// ---------------------------------------------------------------------------
// crypto helpers (Req 21.1, 21.2, 35.4)
// ---------------------------------------------------------------------------

describe('key-crypto helpers (Req 21.1, 21.2, 35.4)', () => {
  it('sha256KeyHasher produces a stable 64-char hex digest distinct from the input', () => {
    const raw = 'axk_secret-value';
    const hash = sha256KeyHasher.hash(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(raw);
    expect(sha256KeyHasher.hash(raw)).toBe(hash);
  });

  it('generateRawKey produces a prefixed, high-entropy, unique key', () => {
    const random = new SequentialRandomSource();
    const a = generateRawKey(random);
    const b = generateRawKey(random);
    expect(a.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it('constantTimeEqual returns true only for byte-equal strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  it('encodeBase62 produces alphanumeric output and distinguishes inputs', () => {
    expect(encodeBase62(new Uint8Array([1, 2, 3]))).toMatch(/^[0-9A-Za-z]+$/);
    expect(encodeBase62(new Uint8Array([0]))).toMatch(/^[0-9A-Za-z]+$/);
    // Distinct byte sequences encode to distinct tokens (entropy preserved).
    expect(encodeBase62(new Uint8Array([1, 2, 3]))).not.toBe(
      encodeBase62(new Uint8Array([3, 2, 1])),
    );
  });

  it('toMaskedKey drops the hash from the projection', () => {
    const record: ApiKeyRecord = {
      id: 'k',
      organizationId: 'o',
      ownerId: 'u',
      name: 'n',
      prefix: 'axk_abc',
      hash: 'deadbeef',
      active: true,
      rateLimit: { requestsPerWindow: 1, windowSeconds: 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const masked = toMaskedKey(record);
    expect((masked as unknown as Record<string, unknown>).hash).toBeUndefined();
    expect(masked.masked.startsWith('axk_abc')).toBe(true);
  });
});
