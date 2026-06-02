/**
 * Unit tests for the AES-256-GCM authenticated-envelope core (Req 35.1, 35.3).
 *
 * These drive the pure {@link encrypt} / {@link decrypt} / {@link decryptToString}
 * functions and the {@link serializeEnvelope} / {@link deserializeEnvelope} pair
 * over the in-memory key builders (imported directly from `./fakes.js`),
 * covering:
 *
 *   - a round-trip: `decrypt(encrypt(x)) === x` for both strings and bytes;
 *   - a fresh IV per call, so the same plaintext never yields the same envelope;
 *   - the envelope never carries the plaintext;
 *   - fail-closed decryption on a wrong key, a tampered ciphertext / IV / tag,
 *     and an AAD mismatch (present/absent and different bytes);
 *   - an unsupported version / algorithm and a malformed serialized envelope.
 */

import { describe, expect, it } from 'vitest';

import { decrypt, decryptToString, deserializeEnvelope, encrypt, serializeEnvelope } from './crypto.js';
import { DecryptionError } from './errors.js';
import { ENCRYPTION_ALGORITHM, ENVELOPE_VERSION } from './types.js';
import { makeDataKey } from './fakes.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('encrypt / decrypt round-trip (Req 35.1, 35.3)', () => {
  it('decrypts back to the original string', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('super-secret-value', key);
    expect(decryptToString(envelope, key)).toBe('super-secret-value');
  });

  it('decrypts back to the original bytes', () => {
    const key = makeDataKey('key-1');
    const plaintext = utf8('raw-bytes-😀-payload');
    const envelope = encrypt(plaintext, key);
    expect(fromUtf8(decrypt(envelope, key))).toBe('raw-bytes-😀-payload');
  });

  it('round-trips an empty string', () => {
    const key = makeDataKey('key-1');
    expect(decryptToString(encrypt('', key), key)).toBe('');
  });

  it('stamps the envelope with the version, algorithm, and key id', () => {
    const key = makeDataKey('key-abc');
    const envelope = encrypt('x', key);
    expect(envelope.version).toBe(ENVELOPE_VERSION);
    expect(envelope.algorithm).toBe(ENCRYPTION_ALGORITHM);
    expect(envelope.keyId).toBe('key-abc');
    expect(envelope.aad).toBe(false);
  });

  it('uses a fresh IV per call, so the same plaintext yields different envelopes', () => {
    const key = makeDataKey('key-1');
    const a = encrypt('same-plaintext', key);
    const b = encrypt('same-plaintext', key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // ... yet both still decrypt to the same value.
    expect(decryptToString(a, key)).toBe('same-plaintext');
    expect(decryptToString(b, key)).toBe('same-plaintext');
  });

  it('never carries the plaintext in the envelope', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('plaintext-marker', key);
    const serialized = serializeEnvelope(envelope);
    expect(serialized).not.toContain('plaintext-marker');
    expect(envelope.ciphertext).not.toContain('plaintext-marker');
  });
});

describe('encrypt / decrypt with additional authenticated data (Req 35.3)', () => {
  it('round-trips when the same AAD is supplied', () => {
    const key = makeDataKey('key-1');
    const aad = utf8('org-1:db-password');
    const envelope = encrypt('value', key, aad);
    expect(envelope.aad).toBe(true);
    expect(decryptToString(envelope, key, aad)).toBe('value');
  });

  it('fails closed when the AAD is omitted at decryption', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('value', key, utf8('bound-context'));
    expect(() => decrypt(envelope, key)).toThrow(DecryptionError);
  });

  it('fails closed when the AAD differs at decryption', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('value', key, utf8('context-A'));
    expect(() => decrypt(envelope, key, utf8('context-B'))).toThrow(DecryptionError);
  });

  it('fails closed when AAD is supplied for an envelope encrypted without it', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('value', key);
    expect(() => decrypt(envelope, key, utf8('unexpected'))).toThrow(DecryptionError);
  });
});

describe('decrypt fails closed on tampering and wrong keys (Req 35.1)', () => {
  it('throws when decrypting with a different key', () => {
    const key = makeDataKey('key-1');
    const other = makeDataKey('key-1'); // same id, different random material
    const envelope = encrypt('value', key);
    expect(() => decrypt(envelope, other)).toThrow(DecryptionError);
  });

  it('throws when the ciphertext is altered', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('value', key);
    const tampered = { ...envelope, ciphertext: flipBase64Byte(envelope.ciphertext) };
    expect(() => decrypt(tampered, key)).toThrow(DecryptionError);
  });

  it('throws when the authentication tag is altered', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('value', key);
    const tampered = { ...envelope, authTag: flipBase64Byte(envelope.authTag) };
    expect(() => decrypt(tampered, key)).toThrow(DecryptionError);
  });

  it('throws when the IV is altered', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('value', key);
    const tampered = { ...envelope, iv: flipBase64Byte(envelope.iv) };
    expect(() => decrypt(tampered, key)).toThrow(DecryptionError);
  });

  it('throws on an unsupported envelope version', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('value', key);
    const bad = { ...envelope, version: 99 } as unknown as typeof envelope;
    expect(() => decrypt(bad, key)).toThrow(DecryptionError);
  });

  it('throws on an unsupported algorithm', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('value', key);
    const bad = { ...envelope, algorithm: 'AES-128-CBC' } as unknown as typeof envelope;
    expect(() => decrypt(bad, key)).toThrow(DecryptionError);
  });
});

describe('serializeEnvelope / deserializeEnvelope', () => {
  it('round-trips an envelope through its JSON string form', () => {
    const key = makeDataKey('key-1');
    const envelope = encrypt('value', key);
    const restored = deserializeEnvelope(serializeEnvelope(envelope));
    expect(restored).toEqual(envelope);
    expect(decryptToString(restored, key)).toBe('value');
  });

  it('fails closed on non-JSON input', () => {
    expect(() => deserializeEnvelope('not-json')).toThrow(DecryptionError);
  });

  it('fails closed on a JSON value that is not a well-formed envelope', () => {
    expect(() => deserializeEnvelope(JSON.stringify({ foo: 'bar' }))).toThrow(DecryptionError);
  });
});

describe('key length guard', () => {
  it('rejects key material that is not 32 bytes', () => {
    const shortKey = makeDataKey('short', new Uint8Array(16));
    expect(() => encrypt('value', shortKey)).toThrow(RangeError);
  });
});

/** Flip one byte of a base64-encoded field so the decoded bytes differ (for tamper tests). */
function flipBase64Byte(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString('base64');
}
