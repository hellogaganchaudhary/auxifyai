/**
 * Knowledge_Ingestion_Service typed errors (Req 23.2, 23.8, 23.9).
 *
 * The ingest path enforces its preconditions with dedicated, typed errors so
 * callers can branch on the exact failure without parsing messages:
 *
 *  - {@link UnknownSourceError} — an ingest/re-index referenced a source id that
 *    does not exist within the caller's Organization.
 *  - {@link MissingSourceFetcherError} — a *native* source type (Req 23.1) has no
 *    registered {@link import('./types.js').SourceFetcher}. This is a hard
 *    configuration error, unlike a missing *optional* connector, which degrades
 *    gracefully (Req 23.9).
 *  - {@link ConnectorUnavailableError} — an optional external connector (Req 23.2)
 *    is unavailable. Thrown by a connector {@link import('./types.js').SourceFetcher}
 *    and handled by the service so native knowledge keeps serving uninterrupted
 *    (Req 23.9, Property 31).
 *
 * Each projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, and carries structured `details` so a client can render an exact,
 * secret-free explanation.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { ConnectorSourceType, KnowledgeSourceType } from './types.js';

/** The stable machine-readable code for an unknown knowledge source. */
export const UNKNOWN_SOURCE_CODE = 'KNOWLEDGE_SOURCE_NOT_FOUND' as const;

/** The stable machine-readable code for a native source with no registered fetcher. */
export const MISSING_SOURCE_FETCHER_CODE = 'KNOWLEDGE_SOURCE_FETCHER_MISSING' as const;

/** The stable machine-readable code for an unavailable optional connector (Req 23.9). */
export const CONNECTOR_UNAVAILABLE_CODE = 'KNOWLEDGE_CONNECTOR_UNAVAILABLE' as const;

/**
 * Thrown when an ingest or re-index references a source id that does not exist
 * within the caller's Organization.
 *
 * Modelled as `not_found` so a cross-tenant reference (a source in another
 * Organization) is indistinguishable from a genuinely absent one, never leaking
 * existence across the tenant boundary (Req 1.4).
 */
export class UnknownSourceError extends Error {
  /** The source id that could not be resolved. */
  readonly sourceId: string;

  constructor(sourceId: string) {
    super(`Knowledge source "${sourceId}" was not found in this organization`);
    this.name = 'UnknownSourceError';
    this.sourceId = sourceId;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `not_found`, code {@link UNKNOWN_SOURCE_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: UNKNOWN_SOURCE_CODE,
      message: this.message,
      correlationId,
      details: { sourceId: this.sourceId },
    });
  }
}

/**
 * Thrown when a *native* source type (Req 23.1) has no registered
 * {@link import('./types.js').SourceFetcher}.
 *
 * A native source is part of the platform and must always be ingestible, so a
 * missing fetcher is a deployment/configuration bug surfaced as `internal`. An
 * *optional* connector with no fetcher is treated very differently — it degrades
 * gracefully via {@link ConnectorUnavailableError} (Req 23.9).
 */
export class MissingSourceFetcherError extends Error {
  /** The native source type that had no fetcher. */
  readonly sourceType: KnowledgeSourceType;

  constructor(sourceType: KnowledgeSourceType) {
    super(`No fetcher is registered for native knowledge source type "${sourceType}"`);
    this.name = 'MissingSourceFetcherError';
    this.sourceType = sourceType;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `internal`, code {@link MISSING_SOURCE_FETCHER_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'internal',
      code: MISSING_SOURCE_FETCHER_CODE,
      message: this.message,
      correlationId,
      details: { sourceType: this.sourceType },
    });
  }
}

/**
 * Thrown by a connector {@link import('./types.js').SourceFetcher} when its
 * optional external product is unavailable (Req 23.2, 23.9).
 *
 * The Knowledge_Ingestion_Service catches this and returns a
 * `connector_unavailable` report rather than propagating, so native knowledge
 * sources keep serving without interruption (Req 23.9, Property 31). The
 * platform projection is `provider_unavailable` and `retriable`, matching how
 * the Web_Search_Engine reports an unavailable provider.
 */
export class ConnectorUnavailableError extends Error {
  /** The optional connector that was unavailable. */
  readonly connector: ConnectorSourceType;

  constructor(connector: ConnectorSourceType, detail?: string) {
    super(
      `Optional connector "${connector}" is unavailable` +
        (detail !== undefined ? `: ${detail}` : ''),
    );
    this.name = 'ConnectorUnavailableError';
    this.connector = connector;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `provider_unavailable`, code {@link CONNECTOR_UNAVAILABLE_CODE})
   * (Req 23.9, 46.8). Marked retriable by the category default so a client may
   * retry once the connector recovers.
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'provider_unavailable',
      code: CONNECTOR_UNAVAILABLE_CODE,
      message: this.message,
      correlationId,
      details: { connector: this.connector },
    });
  }
}
