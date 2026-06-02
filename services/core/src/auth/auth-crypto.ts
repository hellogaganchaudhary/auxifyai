/**
 * Cryptographic helpers for the Auth_Service (Req 33.8, 33.9, 35.4).
 *
 * This module owns the session-token secret-handling primitives so the service
 * body stays pure orchestration:
 *
 *   - {@link systemTokenGenerator} — the production {@link TokenGenerator},
 *     backed by `node:crypto`'s CSPRNG, so a minted token's entropy is
 *     cryptographically secure (Req 33.8).
 *   - {@link sha256TokenHasher} — the production {@link TokenHasher}, a SHA-256
 *     hex digest. Tokens are 256-bit high-entropy secrets, so a fast
 *     cryptographic digest is the right one-way function for storage (Req 35.4).
 *   - {@link generateOpaqueToken} — mints a raw, URL-safe token from the
 *     injected generator.
 *   - {@link constantTimeEqual} — a constant-time comparison used to compare
 *     token hashes without leaking timing information.
 *
 * SECURITY: nothing here persists, logs, or echoes a raw token. A raw token
 * exists only transiently in {@link generateOpaqueToken}'s return value, which
 * the service returns to the caller exactly once; only its hash is stored.
 *
 * Credential (password) and MFA-secret handling is intentionally NOT here: that
 * is owned entirely by the BetterAuth {@link AuthProvider} adapter, so this
 * package never hashes or stores a password.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { TokenGenerator, TokenHasher } from './types.js';

/**
 * The number of random bytes drawn for a token secret. 32 bytes = 256 bits of
 * entropy, well beyond brute-force reach (Req 33.8).
 */
export const TOKEN_SECRET_BYTES = 32 as const;

/** The production {@link TokenGenerator}, backed by `node:crypto` (Req 33.8). */
export const systemTokenGenerator: TokenGenerator = {
  generate(): string {
    return base64UrlEncode(new Uint8Array(randomBytes(TOKEN_SECRET_BYTES)));
  },
};

/** The production {@link TokenHasher}: a SHA-256 hex digest (Req 33.8, 35.4). */
export const sha256TokenHasher: TokenHasher = {
  hash(rawToken: string): string {
    return createHash('sha256').update(rawToken, 'utf8').digest('hex');
  },
};

/**
 * Encode bytes as a URL-safe base64 string (no padding), so a token is a compact
 * alphanumeric secret safe to carry in a header or URL.
 *
 * @param bytes The bytes to encode.
 * @returns The URL-safe, unpadded base64 string.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Mint a fresh raw opaque token from the injected generator (Req 33.8).
 *
 * SECURITY: the returned string is the raw secret. The caller (the Auth_Service)
 * returns it to the client exactly once and never persists it; only its hash is
 * stored on the session record.
 *
 * @param generator The cryptographically-secure token generator.
 * @returns A freshly-minted raw token string.
 */
export function generateOpaqueToken(generator: TokenGenerator): string {
  return generator.generate();
}

/**
 * Compare two strings in constant time relative to their content, returning
 * `true` only when they are byte-for-byte equal.
 *
 * Used to compare a presented token's computed hash against a stored hash so the
 * comparison does not leak, through timing, how much of the hash matched. When
 * the inputs differ in length the function still performs a fixed-shape
 * comparison and returns `false`.
 *
 * @param a The first string.
 * @param b The second string.
 * @returns `true` if the strings are exactly equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Touch timingSafeEqual on a same-length buffer so the early return does
    // not short-circuit before any comparison work.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
