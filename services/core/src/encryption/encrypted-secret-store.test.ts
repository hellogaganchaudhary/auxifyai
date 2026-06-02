/**
 * Unit tests for the {@link EncryptedSecretStore} (Req 34.7, 35.1, 35.2, 35.3,
 * 35.5).
 *
 * These drive the REAL store over the in-memory fakes (imported directly from
 * `./fakes.js`, never the barrel) with a hand-advanced
 * {@link MutableEncryptionClock} as the only source of time, covering:
 *
 *   - put → get round-trips a secret to its plaintext (Req 35.1, 35.3);
 *   - the persisted record holds only a ciphertext envelope, never the plaintext
 *     (Req 34.7);
 *   - `getMetadata` reports non-secret metadata without decrypting (Req 34.7);
 *   - key rotation: a secret written under the old active key still decrypts
 *     after the active key rotates (Req 35.1);
 *   - tenant scoping: one Organization cannot read another's secret, and the AAD
 *     binding fails closed on a cross-tenant or cross-reference replay (Req 1.4,
 *     35.3);
 *   - residency: the resolved region is stamped onto the stored record (Req 35.5);
 *   - `SecretNotFoundError` for a missing reference (Req 34.7);
 *   - field-level encryption round-trips and is rotation-safe (Req 35.3).
 */

import { describe, expect, it } from 'vitest';

import { EncryptedSecretStore } from './encrypted-secret-store.js';
import { DecryptionError, SecretNotFoundError } from './errors.js';
import {
  FixedResidencyResolver,
  InMemoryKeyProvider,
  InMemorySecretBackend,
  MutableEncryptionClock,
  makeDataKey,
  makeTenantContext,
} from './fakes.js';

const START = Date.UTC(2026, 0, 1, 0, 0, 0);

interface Harness {
  store: EncryptedSecretStore;
  keys: InMemoryKeyProvider;
  backend: InMemorySecretBackend;
  residency: FixedResidencyResolver;
  clock: MutableEncryptionClock;
}

function makeHarness(options: { region?: string } = {}): Harness {
  const keys = new InMemoryKeyProvider(makeDataKey('key-1'));
  const backend = new InMemorySecretBackend();
  const residency = new FixedResidencyResolver(options.region);
  const clock = new MutableEncryptionClock(START);
  const store = new EncryptedSecretStore({ keys, backend, residency, clock });
  return { store, keys, backend, residency, clock };
}

describe('EncryptedSecretStore.putSecret / getSecret (Req 34.7, 35.1, 35.3)', () => {
  it('round-trips a secret to its plaintext', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();

    const metadata = await h.store.putSecret(ctx, 'db-password', 'p@ssw0rd!');

    expect(metadata.reference).toBe('db-password');
    expect(metadata.organizationId).toBe('org-1');
    expect(metadata.keyId).toBe('key-1');
    expect(await h.store.getSecret(ctx, 'db-password')).toBe('p@ssw0rd!');
  });

  it('never returns the plaintext from putSecret (metadata only, Req 34.7)', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();

    const metadata = await h.store.putSecret(ctx, 'token', 'secret-token-value');

    expect(JSON.stringify(metadata)).not.toContain('secret-token-value');
  });

  it('persists only a ciphertext envelope, never the plaintext (Req 34.7)', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();

    await h.store.putSecret(ctx, 'api-key', 'plaintext-marker-123');

    const record = h.backend.peek('org-1', 'api-key');
    expect(record).toBeDefined();
    expect(record?.envelope).not.toContain('plaintext-marker-123');
    expect(JSON.stringify(record)).not.toContain('plaintext-marker-123');
  });

  it('preserves createdAt and advances updatedAt when replacing a secret', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();

    const first = await h.store.putSecret(ctx, 'rotating', 'v1');
    h.clock.advance(60_000);
    const second = await h.store.putSecret(ctx, 'rotating', 'v2');

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(await h.store.getSecret(ctx, 'rotating')).toBe('v2');
  });

  it('does not leak the plaintext or key material from describe()/toString() (Req 34.7)', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();
    await h.store.putSecret(ctx, 'ref', 'leak-check-value');

    expect(h.store.toString()).not.toContain('leak-check-value');
    expect(h.store.describe()).toContain('EncryptedSecretStore');
  });
});

describe('EncryptedSecretStore.getMetadata (Req 34.7)', () => {
  it('returns non-secret metadata without decrypting', async () => {
    const h = makeHarness({ region: 'eu-west-1' });
    const ctx = makeTenantContext();
    await h.store.putSecret(ctx, 'ref', 'value');

    const metadata = await h.store.getMetadata(ctx, 'ref');

    expect(metadata).not.toBeNull();
    expect(metadata?.reference).toBe('ref');
    expect(metadata?.keyId).toBe('key-1');
    expect(metadata?.region).toBe('eu-west-1');
    expect(JSON.stringify(metadata)).not.toContain('value');
  });

  it('returns null for an absent reference', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();
    expect(await h.store.getMetadata(ctx, 'missing')).toBeNull();
  });
});

describe('EncryptedSecretStore key rotation (Req 35.1)', () => {
  it('still decrypts a secret encrypted under the old active key after rotation', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();

    // Encrypt under key-1 ...
    const before = await h.store.putSecret(ctx, 'legacy', 'old-key-value');
    expect(before.keyId).toBe('key-1');

    // ... rotate the active key to key-2 (key-1 is retained) ...
    h.keys.rotateTo(makeDataKey('key-2'));

    // ... a NEW secret uses key-2 ...
    const after = await h.store.putSecret(ctx, 'fresh', 'new-key-value');
    expect(after.keyId).toBe('key-2');

    // ... and the legacy secret still decrypts via its named key-1.
    expect(await h.store.getSecret(ctx, 'legacy')).toBe('old-key-value');
    expect(await h.store.getSecret(ctx, 'fresh')).toBe('new-key-value');
  });
});

describe('EncryptedSecretStore tenant scoping (Req 1.4, 35.3)', () => {
  it('one Organization cannot read another\u2019s secret', async () => {
    const h = makeHarness();
    const orgA = makeTenantContext({ organizationId: 'org-a', userId: 'a' });
    const orgB = makeTenantContext({ organizationId: 'org-b', userId: 'b' });

    await h.store.putSecret(orgA, 'shared-ref', 'org-a-secret');

    // Org B sees no secret under the same reference ...
    expect(await h.store.getMetadata(orgB, 'shared-ref')).toBeNull();
    await expect(h.store.getSecret(orgB, 'shared-ref')).rejects.toBeInstanceOf(SecretNotFoundError);

    // ... and Org A still reads its own.
    expect(await h.store.getSecret(orgA, 'shared-ref')).toBe('org-a-secret');
  });

  it('fails closed on a cross-tenant envelope replay (AAD binding, Req 35.3)', async () => {
    const h = makeHarness();
    const orgA = makeTenantContext({ organizationId: 'org-a', userId: 'a' });
    const orgB = makeTenantContext({ organizationId: 'org-b', userId: 'b' });

    await h.store.putSecret(orgA, 'ref', 'org-a-secret');

    // Copy Org A's ciphertext record under Org B's tenant key, same reference.
    const stolen = h.backend.peek('org-a', 'ref');
    expect(stolen).toBeDefined();
    await h.backend.put(orgB, { ...stolen!, organizationId: 'org-b' });

    // The AAD binds (organizationId, reference), so decryption under Org B fails closed.
    await expect(h.store.getSecret(orgB, 'ref')).rejects.toBeInstanceOf(DecryptionError);
  });

  it('fails closed on a cross-reference envelope replay (AAD binding, Req 35.3)', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();

    await h.store.putSecret(ctx, 'ref-1', 'value');

    // Copy the ciphertext under a different reference within the same tenant.
    const record = h.backend.peek('org-1', 'ref-1');
    await h.backend.put(ctx, { ...record!, reference: 'ref-2' });

    await expect(h.store.getSecret(ctx, 'ref-2')).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe('EncryptedSecretStore residency (Req 35.5)', () => {
  it('stamps the resolved residency region onto the stored record', async () => {
    const h = makeHarness({ region: 'ap-southeast-2' });
    const ctx = makeTenantContext();

    const metadata = await h.store.putSecret(ctx, 'ref', 'value');

    expect(metadata.region).toBe('ap-southeast-2');
    expect(h.backend.peek('org-1', 'ref')?.region).toBe('ap-southeast-2');
  });

  it('omits the region when no residency constraint applies', async () => {
    const keys = new InMemoryKeyProvider(makeDataKey('key-1'));
    const backend = new InMemorySecretBackend();
    const clock = new MutableEncryptionClock(START);
    // No residency resolver configured at all.
    const store = new EncryptedSecretStore({ keys, backend, clock });
    const ctx = makeTenantContext();

    const metadata = await store.putSecret(ctx, 'ref', 'value');

    expect(metadata.region).toBeUndefined();
    expect(backend.peek('org-1', 'ref')?.region).toBeUndefined();
  });
});

describe('EncryptedSecretStore.deleteSecret / not-found (Req 34.7)', () => {
  it('throws SecretNotFoundError when reading a missing reference', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();
    await expect(h.store.getSecret(ctx, 'nope')).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('removes a stored secret so a subsequent read fails closed', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();
    await h.store.putSecret(ctx, 'ref', 'value');

    await h.store.deleteSecret(ctx, 'ref');

    expect(await h.store.getMetadata(ctx, 'ref')).toBeNull();
    await expect(h.store.getSecret(ctx, 'ref')).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it('delete is a no-op for an absent reference', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext();
    await expect(h.store.deleteSecret(ctx, 'absent')).resolves.toBeUndefined();
  });
});

describe('EncryptedSecretStore field-level encryption (Req 35.3)', () => {
  it('round-trips a designated sensitive field value', async () => {
    const h = makeHarness();
    const envelope = await h.store.encryptField('ssn-123-45-6789');
    expect(envelope).not.toContain('ssn-123-45-6789');
    expect(await h.store.decryptField(envelope)).toBe('ssn-123-45-6789');
  });

  it('binds optional AAD and fails closed on a mismatch', async () => {
    const h = makeHarness();
    const aad = new TextEncoder().encode('users.ssn');
    const envelope = await h.store.encryptField('field-value', aad);

    expect(await h.store.decryptField(envelope, aad)).toBe('field-value');
    await expect(h.store.decryptField(envelope)).rejects.toBeInstanceOf(DecryptionError);
  });

  it('decrypts a field encrypted before a key rotation (Req 35.1)', async () => {
    const h = makeHarness();
    const envelope = await h.store.encryptField('pre-rotation');
    h.keys.rotateTo(makeDataKey('key-2'));
    expect(await h.store.decryptField(envelope)).toBe('pre-rotation');
  });
});
