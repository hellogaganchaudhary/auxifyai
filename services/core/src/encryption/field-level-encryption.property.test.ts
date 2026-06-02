/**
 * Property-based test for field-level encryption.
 *
 * Feature: auxify-ai-platform, Property 50: Field-level encryption round-trips
 * and never stores plaintext.
 *
 * Design statement (Property 50): "For any value written to a designated
 * sensitive field, decrypting the stored ciphertext yields the original value
 * (`decrypt(encrypt(x)) == x`) and the persisted form is never equal to the
 * plaintext."
 *
 * Validates: Requirements 35.3
 *
 * We exercise the AES-256-GCM envelope core ({@link encrypt} / {@link decrypt} /
 * {@link decryptToString} and the {@link serializeEnvelope} /
 * {@link deserializeEnvelope} pair) AND the field-level
 * {@link EncryptedSecretStore.encryptField} / {@link EncryptedSecretStore.decryptField}
 * pair over arbitrary field values — empty, ASCII, full-unicode (graphemes /
 * emoji), long strings, and raw bytes — under a single STABLE data key from the
 * in-memory fakes, asserting three things hold for every generated value:
 *
 *   1. Round-trip: `decrypt(encrypt(x, key), key) === x`, and the
 *      `encryptField` / `decryptField` pair round-trips the same value.
 *   2. Never stores plaintext: the serialized envelope string and the
 *      base64 `ciphertext` are never equal to — and never contain — the
 *      plaintext (the empty-string edge case is handled explicitly: the
 *      ciphertext is empty yet the persisted form is still not the plaintext),
 *      and two encryptions of the same value differ (a fresh IV per call).
 *   3. Tamper / fail-closed (reinforcement): flipping a byte of the ciphertext
 *      or the authentication tag makes `decrypt` throw {@link DecryptionError}.
 *
 * No cloud KMS, secret manager, or network is required — only `node:crypto` via
 * the existing module and the in-memory fakes.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DecryptionError,
  EncryptedSecretStore,
  decrypt,
  decryptToString,
  deserializeEnvelope,
  encrypt,
  serializeEnvelope,
  type DataKey,
  type EncryptionEnvelope,
} from './index.js';
import { InMemoryKeyProvider, InMemorySecretBackend, makeDataKey } from './fakes.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 200;

/**
 * A single STABLE data key reused across every generated case (the key is fixed,
 * only the field VALUES vary), matching the design's "stable key from the key
 * provider" expectation.
 */
const STABLE_KEY: DataKey = makeDataKey('key-field-level');

/** A store whose active key is the same {@link STABLE_KEY}, for the field-level pair. */
function makeStore(): EncryptedSecretStore {
  const keys = new InMemoryKeyProvider(STABLE_KEY);
  const backend = new InMemorySecretBackend();
  return new EncryptedSecretStore({ keys, backend });
}

/**
 * Arbitrary string field value. The empty string is a dedicated branch (its own
 * edge case). The non-empty branches carry a minimum length of 8 so a
 * coincidental substring match — either against the random base64 ciphertext
 * bytes or against the envelope's fixed ASCII metadata tokens (e.g.
 * `"algorithm":"AES-256-GCM"`, the key id) — is statistically impossible
 * (~95^-8 ≈ 1e-15 per candidate token), keeping the "never contains" assertion
 * robust rather than flaky. Coverage spans ASCII, full-unicode graphemes (incl.
 * astral-plane / emoji), and long values.
 */
const stringValueArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constant('') },
  // ASCII (default printable-ASCII unit).
  { weight: 3, arbitrary: fc.string({ minLength: 8, maxLength: 128 }) },
  // Full-unicode graphemes, including astral-plane characters / emoji.
  { weight: 3, arbitrary: fc.string({ unit: 'grapheme', minLength: 8, maxLength: 64 }) },
  // Long values.
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', minLength: 512, maxLength: 2048 }) },
);

/** Arbitrary raw-bytes field value (the field API accepts `Uint8Array`). */
const bytesValueArb: fc.Arbitrary<Uint8Array> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(new Uint8Array(0)) },
  { weight: 4, arbitrary: fc.uint8Array({ minLength: 8, maxLength: 512 }) },
);

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

/** Flip one byte of a base64-encoded envelope field so the decoded bytes differ. */
function flipBase64Byte(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString('base64');
}

describe('Feature: auxify-ai-platform, Property 50: Field-level encryption round-trips and never stores plaintext', () => {
  it('round-trips any string field value through encrypt/decrypt and the encryptField/decryptField pair (Validates: Requirements 35.3)', async () => {
    const store = makeStore();
    await fc.assert(
      fc.asyncProperty(stringValueArb, async (value) => {
        // Pure core round-trip: decrypt(encrypt(x, key), key) === x.
        const envelope = encrypt(value, STABLE_KEY);
        expect(decryptToString(envelope, STABLE_KEY)).toBe(value);

        // The serialized-envelope core also round-trips byte-for-byte.
        const restored = deserializeEnvelope(serializeEnvelope(envelope));
        expect(decryptToString(restored, STABLE_KEY)).toBe(value);

        // Field-level pair on EncryptedSecretStore round-trips the same value.
        const serializedField = await store.encryptField(value);
        expect(await store.decryptField(serializedField)).toBe(value);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('round-trips any raw-bytes field value through encrypt/decrypt and the field-level path (Validates: Requirements 35.3)', async () => {
    const store = makeStore();
    await fc.assert(
      fc.asyncProperty(bytesValueArb, async (value) => {
        // Pure core round-trip on raw bytes (no UTF-8 decode).
        const envelope = encrypt(value, STABLE_KEY);
        expect(Buffer.from(decrypt(envelope, STABLE_KEY)).equals(Buffer.from(value))).toBe(true);

        // Field-level path accepts bytes; recover them by decrypting the
        // serialized field envelope at the byte level.
        const serializedField = await store.encryptField(value);
        const fieldEnvelope = deserializeEnvelope(serializedField);
        expect(Buffer.from(decrypt(fieldEnvelope, STABLE_KEY)).equals(Buffer.from(value))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never persists the plaintext: the serialized envelope and ciphertext are never equal to nor contain it (Validates: Requirements 35.3)', async () => {
    const store = makeStore();
    await fc.assert(
      fc.asyncProperty(stringValueArb, async (value) => {
        const envelope = encrypt(value, STABLE_KEY);
        const serialized = serializeEnvelope(envelope);
        const serializedField = await store.encryptField(value);
        const cipherBytes = Buffer.from(envelope.ciphertext, 'base64');
        const plainBytes = utf8(value);

        if (value.length === 0) {
          // Empty-string edge case: empty plaintext encrypts to empty
          // ciphertext, yet the PERSISTED form is the JSON envelope, never the
          // (empty) plaintext leaking through.
          expect(envelope.ciphertext).toBe('');
          expect(cipherBytes.length).toBe(0);
          expect(serialized).not.toBe(value);
          expect(serializedField).not.toBe(value);
          // The envelope still carries its structural fields (no plaintext anywhere).
          expect(serialized.length).toBeGreaterThan(0);
        } else {
          // Non-empty: the persisted forms never equal nor contain the plaintext.
          expect(envelope.ciphertext).not.toBe(value);
          expect(serialized).not.toContain(value);
          expect(serializedField).not.toContain(value);
          // The raw ciphertext bytes are not a copy of (and do not embed) the plaintext bytes.
          expect(cipherBytes.equals(plainBytes)).toBe(false);
          expect(cipherBytes.includes(plainBytes)).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('uses a fresh IV per call so two encryptions of the same value differ, yet both decrypt back (Validates: Requirements 35.3)', () => {
    fc.assert(
      fc.property(stringValueArb, (value) => {
        const a = encrypt(value, STABLE_KEY);
        const b = encrypt(value, STABLE_KEY);

        // The per-encryption IV is fresh, so two envelopes of the same value differ.
        expect(a.iv).not.toBe(b.iv);
        if (value.length > 0) {
          // ... and so does the ciphertext for any non-empty value.
          expect(a.ciphertext).not.toBe(b.ciphertext);
        }
        // Non-determinism never breaks the round-trip.
        expect(decryptToString(a, STABLE_KEY)).toBe(value);
        expect(decryptToString(b, STABLE_KEY)).toBe(value);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('fails closed: flipping a byte of the ciphertext or the auth tag makes decrypt throw (Validates: Requirements 35.3)', () => {
    fc.assert(
      fc.property(stringValueArb, (value) => {
        const envelope = encrypt(value, STABLE_KEY);

        // Tampering with the authentication tag is always detectable (the tag is
        // present even for an empty-ciphertext envelope).
        const tamperedTag: EncryptionEnvelope = { ...envelope, authTag: flipBase64Byte(envelope.authTag) };
        expect(() => decrypt(tamperedTag, STABLE_KEY)).toThrow(DecryptionError);

        // Tampering with a non-empty ciphertext is likewise detected.
        if (value.length > 0) {
          const tamperedCipher: EncryptionEnvelope = {
            ...envelope,
            ciphertext: flipBase64Byte(envelope.ciphertext),
          };
          expect(() => decrypt(tamperedCipher, STABLE_KEY)).toThrow(DecryptionError);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
