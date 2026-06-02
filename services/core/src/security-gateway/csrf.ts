/**
 * CSRF verification for the Security_Gateway (Req 34.6).
 *
 * When a state-changing request is received the gateway requires a valid
 * cross-site request forgery token (Req 34.6). {@link DoubleSubmitCsrfVerifier}
 * implements the {@link CsrfVerifier} port with the standard double-submit
 * pattern: the request must present a CSRF token (a header/body value) that
 * matches the token bound to the session (a cookie value), compared in constant
 * time so a near-miss leaks no timing signal.
 *
 * The verifier is pure and synchronous. The gateway only consults it for
 * state-changing methods (`POST`/`PUT`/`PATCH`/`DELETE`); safe methods skip the
 * check entirely.
 */

import type { CsrfVerifier, GatewayRequest } from './types.js';

/**
 * Compare two strings in length-independent constant time.
 *
 * Returns `false` immediately for a length mismatch (length is not secret) and
 * otherwise XOR-accumulates every char code so the comparison time does not
 * depend on the position of the first differing character.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The double-submit-cookie {@link CsrfVerifier} (Req 34.6).
 *
 * A request passes only when it carries both a non-empty submitted token
 * ({@link GatewayRequest.csrfToken}) and a non-empty session-bound token
 * ({@link GatewayRequest.csrfCookie}) and the two are equal (constant-time). A
 * missing token on either side fails the check.
 */
export class DoubleSubmitCsrfVerifier implements CsrfVerifier {
  verify(request: GatewayRequest): boolean {
    const submitted = request.csrfToken;
    const session = request.csrfCookie;
    if (
      submitted === undefined ||
      session === undefined ||
      submitted.length === 0 ||
      session.length === 0
    ) {
      return false;
    }
    return constantTimeEqual(submitted, session);
  }
}
