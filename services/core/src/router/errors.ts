/**
 * Model_Router routing errors (Req 3.2).
 *
 * When a user explicitly requests a model they are not permitted to use, the
 * Model_Router must reject the request with an authorization error that
 * *names the disallowed model* (Req 3.2). {@link ModelNotAuthorizedError} is
 * that typed rejection: it carries the offending `modelId` and the
 * model-access `denialCode` (the fail-closed gate that refused — viewer tier,
 * Premium authorization, or allowed-model list), and it can project itself into
 * the platform-wide serializable {@link PlatformError} (category
 * `authorization`, code `MODEL_NOT_AUTHORIZED`) that crosses the REST_API,
 * WebSocket_Gateway, and SDK (Req 46.8).
 *
 * Keeping the model id on the error (not only in the message) lets request-path
 * callers branch on the exact disallowed model without re-parsing text, while
 * the {@link PlatformError} projection keeps the wire format consistent with
 * every other typed failure in the platform.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { ModelDenialCode } from '../access/index.js';

import type { FallbackAttempt } from './types.js';

/** The stable machine-readable code for an unauthorized-model rejection. */
export const MODEL_NOT_AUTHORIZED_CODE = 'MODEL_NOT_AUTHORIZED' as const;

/** The stable machine-readable code for an Auto Mode no-eligible-model failure. */
export const NO_ELIGIBLE_MODEL_CODE = 'NO_ELIGIBLE_MODEL' as const;

/** The stable machine-readable code for a fully-exhausted Fallback Chain (Req 3.8). */
export const PROVIDER_EXHAUSTED_CODE = 'PROVIDER_EXHAUSTED' as const;

/**
 * Why Auto Mode could not select any model for a request.
 *
 * - `no_routable_model` — the principal's *routable* permitted set (permitted ∩
 *   currently available, Req 2.10) was empty, so there was no model to route to
 *   at all. This is treated as a temporarily-unservable condition (availability
 *   may recover or an administrator may grant access), hence retriable.
 * - `no_vision_capable_model` — the request carried image input (so a
 *   vision-capable model is *required*, Req 3.6) but the permitted set contains
 *   no vision-capable model. Auto Mode never downgrades image input to a
 *   non-vision model, so this is surfaced rather than mis-routed; it is not
 *   retriable because it needs an access/config change, not a retry.
 */
export type NoEligibleModelCause = 'no_routable_model' | 'no_vision_capable_model';

/**
 * Thrown when a request explicitly names a model the principal is not permitted
 * to use (Req 3.2).
 *
 * The disallowed model id is carried as {@link modelId} (and named in the
 * message), and {@link denialCode} surfaces the model-access gate that refused
 * — `viewer_model_restricted` (Req 19.6), `premium_unauthorized` (Req 19.5), or
 * `model_not_allowed` (Req 20.6) — so callers can distinguish the reason
 * without re-deriving it.
 */
export class ModelNotAuthorizedError extends Error {
  /** The id of the model the principal is not permitted to use (Req 3.2). */
  readonly modelId: string;
  /** The model-access gate that refused the model. */
  readonly denialCode: ModelDenialCode | undefined;

  constructor(modelId: string, reason: string, denialCode?: ModelDenialCode) {
    super(`Not authorized to use model "${modelId}": ${reason}`);
    this.name = 'ModelNotAuthorizedError';
    this.modelId = modelId;
    this.denialCode = denialCode;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `authorization`, code {@link MODEL_NOT_AUTHORIZED_CODE}), naming
   * the disallowed model in both the message and the structured `details`
   * (Req 3.2, 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authorization',
      code: MODEL_NOT_AUTHORIZED_CODE,
      message: this.message,
      correlationId,
      details: { modelId: this.modelId, denialCode: this.denialCode },
    });
  }
}

/**
 * Thrown when Auto Mode cannot select any model the principal is permitted to
 * use for a request (Req 3.5, 3.6).
 *
 * Auto Mode selects strictly from the principal's permitted set — it *never*
 * falls back to a non-permitted model (Req 3.5) and *never* downgrades image
 * input to a non-vision model (Req 3.6). When that constraint leaves no
 * eligible model, no {@link import('./types.js').RouteDecision} can be produced,
 * so this typed error is raised instead. {@link cause} distinguishes the two
 * reasons (see {@link NoEligibleModelCause}); `requiresVision` is `true` exactly
 * when the failure is driven by an unmet image/vision requirement.
 *
 * It projects to a {@link PlatformError}: an unmet vision requirement is an
 * `authorization`-class condition (the user lacks access to any vision model),
 * while an empty routable set is `provider_unavailable` (retriable — health may
 * recover), keeping the wire format consistent with every other typed failure
 * (Req 46.8).
 */
export class NoEligibleModelError extends Error {
  /** Which constraint left no eligible model. */
  override readonly cause: NoEligibleModelCause;
  /** Whether the failure was driven by an unmet vision requirement (Req 3.6). */
  readonly requiresVision: boolean;

  constructor(cause: NoEligibleModelCause, reason: string) {
    super(`Auto Mode could not select a permitted model: ${reason}`);
    this.name = 'NoEligibleModelError';
    this.cause = cause;
    this.requiresVision = cause === 'no_vision_capable_model';
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (code {@link NO_ELIGIBLE_MODEL_CODE}) (Req 46.8).
   *
   * A `no_vision_capable_model` cause maps to category `authorization` (the
   * principal is permitted no vision-capable model); a `no_routable_model`
   * cause maps to `provider_unavailable` (retriable — no permitted model is
   * currently available).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    const category =
      this.cause === 'no_vision_capable_model' ? 'authorization' : 'provider_unavailable';
    return createPlatformError({
      category,
      code: NO_ELIGIBLE_MODEL_CODE,
      message: this.message,
      correlationId,
      details: { cause: this.cause, requiresVision: this.requiresVision },
    });
  }
}

/**
 * Thrown when every model in the Fallback Chain fails for a request (Req 3.8).
 *
 * The Model_Router treats a provider error or a timeout as a retriable failure
 * and advances to the next model in the chain (Req 3.7). When no model remains
 * — the chain is exhausted — it raises this typed error, which carries the
 * ordered list of {@link FallbackAttempt}s so the failure *identifies each
 * attempted model and its individual failure reason* (Req 3.8), in attempt
 * order. The same list is mirrored into the {@link PlatformError} projection's
 * structured `details` so the enumeration crosses the REST_API, the
 * WebSocket_Gateway, and the SDK unchanged (Req 46.8).
 *
 * It projects to the platform-wide `provider_exhausted` category (HTTP 502,
 * code {@link PROVIDER_EXHAUSTED_CODE}) — the category reserved for "entire
 * fallback chain failed" (Req 3.8). A chain is never empty: a request with no
 * routable model surfaces a {@link NoEligibleModelError} *before* execution, so
 * this error always names at least one attempt.
 */
export class ProviderExhaustedError extends Error {
  /** Every model tried and the reason it failed, in attempt order (Req 3.8). */
  readonly attempts: readonly FallbackAttempt[];

  constructor(attempts: readonly FallbackAttempt[]) {
    super(ProviderExhaustedError.buildMessage(attempts));
    this.name = 'ProviderExhaustedError';
    // Defensive copy so the recorded enumeration cannot be mutated after the fact.
    this.attempts = attempts.map((attempt) => ({ ...attempt }));
  }

  /**
   * Build the human-readable message enumerating every attempted model and its
   * failure reason (Req 3.8), e.g.
   * `All 2 models in the fallback chain failed: "gpt-4o" (timeout: ...); "claude" (provider_error: ...)`.
   */
  private static buildMessage(attempts: readonly FallbackAttempt[]): string {
    const enumerated = attempts
      .map((attempt) => `"${attempt.modelId}" (${attempt.kind}: ${attempt.reason})`)
      .join('; ');
    return `All ${attempts.length} model(s) in the fallback chain failed: ${enumerated}`;
  }

  /**
   * Project this exhaustion into the platform-wide serializable error shape
   * (category `provider_exhausted`, code {@link PROVIDER_EXHAUSTED_CODE}),
   * carrying the ordered per-model attempts in the structured `details` so the
   * enumeration is machine-readable on every transport (Req 3.8, 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'provider_exhausted',
      code: PROVIDER_EXHAUSTED_CODE,
      message: this.message,
      correlationId,
      details: {
        attempts: this.attempts.map((attempt) => ({
          modelId: attempt.modelId,
          kind: attempt.kind,
          reason: attempt.reason,
        })),
      },
    });
  }
}
