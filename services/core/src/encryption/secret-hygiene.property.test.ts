/**
 * Property-based test for secret hygiene on the encryption / secret-storage
 * surface.
 *
 * Feature: auxify-ai-platform, Property 49: Secrets never appear in logs or user
 * interfaces.
 *
 * Validates: Requirements 30.5, 34.7.
 *
 * Design statement (Property 49): "For any operation that uses a stored secret
 * (connector credentials, provider keys, or other secret-store values), no
 * emitted log entry and no user-facing projection contains the secret's value."
 *
 * This file covers the platform {@link EncryptedSecretStore} slice (the
 * secret-store / provider-key path). The store has no logging port — it defends
 * hygiene by NEVER returning, persisting, or projecting plaintext — so we assert
 * directly over every surface the store and its backend expose that could be
 * logged or shown to a user:
 *
 *   - the {@link SecretMetadata} returned from `putSecret`,
 *   - `getMetadata` (the safe status/audit projection),
 *   - the persisted {@link StoredSecretRecord} held by the
 *     {@link InMemorySecretBackend} — including its serialized ciphertext
 *     `envelope` string and the whole-backend dump,
 *   - `describe()` / `toString()` and default string coercion of the store.
 *
 * For an arbitrary secret (long, unicode, JSON-looking, base64-looking,
 * hex-looking) the plaintext value must be a substring of NONE of their
 * JSON/string serializations — the envelope only ever holds base64 of AES-GCM
 * ciphertext, so the plaintext cannot appear. We then round-trip `getSecret` to
 * prove hygiene does not break function: the secret is still recoverable.
 *
 * A note on faithfulness: a secret is drawn with a realistic minimum length (so
 * a single character can never coincidentally appear inside a random base64
 * ciphertext window), and we skip the astronomically rare input that happens to
 * coincide with a NON-secret identifier the caller already supplied or the
 * system stamps in the clear (the reference, region, key id, algorithm label,
 * timestamps, or the store's own description) — such a coincidence is not a
 * secret leak. The encrypted/serialized surfaces are still fully asserted.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EncryptedSecretStore } from './index.js';
import {
  FixedResidencyResolver,
  InMemoryKeyProvider,
  InMemorySecretBackend,
  MutableEncryptionClock,
  makeTenantContext,
} from './fakes.js';

/** At least 100 generated iterations, per the spec's PBT minimum. */
const NUM_RUNS = 200;

/** The fixed residency region stamped onto every record in this property. */
const REGION = 'eu-west-1';

/** The fixed, non-secret reference the secret is stored under. */
const REFERENCE = 'connector:acme:api-credential';

/**
 * Arbitrary secret values, deliberately mixing the tricky shapes a real
 * credential / provider key can take. Each is drawn with a realistic minimum
 * length so a generated value can never coincidentally appear inside a random
 * base64 ciphertext window.
 */
const secretArb: fc.Arbitrary<string> = fc.oneof(
  // Printable-ASCII secrets (spaces and punctuation included).
  fc.string({ minLength: 8, maxLength: 200 }),
  // Full-unicode secrets (emoji, CJK, combining marks) — never lone surrogates,
  // so the UTF-8 round-trip is exact.
  fc.fullUnicodeString({ minLength: 8, maxLength: 200 }),
  // Long secrets (e.g. PEM-sized material).
  fc.string({ minLength: 256, maxLength: 1024 }),
  // Base64-looking secrets (the trickiest case: same alphabet as the envelope).
  fc.base64String({ minLength: 16, maxLength: 128 }),
  // Hex-looking secrets (e.g. signing keys).
  fc.hexaString({ minLength: 16, maxLength: 64 }),
  // JSON-looking secrets (e.g. a service-account blob).
  fc
    .record({
      token: fc.string({ minLength: 8, maxLength: 64 }),
      clientId: fc.string({ minLength: 8, maxLength: 32 }),
      n: fc.integer(),
    })
    .map((o) => JSON.stringify(o)),
);

describe('Feature: auxify-ai-platform, Property 49: Secrets never appear in logs or user interfaces', () => {
  it('never exposes a stored secret plaintext in any metadata, persisted record/envelope, or store description — yet the secret round-trips (Validates: Requirements 30.5, 34.7)', async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, async (secret) => {
        const keys = new InMemoryKeyProvider();
        const backend = new InMemorySecretBackend();
        const residency = new FixedResidencyResolver(REGION);
        const clock = new MutableEncryptionClock();
        const store = new EncryptedSecretStore({ keys, backend, residency, clock });
        const ctx = makeTenantContext();

        // Non-secret strings the caller already supplied or the system stamps in
        // the clear. A random secret coinciding with one of these is not a leak,
        // so we skip those (vanishingly rare) inputs — the encrypted surfaces are
        // still fully asserted below.
        const nowIso = new Date(clock.now()).toISOString();
        const knownNonSecret = [
          REFERENCE,
          REGION,
          keys.activeId,
          'AES-256-GCM',
          nowIso,
          store.describe(),
        ];
        fc.pre(knownNonSecret.every((value) => !value.includes(secret)));

        const metadata = await store.putSecret(ctx, REFERENCE, secret);
        const projection = await store.getMetadata(ctx, REFERENCE);
        const record = backend.peek(ctx.organizationId, REFERENCE);

        // The record must exist and hold only a ciphertext envelope.
        expect(record).toBeDefined();

        // EVERY surface that could be logged or shown to a user.
        const surfaces: string[] = [
          JSON.stringify(metadata),
          JSON.stringify(projection),
          JSON.stringify(record),
          record?.envelope ?? '',
          JSON.stringify(backend.all),
          store.describe(),
          store.toString(),
          `${store}`, // default string coercion must not leak either
        ];
        for (const surface of surfaces) {
          expect(surface.includes(secret)).toBe(false);
        }

        // Hygiene must not break function: the secret is still recoverable.
        expect(await store.getSecret(ctx, REFERENCE)).toBe(secret);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
