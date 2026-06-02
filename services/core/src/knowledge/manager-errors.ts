/**
 * Knowledge_Manager typed errors (Req 25.1-25.5).
 *
 * The administration surface enforces its preconditions with dedicated, typed
 * errors so callers can branch on the exact failure without parsing messages:
 *
 *  - {@link UnknownCollectionError} — an operation referenced a collection id
 *    that does not exist within the caller's Organization.
 *  - {@link InvalidCollectionInputError} — a {@link import('./knowledge-manager-types.js').CreateCollectionInput}
 *    was structurally invalid (e.g. a blank name or owner scope id).
 *
 * Each projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, and carries structured `details` so a client can render an exact,
 * secret-free explanation.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** The stable machine-readable code for an unknown knowledge collection. */
export const UNKNOWN_COLLECTION_CODE = 'KNOWLEDGE_COLLECTION_NOT_FOUND' as const;

/** The stable machine-readable code for invalid collection input. */
export const INVALID_COLLECTION_INPUT_CODE = 'KNOWLEDGE_COLLECTION_INVALID' as const;

/**
 * Thrown when an operation references a collection id that does not exist within
 * the caller's Organization.
 *
 * Modelled as `not_found` so a cross-tenant reference (a collection in another
 * Organization) is indistinguishable from a genuinely absent one, never leaking
 * existence across the tenant boundary (Req 1.4).
 */
export class UnknownCollectionError extends Error {
  /** The collection id that could not be resolved. */
  readonly collectionId: string;

  constructor(collectionId: string) {
    super(`Knowledge collection "${collectionId}" was not found in this organization`);
    this.name = 'UnknownCollectionError';
    this.collectionId = collectionId;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `not_found`, code {@link UNKNOWN_COLLECTION_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: UNKNOWN_COLLECTION_CODE,
      message: this.message,
      correlationId,
      details: { collectionId: this.collectionId },
    });
  }
}

/**
 * Thrown when a collection cannot be created because its input is structurally
 * invalid — a blank name or a blank owner scope id (Req 25.1).
 *
 * Surfaced as `validation` so a client can correct the request and retry.
 */
export class InvalidCollectionInputError extends Error {
  /** The name of the offending field. */
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid knowledge collection input: ${field} ${reason}`);
    this.name = 'InvalidCollectionInputError';
    this.field = field;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `validation`, code {@link INVALID_COLLECTION_INPUT_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_COLLECTION_INPUT_CODE,
      message: this.message,
      correlationId,
      details: { field: this.field },
    });
  }
}
