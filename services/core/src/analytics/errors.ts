/**
 * Analytics_Service typed errors (Req 31.7).
 *
 * The Analytics_Service raises exactly one *rejection* error — an attempt to
 * query analytics for an Organization, Team, or Project the viewer is not
 * authorized to see. It projects into the platform-wide serializable
 * {@link PlatformError} (Req 46.8) so the same wire shape crosses the REST_API,
 * the WebSocket_Gateway, and the SDK, carrying structured, secret-free
 * `details`:
 *
 *  - {@link UnauthorizedAnalyticsScopeError} — a query named an Organization,
 *    Team, or Project outside the viewer's authorized {@link AnalyticsScope}, so
 *    serving it would leak data across a tenant boundary (fail-closed,
 *    Req 31.7). Categorized `authorization` (a 403 fail-closed deny).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** The kind of scope dimension a query violated. */
export type AnalyticsScopeDimension = 'organization' | 'team' | 'project';

/** The stable machine-readable code for an out-of-scope analytics query (Req 31.7). */
export const UNAUTHORIZED_ANALYTICS_SCOPE_CODE = 'ANALYTICS_SCOPE_UNAUTHORIZED' as const;

/**
 * Thrown when a viewer's query references an Organization, Team, or Project
 * outside their authorized {@link import('./types.js').AnalyticsScope} (Req 31.7).
 *
 * The service fails closed rather than silently widening or narrowing the view,
 * so a query can never return data the administrator is not authorized to see.
 * Categorized `authorization`.
 */
export class UnauthorizedAnalyticsScopeError extends Error {
  /** The scope dimension that was violated. */
  readonly dimension: AnalyticsScopeDimension;
  /** The specific id the query requested that fell outside the authorized scope. */
  readonly requestedId: string;

  constructor(dimension: AnalyticsScopeDimension, requestedId: string) {
    super(`Analytics ${dimension} "${requestedId}" is outside the authorized scope`);
    this.name = 'UnauthorizedAnalyticsScopeError';
    this.dimension = dimension;
    this.requestedId = requestedId;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `authorization`, code {@link UNAUTHORIZED_ANALYTICS_SCOPE_CODE})
   * (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authorization',
      code: UNAUTHORIZED_ANALYTICS_SCOPE_CODE,
      message: this.message,
      correlationId,
      details: { dimension: this.dimension, requestedId: this.requestedId },
    });
  }
}
