/**
 * Integration_Service typed errors (Req 30.1, 30.2, 30.5).
 *
 * The Integration_Service is deliberately frugal with errors: its core
 * availability query NEVER throws (it degrades gracefully to `unavailable`, so
 * native operation continues uninterrupted — Req 30.3, 30.4). Errors are
 * reserved for genuine caller mistakes on the management path:
 *
 *   - {@link UnknownConnectorTypeError} — an enable/disable/credentials call
 *     named a connector type the platform does not support;
 *   - {@link ConnectorNotEnabledError} — a credentials/management call targeted a
 *     connector the Organization has not registered.
 *
 * Each projects into the platform-wide serializable {@link PlatformError} shape
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, and carries structured, secret-free `details` (never any
 * credential material — Req 30.5).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** Stable machine-readable code for an unsupported connector type. */
export const UNKNOWN_CONNECTOR_TYPE_CODE = 'INTEGRATION_CONNECTOR_TYPE_UNKNOWN' as const;

/** Stable machine-readable code for a connector that is not registered/enabled. */
export const CONNECTOR_NOT_ENABLED_CODE = 'INTEGRATION_CONNECTOR_NOT_ENABLED' as const;

/**
 * Thrown when a management call names a connector type the platform does not
 * support (Req 30.1, 30.2).
 *
 * Surfaced as `validation` — the input named an unknown connector, a caller
 * mistake rather than a missing resource.
 */
export class UnknownConnectorTypeError extends Error {
  /** The unsupported connector type that was supplied. */
  readonly connectorType: string;

  constructor(connectorType: string) {
    super(`"${connectorType}" is not a supported integration connector type`);
    this.name = 'UnknownConnectorTypeError';
    this.connectorType = connectorType;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNKNOWN_CONNECTOR_TYPE_CODE,
      message: this.message,
      correlationId,
      details: { connectorType: this.connectorType },
    });
  }
}

/**
 * Thrown when a credentials/management call targets a connector the Organization
 * has not registered (Req 30.2, 30.5).
 *
 * Surfaced as `not_found` so a connector belonging to another Organization is
 * indistinguishable from a genuinely unregistered one, never leaking existence
 * across the tenant boundary (Req 1.4).
 */
export class ConnectorNotEnabledError extends Error {
  /** The connector type that was not registered for the Organization. */
  readonly connectorType: string;

  constructor(connectorType: string) {
    super(`Connector "${connectorType}" is not registered for this organization`);
    this.name = 'ConnectorNotEnabledError';
    this.connectorType = connectorType;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: CONNECTOR_NOT_ENABLED_CODE,
      message: this.message,
      correlationId,
      details: { connectorType: this.connectorType },
    });
  }
}
