/**
 * Content_Safety_Filter typed error (Req 36.2).
 *
 * {@link ContentBlockedError} is the typed block that the filter's
 * `screenInputOrThrow` / `scanOutputOrThrow` convenience methods raise when a
 * piece of content is refused. It carries the structured
 * {@link ContentSafetyDecision} so a caller catching it can inspect the
 * triggering reasons and whether a prompt-injection attempt was detected without
 * re-deriving them — the same verdict the non-throwing `screenInput` /
 * `scanOutput` return on `decision`. Keeping the block as an error (rather than
 * only a return value) lets the chat/streaming call paths fail closed with a
 * single `throw` site while preserving the full decision for logging.
 *
 * It projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) under the `validation` category (HTTP 400) so the same wire shape
 * crosses the REST_API, the WebSocket_Gateway, and the SDK, and carries
 * structured, secret-free `details` — never the offending content itself, only
 * the surface, the triggering categories, and the injection flag.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { ContentSafetyDecision, SafetySurface } from './types.js';

/** The stable machine-readable code for content blocked by the safety filter (Req 36.2). */
export const CONTENT_BLOCKED_CODE = 'CONTENT_SAFETY_BLOCKED' as const;

/**
 * Thrown by `screenInputOrThrow` / `scanOutputOrThrow` when content is blocked
 * by the Content_Safety_Filter (Req 36.2).
 *
 * The original {@link ContentSafetyDecision} is attached as {@link decision} so
 * callers can branch on the exact reasons that refused the content.
 * {@link surface} names whether an inbound prompt or an outbound response was
 * blocked.
 */
export class ContentBlockedError extends Error {
  /** The structured block verdict, including the triggering reasons. */
  readonly decision: ContentSafetyDecision;
  /** Whether the blocked content was an inbound prompt or an outbound response. */
  readonly surface: SafetySurface;

  constructor(surface: SafetySurface, decision: ContentSafetyDecision) {
    super(
      surface === 'input'
        ? 'Input was blocked by the content safety filter'
        : 'Model output was blocked by the content safety filter',
    );
    this.name = 'ContentBlockedError';
    this.surface = surface;
    this.decision = decision;
  }

  /**
   * Project this block into the platform-wide serializable error shape
   * (category `validation`, code {@link CONTENT_BLOCKED_CODE}) (Req 36.2, 46.8).
   * The structured `details` carry only the surface, the triggering category
   * labels, and the injection flag — never the offending content, so no
   * sensitive text leaks into the error (Req 34.7).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: CONTENT_BLOCKED_CODE,
      message: this.message,
      correlationId,
      details: {
        surface: this.surface,
        categories: this.decision.reasons.map((r) => r.category),
        promptInjectionDetected: this.decision.promptInjectionDetected,
      },
    });
  }
}
