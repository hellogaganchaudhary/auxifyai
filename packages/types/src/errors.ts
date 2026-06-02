/**
 * The serializable, typed error and result model shared across the REST_API,
 * the WebSocket_Gateway, and the Client_SDK (Req 46.8).
 *
 * Errors are modeled as typed, serializable values so the exact same shape
 * crosses every transport: REST returns it as problem-detail JSON and the
 * WebSocket_Gateway emits it as a typed error event (Req 45.5). Failures
 * default to safe/denying outcomes, never leak internals (Req 34.7), and carry
 * a `correlationId` tying the error to logs/traces (Req 46.7) plus an explicit
 * `retriable` flag with retry-after hints for client-retriable errors.
 */

/**
 * The category of a {@link PlatformError}, aligned to its surfaced HTTP status.
 *
 * Categories are stable and exhaustive so clients can branch on them uniformly:
 * - `authentication` — 401, identity not established.
 * - `authorization` — 403, fail-closed deny (Req 19, 34.8).
 * - `validation` — 400, input failed schema/sanitization (Req 16.2, 34.4).
 * - `rate_limited` — 429, per user/key/IP/domain (Req 14.6, 34.3, 45.7).
 * - `quota_exceeded` — 402/429, storage, budget, per-model caps (Req 11.8, 11.9, 22.x).
 * - `provider_unavailable` — 502/503, AI or search provider down (Req 2.10, 13.9).
 * - `provider_exhausted` — 502, entire fallback chain failed (Req 3.8).
 * - `compliance_blocked` — 451, compliance unverifiable (Req 38.6).
 * - `billing_blocked` — 403, credit-billing unverifiable (Req 43.5).
 * - `not_found` — 404, resource absent or out of tenant scope.
 * - `conflict` — 409, version/state conflict.
 * - `sandbox_limit` — 422, timeout/memory/unauthorized package (Req 18.3, 18.4, 18.6).
 * - `internal` — 500, unexpected, never leaks internals.
 */
export type ErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'validation'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'provider_unavailable'
  | 'provider_exhausted'
  | 'compliance_blocked'
  | 'billing_blocked'
  | 'not_found'
  | 'conflict'
  | 'sandbox_limit'
  | 'internal';

/** All {@link ErrorCategory} values, for iteration, validation, and test generators. */
export const ERROR_CATEGORIES: readonly ErrorCategory[] = [
  'authentication',
  'authorization',
  'validation',
  'rate_limited',
  'quota_exceeded',
  'provider_unavailable',
  'provider_exhausted',
  'compliance_blocked',
  'billing_blocked',
  'not_found',
  'conflict',
  'sandbox_limit',
  'internal',
] as const;

/**
 * The canonical HTTP status code each {@link ErrorCategory} surfaces as over
 * the REST_API. The WebSocket_Gateway carries the same category in its typed
 * error events (Req 45.5).
 */
export const ERROR_CATEGORY_HTTP_STATUS: Readonly<Record<ErrorCategory, number>> = {
  authentication: 401,
  authorization: 403,
  validation: 400,
  rate_limited: 429,
  quota_exceeded: 429,
  provider_unavailable: 503,
  provider_exhausted: 502,
  compliance_blocked: 451,
  billing_blocked: 403,
  not_found: 404,
  conflict: 409,
  sandbox_limit: 422,
  internal: 500,
};

/**
 * The categories that are client-retriable by default.
 *
 * Client-retriable errors (`rate_limited`, `provider_unavailable`, and
 * transient `internal`) carry `retriable: true`; for rate limiting a
 * retry-after hint is included. All other categories are terminal for the
 * request.
 */
export const RETRIABLE_ERROR_CATEGORIES: readonly ErrorCategory[] = [
  'rate_limited',
  'provider_unavailable',
  'internal',
] as const;

/**
 * The serializable, typed error carried uniformly across every transport.
 *
 * Internal exceptions are never propagated verbatim; they are logged with the
 * `correlationId` and returned as an `internal` error with a safe, secret-free
 * `message` (Req 34.7). `details` carries structured, category-specific context
 * (for example, the attempted models for `provider_exhausted`, Req 3.8).
 */
export interface PlatformError {
  /** The error category, which also determines the surfaced HTTP status. */
  category: ErrorCategory;
  /** A stable machine-readable code, e.g. `MODEL_NOT_AUTHORIZED`. */
  code: string;
  /** A human-readable, secret-free message safe to show to clients (Req 34.7). */
  message: string;
  /** Optional structured, category-specific context (e.g. attempted models). */
  details?: unknown;
  /** Ties the error to logs/traces across services (Req 46.7). */
  correlationId: string;
  /** Whether the client may retry the same request. */
  retriable: boolean;
  /**
   * For `rate_limited` (and other retriable) errors, the number of seconds the
   * client should wait before retrying. Omitted when no hint is available.
   */
  retryAfterSeconds?: number;
}

/**
 * A successful result wrapping a value.
 *
 * @typeParam T The success payload type.
 */
export interface Ok<T> {
  /** Discriminant marking a successful result. */
  ok: true;
  /** The success payload. */
  value: T;
}

/**
 * A failed result wrapping a {@link PlatformError}.
 */
export interface Err {
  /** Discriminant marking a failed result. */
  ok: false;
  /** The typed error describing the failure. */
  error: PlatformError;
}

/**
 * The discriminated result shape returned across the REST_API, the
 * WebSocket_Gateway, and the Client_SDK. Callers branch on `ok` to narrow to a
 * value or a {@link PlatformError} without throwing.
 *
 * @typeParam T The success payload type.
 */
export type Result<T> = Ok<T> | Err;

/**
 * Determine whether an {@link ErrorCategory} is client-retriable by default.
 *
 * @param category The error category to test.
 * @returns `true` if a client may retry an error of this category.
 */
export function isRetriableCategory(category: ErrorCategory): boolean {
  return RETRIABLE_ERROR_CATEGORIES.includes(category);
}

/**
 * The fields needed to construct a {@link PlatformError}; `retriable` defaults
 * from the category and may be overridden for transient cases (e.g. a
 * transient `internal` error).
 */
export interface CreatePlatformErrorInput {
  /** The error category (determines the default `retriable` value and HTTP status). */
  category: ErrorCategory;
  /** A stable machine-readable code. */
  code: string;
  /** A human-readable, secret-free message. */
  message: string;
  /** Correlation id tying the error to logs/traces. */
  correlationId: string;
  /** Optional structured, category-specific context. */
  details?: unknown;
  /** Override the category default for retriability (e.g. a transient `internal`). */
  retriable?: boolean;
  /** Retry-after hint in seconds (typically for `rate_limited`). */
  retryAfterSeconds?: number;
}

/**
 * Construct a well-formed {@link PlatformError}, defaulting `retriable` from the
 * category unless explicitly overridden.
 *
 * @param input The error fields.
 * @returns A fully-populated, serializable platform error.
 */
export function createPlatformError(input: CreatePlatformErrorInput): PlatformError {
  const retriable = input.retriable ?? isRetriableCategory(input.category);
  const error: PlatformError = {
    category: input.category,
    code: input.code,
    message: input.message,
    correlationId: input.correlationId,
    retriable,
  };
  if (input.details !== undefined) {
    error.details = input.details;
  }
  if (input.retryAfterSeconds !== undefined) {
    error.retryAfterSeconds = input.retryAfterSeconds;
  }
  return error;
}

/**
 * The canonical HTTP status code for a {@link PlatformError}'s category.
 *
 * @param error The platform error.
 * @returns The HTTP status code the REST_API surfaces for the error.
 */
export function httpStatusForError(error: PlatformError): number {
  return ERROR_CATEGORY_HTTP_STATUS[error.category];
}

/** Wrap a value in a successful {@link Result}. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Wrap a {@link PlatformError} in a failed {@link Result}. */
export function err(error: PlatformError): Err {
  return { ok: false, error };
}

/**
 * Type guard narrowing a {@link Result} to its successful {@link Ok} variant.
 */
export function isOk<T>(result: Result<T>): result is Ok<T> {
  return result.ok;
}

/**
 * Type guard narrowing a {@link Result} to its failed {@link Err} variant.
 */
export function isErr<T>(result: Result<T>): result is Err {
  return !result.ok;
}
