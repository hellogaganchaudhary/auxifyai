/**
 * Native-ingestion wiring typed errors (Req 26.8, 27.9, 28.5, 29.1).
 *
 * The native-ingestion module is pure composition, so its only *rejection*
 * error is a wiring/configuration fault — a content type with no configured
 * destination. A *runtime* failure to index a write is NOT a thrown error here:
 * by design it is recorded through the
 * {@link import('./types.js').IngestionFailureRecorder} as a
 * {@link import('./types.js').NativeIngestionFailure} and never propagated back
 * to the originating module write (Req 23.8 resilience). This keeps the
 * ingestion-on-write seam fire-and-forget from the writer's perspective.
 *
 *  - {@link UnknownNativeSourceError} — a native content type was forwarded for
 *    ingestion (or registered for unified search) with no configured knowledge
 *    source / searcher, so the wiring cannot route it (fail-closed).
 *
 * It projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, carrying structured, secret-free `details`.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { NativeIngestionSourceType } from './types.js';

/** The stable machine-readable code for a native content type with no configured source (Req 26.8). */
export const UNKNOWN_NATIVE_SOURCE_CODE = 'NATIVE_INGESTION_UNKNOWN_SOURCE' as const;

/**
 * Thrown when a native content type has no configured knowledge source (a
 * {@link import('./types.js').NativeSourceResolver} that resolves none, or a
 * static map missing the type), so a write cannot be routed to the
 * Knowledge_Ingestion_Service (Req 26.8, 27.9, 28.5).
 *
 * This is a deployment/wiring fault, not a per-write runtime failure (those are
 * recorded, not thrown — Req 23.8). Categorized `validation` (an unserviceable
 * configuration).
 */
export class UnknownNativeSourceError extends Error {
  /** The native content type that has no configured source. */
  readonly type: NativeIngestionSourceType;

  constructor(type: NativeIngestionSourceType) {
    super(`No knowledge source is configured for native content type "${type}"`);
    this.name = 'UnknownNativeSourceError';
    this.type = type;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link UNKNOWN_NATIVE_SOURCE_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNKNOWN_NATIVE_SOURCE_CODE,
      message: this.message,
      correlationId,
      details: { type: this.type },
    });
  }
}
