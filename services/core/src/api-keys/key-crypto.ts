/**
 * Cryptographic helpers for the API_Key_Manager (Req 21.1, 21.2, 35.4).
 *
 * This module owns every secret-handling primitive the manager relies on, so
 * the service body stays pure orchestration:
 *
 *   - {@link systemKeyRandomSource} — the production {@link KeyRandomSource},
 *     backed by `node:crypto`'s CSPRNG (`randomBytes`), so a minted key's
 *     entropy is cryptographically secure (Req 21.1).
 *   - {@link sha256KeyHasher} — the production {@link KeyHasher}, a SHA-256 hex
 *     digest. Keys are 256-bit high-entropy secrets, so a fast cryptographic
 *     digest is the right one-way function (a slow password KDF is unnecessary).
 *   - {@link generateRawKey} — mints a raw key as a fixed prefix plus a
 *     URL-safe, base62 high-entropy secret drawn from the injected RNG.
 *   - {@link extractPrefix} / {@link maskKeyPrefix} — derive the non-secret
 *     display prefix and the masked display string a listing reveals (Req 21.2).
 *   - {@link constantTimeEqual} — a length-independent constant-time string
 *     comparison used to compare key hashes without leaking timing information.
 *
 * SECURITY: nothing here ever persists, logs, or echoes a raw key. The raw key
 * exists only transiently in {@link generateRawKey}'s return value, which the
 * service returns to the caller exactly once.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { KeyHasher, KeyRandomSource } from './types.js';

/**
 * The fixed, non-secret prefix every Auxify API key carries (`axk_`).
 *
 * It namespaces the key format and is the leading portion surfaced in masked
 * listings (Req 21.2). It is not secret and carries no entropy.
 */
export const API_KEY_PREFIX = 'axk_' as const;

/**
 * The number of random bytes drawn for a key secret. 32 bytes = 256 bits of
 * entropy, well beyond brute-force reach (Req 21.1).
 */
export const KEY_SECRET_BYTES = 32 as const;

/**
 * The number of leading characters of the full key retained as the non-secret
 * display prefix (Req 21.2). Long enough to identify a key at a glance, short
 * enough to leak no meaningful fraction of the 256-bit secret.
 */
export const KEY_DISPLAY_PREFIX_LENGTH = 12 as const;

/** Base62 alphabet for encoding the random secret into a URL-safe token. */
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The production {@link KeyRandomSource}, backed by `node:crypto` (Req 21.1). */
export const systemKeyRandomSource: KeyRandomSource = {
  randomBytes(byteLength: number): Uint8Array {
    return new Uint8Array(randomBytes(byteLength));
  },
};

/** The production {@link KeyHasher}: a SHA-256 hex digest (Req 21.1, 35.4). */
export const sha256KeyHasher: KeyHasher = {
  hash(plaintext: string): string {
    return createHash('sha256').update(plaintext, 'utf8').digest('hex');
  },
};

/**
 * Encode arbitrary bytes into a base62 token.
 *
 * Encoding is done by treating the bytes as a big-endian integer and emitting
 * base62 digits, which yields a compact, URL-safe, alphanumeric secret with no
 * loss of the input's entropy.
 *
 * @param bytes The random bytes to encode.
 * @returns A base62 string deterministically derived from `bytes`.
 */
export function encodeBase62(bytes: Uint8Array): string {
  if (bytes.length === 0) return '0';
  // Big-integer base conversion across the byte array.
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const value = (digits[i]! << 8) + carry;
      digits[i] = value % 62;
      carry = Math.floor(value / 62);
    }
    while (carry > 0) {
      digits.push(carry % 62);
      carry = Math.floor(carry / 62);
    }
  }
  // Preserve leading zero bytes as leading '0' characters.
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros += 1;
    else break;
  }
  let out = '';
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE62[digits[i]!];
  }
  return '0'.repeat(leadingZeros) + out;
}

/**
 * Mint a fresh raw API key: the fixed {@link API_KEY_PREFIX} followed by a
 * base62-encoded, high-entropy secret drawn from the injected RNG (Req 21.1).
 *
 * SECURITY: the returned string is the raw secret. The caller (the
 * API_Key_Manager) returns it to the key owner exactly once and never persists
 * it; only its hash and display prefix are stored.
 *
 * @param random The cryptographically-secure random source.
 * @returns A freshly-minted raw API key string.
 */
export function generateRawKey(random: KeyRandomSource): string {
  const secret = encodeBase62(random.randomBytes(KEY_SECRET_BYTES));
  return `${API_KEY_PREFIX}${secret}`;
}

/**
 * Derive the non-secret display prefix of a raw key (Req 21.2).
 *
 * The prefix is the leading {@link KEY_DISPLAY_PREFIX_LENGTH} characters of the
 * full key — enough to recognize a key without revealing a usable fraction of
 * its secret.
 *
 * @param rawKey The full raw key.
 * @returns The non-secret display prefix.
 */
export function extractPrefix(rawKey: string): string {
  return rawKey.slice(0, KEY_DISPLAY_PREFIX_LENGTH);
}

/**
 * Build the masked display string a listing reveals for a key (Req 21.2).
 *
 * It shows only the non-secret `prefix` followed by a fixed ellipsis mask, so a
 * listing never exposes the secret or its hash.
 *
 * @param prefix The key's non-secret display prefix.
 * @returns A masked, prefix-only display string (e.g. `axk_AbC12xYz…`).
 */
export function maskKeyPrefix(prefix: string): string {
  return `${prefix}\u2026`;
}

/**
 * Compare two strings in constant time relative to their content, returning
 * `true` only when they are byte-for-byte equal.
 *
 * Used to compare a presented key's computed hash against a stored hash so the
 * comparison does not leak, through timing, how much of the hash matched. When
 * the two inputs differ in length the function still performs a fixed-shape
 * comparison and returns `false` (length itself is not secret for fixed-width
 * hex digests, but the equal-length path uses {@link timingSafeEqual}).
 *
 * @param a The first string.
 * @param b The second string.
 * @returns `true` if the strings are exactly equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still touch timingSafeEqual on a same-length buffer so the early return
    // does not short-circuit before any comparison work.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
