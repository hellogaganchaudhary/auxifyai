/**
 * Unified_Search_Service typed errors (Req 29.4).
 *
 * The service enforces its few hard preconditions with dedicated, typed errors
 * so callers can branch on the exact failure without parsing messages:
 *
 *  - {@link DuplicateSearcherError} — two {@link import('./types.js').ContentTypeSearcher}s
 *    were registered for the same content type. This is a wiring/configuration
 *    bug surfaced as `internal`.
 *  - {@link UnknownContentTypeFilterError} — a content-type filter (Req 29.4)
 *    named a content type that has no registered searcher, so the service
 *    cannot honor the filter. Surfaced as `validation` so the caller can fix
 *    the request.
 *
 * Note that an *unavailable* content source is deliberately **not** an error:
 * the service catches a searcher failure and reports the type as unsearched in
 * the result (Req 29.7), so partial results degrade gracefully rather than
 * throwing.
 *
 * Each error projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, and carries structured, secret-free `details`.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { UnifiedSearchType } from './types.js';

/** The stable machine-readable code for a duplicate searcher registration. */
export const DUPLICATE_SEARCHER_CODE = 'UNIFIED_SEARCH_DUPLICATE_SEARCHER' as const;

/** The stable machine-readable code for a filter naming an unsearchable content type (Req 29.4). */
export const UNKNOWN_CONTENT_TYPE_FILTER_CODE = 'UNIFIED_SEARCH_UNKNOWN_CONTENT_TYPE' as const;

/**
 * Thrown when two {@link import('./types.js').ContentTypeSearcher}s are
 * registered for the same {@link UnifiedSearchType}.
 *
 * Each content type must have exactly one searcher so fan-out and grouping are
 * unambiguous; a duplicate is a deployment/wiring bug surfaced as `internal`.
 */
export class DuplicateSearcherError extends Error {
  /** The content type that had more than one registered searcher. */
  readonly contentType: UnifiedSearchType;

  constructor(contentType: UnifiedSearchType) {
    super(`A searcher is already registered for content type "${contentType}"`);
    this.name = 'DuplicateSearcherError';
    this.contentType = contentType;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `internal`, code {@link DUPLICATE_SEARCHER_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'internal',
      code: DUPLICATE_SEARCHER_CODE,
      message: this.message,
      correlationId,
      details: { contentType: this.contentType },
    });
  }
}

/**
 * Thrown when a content-type filter (Req 29.4) names a content type for which no
 * searcher is registered.
 *
 * The service cannot restrict results to a type it cannot search, so it rejects
 * the request as `validation` (rather than silently returning nothing) naming
 * the offending type and the set of searchable types.
 */
export class UnknownContentTypeFilterError extends Error {
  /** The filtered content type that had no registered searcher. */
  readonly contentType: UnifiedSearchType;
  /** The content types that do have a registered searcher. */
  readonly available: UnifiedSearchType[];

  constructor(contentType: UnifiedSearchType, available: readonly UnifiedSearchType[]) {
    super(
      `Content type "${contentType}" cannot be searched; no searcher is registered for it`,
    );
    this.name = 'UnknownContentTypeFilterError';
    this.contentType = contentType;
    this.available = [...available];
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `validation`, code {@link UNKNOWN_CONTENT_TYPE_FILTER_CODE})
   * (Req 29.4, 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNKNOWN_CONTENT_TYPE_FILTER_CODE,
      message: this.message,
      correlationId,
      details: { contentType: this.contentType, available: this.available },
    });
  }
}
