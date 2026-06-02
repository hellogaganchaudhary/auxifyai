/**
 * Security_Gateway errors (Req 34.1, 34.2, 34.3, 34.4, 34.6, 34.8).
 *
 * {@link RequestDeniedError} is the typed denial that
 * {@link import('./security-gateway.js').SecurityGateway.evaluateOrThrow} raises
 * when a request is refused at the edge. It carries the structured
 * {@link GatewayVerdict} so a caller catching it can inspect the fail-closed
 * stage (`denialCode`) and reason without re-deriving them — the same verdict
 * the non-throwing `evaluate` returns. Keeping the denial as an error (rather
 * than only a return value) lets the edge transport fail closed with a single
 * `throw` site while preserving the full decision for logging.
 *
 * {@link RequestDeniedError.toPlatformError} projects the denial into the
 * platform-wide serializable {@link PlatformError} shape (Req 46.8), mapping
 * each {@link GatewayDenialCode} to the right {@link ErrorCategory} so the
 * REST_API surfaces the correct HTTP status (401/403/429/400) and the
 * WebSocket_Gateway emits a matching typed error event (Req 45.5). A
 * secret-free message is used throughout so internals never leak (Req 34.7).
 */

import { createPlatformError, type ErrorCategory, type PlatformError } from '@auxify/types';

import type { GatewayDenialCode, GatewayVerdict } from './types.js';

/** Stable machine-readable code prefix for an edge-denied request. */
export const REQUEST_DENIED_CODE = 'REQUEST_DENIED' as const;

/**
 * The {@link ErrorCategory} each {@link GatewayDenialCode} surfaces as
 * (Req 46.8). A TLS, CSRF, IP, authorization, or fail-closed denial is an
 * `authorization` refusal (403); an authentication failure is `authentication`
 * (401); a rate-limit denial is `rate_limited` (429); an invalid request is
 * `validation` (400).
 */
const DENIAL_CATEGORY: Readonly<Record<GatewayDenialCode, ErrorCategory>> = {
  tls_required: 'authorization',
  ip_blocked: 'authorization',
  rate_limited: 'rate_limited',
  unauthenticated: 'authentication',
  invalid_request: 'validation',
  csrf_failed: 'authorization',
  unauthorized: 'authorization',
  fail_closed: 'authorization',
};

/**
 * Thrown by `evaluateOrThrow` when a request is denied at the edge.
 *
 * The original {@link GatewayVerdict} is attached as {@link verdict} (and its
 * {@link GatewayDenialCode} surfaced as {@link code}) so callers can branch on
 * the exact fail-closed stage that refused the request.
 */
export class RequestDeniedError extends Error {
  /** The structured denial verdict, including the deciding stage and reason. */
  readonly verdict: GatewayVerdict;
  /** The fail-closed stage that produced the denial, for convenient branching. */
  readonly code: GatewayDenialCode | undefined;

  constructor(verdict: GatewayVerdict) {
    super(verdict.reason);
    this.name = 'RequestDeniedError';
    this.verdict = verdict;
    this.code = verdict.denialCode;
  }

  /**
   * Project into the platform-wide serializable error shape (Req 46.8).
   *
   * Maps the denial code to its {@link ErrorCategory} (so the surfaced HTTP
   * status is correct) and forwards a rate-limit retry-after hint when present.
   * The {@link message} is the verdict's secret-free reason (Req 34.7).
   *
   * @param correlationId The correlation id tying the error to logs/traces (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    const category: ErrorCategory =
      this.code !== undefined ? DENIAL_CATEGORY[this.code] : 'authorization';
    const input: Parameters<typeof createPlatformError>[0] = {
      category,
      code: this.code !== undefined ? `${REQUEST_DENIED_CODE}_${this.code.toUpperCase()}` : REQUEST_DENIED_CODE,
      message: this.message,
      correlationId,
      details: { denialCode: this.code },
    };
    if (this.verdict.retryAfterSeconds !== undefined) {
      input.retryAfterSeconds = this.verdict.retryAfterSeconds;
    }
    return createPlatformError(input);
  }
}
