/**
 * Feature: auxify-ai-platform, Property 41: API keys are stored hashed and
 * displayed masked.
 *
 * Validates: Requirements 21.1, 21.2, 35.4
 *
 * _For any_ created API key, the stored record contains only a hash of the key
 * and no plaintext, the plaintext is returned exactly once at creation time,
 * and any listing reveals only the key prefix.
 *
 * This suite pins the property down end-to-end through the real
 * {@link ApiKeyManager} (task 19.1) wired to the in-memory fakes in `./fakes.js`
 * — an {@link InMemoryApiKeyStore} (whose `peek` snapshots exactly what was
 * persisted) and a {@link CapturingAuditRecorder}. It deliberately injects the
 * PRODUCTION {@link sha256KeyHasher} so the "the stored value is a one-way hash,
 * not the raw key" assertion is meaningful — the fast injective test hasher
 * embeds its input and would mask a real regression here — and the production
 * {@link systemKeyRandomSource} so each minted secret is genuinely
 * high-entropy and unique.
 *
 * For every created key the property checks, across >= 100 generated tenants and
 * create inputs, that:
 *  - the stored record's `hash` equals `sha256(rawKey)`, is a 64-char hex
 *    digest, and is NOT the raw key (Req 21.1, 35.4);
 *  - the full serialized stored record never contains the raw secret (the only
 *    fragment of the key it keeps is the non-secret display prefix) (Req 35.4);
 *  - `get` and `list` return masked projections with NO `hash` field whose
 *    serialization never contains the raw secret (Req 21.2);
 *  - the masked display string begins with the non-secret prefix, and that
 *    prefix is a genuine prefix of the raw key (Req 21.2); and
 *  - no recorded audit metadata carries the raw secret (Req 21.1, 35.4).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ApiKeyManager } from './api-key-manager.js';
import {
  CapturingAuditRecorder,
  InMemoryApiKeyStore,
  makeTenant,
  sequentialKeyIdGenerator,
} from './fakes.js';
import { extractPrefix, sha256KeyHasher, systemKeyRandomSource } from './key-crypto.js';
import type { MaskedKey, RateLimit } from './types.js';

/** Minimum generated iterations per property (>= 100). */
const NUM_RUNS = 200;

/** A 64-char lowercase-hex SHA-256 digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Generators — arbitrary tenants and create inputs (names, owners, rate limits).
// ---------------------------------------------------------------------------

/** One create input: a label, an optional explicit owner, an optional rate limit. */
interface CreateSpec {
  name: string;
  ownerId: string | undefined;
  rateLimit: RateLimit | undefined;
}

/** A human label for a key; includes the empty string and arbitrary printable text. */
const nameArb = fc.string({ maxLength: 40 });

/** An optional explicit owner principal id (otherwise the key defaults to the actor). */
const ownerIdArb = fc.option(fc.string({ minLength: 1, maxLength: 24 }), { nil: undefined });

/** An optional configured rate limit (Req 21.7); otherwise the manager default applies. */
const rateLimitArb = fc.option(
  fc.record({
    requestsPerWindow: fc.integer({ min: 1, max: 100_000 }),
    windowSeconds: fc.integer({ min: 1, max: 86_400 }),
  }),
  { nil: undefined },
);

const createSpecArb: fc.Arbitrary<CreateSpec> = fc.record({
  name: nameArb,
  ownerId: ownerIdArb,
  rateLimit: rateLimitArb,
});

/** A batch of 1..5 create inputs issued under a single tenant. */
const scenarioArb = fc.record({
  organizationId: fc.string({ minLength: 1, maxLength: 16 }),
  userId: fc.string({ minLength: 1, maxLength: 16 }),
  specs: fc.array(createSpecArb, { minLength: 1, maxLength: 5 }),
});

// ---------------------------------------------------------------------------
// Assertions reused across every facet of the property.
// ---------------------------------------------------------------------------

/** A masked projection must never carry the stored hash (Req 21.2). */
function assertNoHashField(masked: MaskedKey): void {
  expect(Object.prototype.hasOwnProperty.call(masked, 'hash')).toBe(false);
  expect((masked as unknown as Record<string, unknown>).hash).toBeUndefined();
}

/** A serialized value must not embed any of the one-time raw secrets. */
function assertNoSecretLeaked(serialized: string, plaintexts: readonly string[]): void {
  for (const plaintext of plaintexts) {
    expect(serialized).not.toContain(plaintext);
  }
}

// ---------------------------------------------------------------------------
// Property 41.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 41: API keys are stored hashed and displayed masked', () => {
  it('stores only a one-way hash + non-secret prefix and exposes masked, secret-free projections (Validates: Requirements 21.1, 21.2, 35.4)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ organizationId, userId, specs }) => {
        // Real hasher + real CSPRNG so "stored != raw" and uniqueness are genuine.
        const store = new InMemoryApiKeyStore();
        const audit = new CapturingAuditRecorder();
        const manager = new ApiKeyManager({
          store,
          audit,
          random: systemKeyRandomSource,
          hasher: sha256KeyHasher,
          idGenerator: sequentialKeyIdGenerator(),
        });
        const ctx = makeTenant({ organizationId, userId });

        const plaintexts: string[] = [];
        const idToPlaintext = new Map<string, string>();

        for (const spec of specs) {
          const input: Parameters<ApiKeyManager['create']>[1] = { name: spec.name };
          if (spec.ownerId !== undefined) input.ownerId = spec.ownerId;
          if (spec.rateLimit !== undefined) input.rateLimit = spec.rateLimit;

          const created = await manager.create(ctx, input);
          const rawKey = created.plaintext;
          plaintexts.push(rawKey);
          idToPlaintext.set(created.key.id, rawKey);

          // --- The raw key is the high-entropy secret returned once at creation.
          expect(rawKey.startsWith('axk_')).toBe(true);

          // --- The stored record keeps ONLY a one-way hash (Req 21.1, 35.4).
          const stored = store.peek(created.key.id);
          expect(stored).toBeDefined();
          const record = stored!;
          expect(record.hash).toBe(sha256KeyHasher.hash(rawKey));
          expect(record.hash).toMatch(SHA256_HEX);
          expect(record.hash).not.toBe(rawKey);

          // --- The persisted record never embeds the raw secret; the only
          //     fragment it retains is the non-secret display prefix (Req 35.4).
          assertNoSecretLeaked(JSON.stringify(record), [rawKey]);
          expect(record.prefix).toBe(extractPrefix(rawKey));
          expect(rawKey.startsWith(record.prefix)).toBe(true);

          // --- The creation-time masked projection is already secret-free.
          assertNoHashField(created.key);
          expect(created.key.masked.startsWith(created.key.prefix)).toBe(true);
          expect(created.key.prefix).toBe(record.prefix);
        }

        // --- `get` exposes a masked, prefix-only view with no hash or secret (Req 21.2).
        for (const [id, rawKey] of idToPlaintext) {
          const masked = await manager.get(ctx, id);
          assertNoHashField(masked);
          expect(masked.masked.startsWith(masked.prefix)).toBe(true);
          expect(rawKey.startsWith(masked.prefix)).toBe(true);
          assertNoSecretLeaked(JSON.stringify(masked), plaintexts);
        }

        // --- `list` reveals every key masked, never the secret or its hash (Req 21.2).
        const listed = await manager.list(ctx);
        expect(listed).toHaveLength(specs.length);
        for (const masked of listed) {
          assertNoHashField(masked);
          const rawKey = idToPlaintext.get(masked.id);
          expect(rawKey).toBeDefined();
          expect(masked.masked.startsWith(masked.prefix)).toBe(true);
          expect(rawKey!.startsWith(masked.prefix)).toBe(true);
        }
        assertNoSecretLeaked(JSON.stringify(listed), plaintexts);

        // --- No audit metadata anywhere carries a raw key value (Req 21.1, 35.4).
        expect(audit.withAction('api_key.create')).toHaveLength(specs.length);
        assertNoSecretLeaked(JSON.stringify(audit.recorded), plaintexts);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
