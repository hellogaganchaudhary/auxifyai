/**
 * Web_Search_Engine typed errors (Req 13.1, 13.9).
 *
 * The engine enforces its preconditions with dedicated, typed errors so callers
 * can branch on the exact failure without parsing messages:
 *
 *  - {@link ProviderUnavailableError} — the configured Search_Provider_Adapter is
 *    unavailable (Req 13.9). Projected as `provider_unavailable` so a search
 *    failure reports identically to an AI provider outage (Req 2.10) and is
 *    retriable.
 *  - {@link NoSearchProviderConfiguredError} — no provider is configured at all.
 *    Because the engine selects its provider purely from configuration
 *    (Req 13.1), an empty configuration is an operational/deployment error,
 *    surfaced as `provider_unavailable` and identifying that no provider is
 *    selected.
 *
 * Each projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, and carries structured `details` so a client can render an exact,
 * secret-free explanation — never including a provider API key (Req 34.7).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** The stable machine-readable code for an unavailable configured search provider (Req 13.9). */
export const PROVIDER_UNAVAILABLE_CODE = 'SEARCH_PROVIDER_UNAVAILABLE' as const;

/** The stable machine-readable code for an engine with no configured provider (Req 13.1). */
export const NO_PROVIDER_CONFIGURED_CODE = 'SEARCH_PROVIDER_NOT_CONFIGURED' as const;

/**
 * Thrown when the configured Search_Provider_Adapter is unavailable (Req 13.9).
 *
 * The error identifies the search provider by id so an operator can see exactly
 * which provider is down, mirroring how the Provider_Abstraction_Layer reports
 * an unavailable AI provider (Req 2.10). It never carries credentials.
 */
export class ProviderUnavailableError extends Error {
  /** The id of the provider that was unavailable. */
  readonly providerId: string;

  constructor(providerId: string, detail?: string) {
    super(
      `Search provider "${providerId}" is unavailable` +
        (detail !== undefined ? `: ${detail}` : ''),
    );
    this.name = 'ProviderUnavailableError';
    this.providerId = providerId;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `provider_unavailable`, code {@link PROVIDER_UNAVAILABLE_CODE})
   * (Req 13.9, 46.8). Retriable by the category default so a client may retry
   * once the provider recovers.
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'provider_unavailable',
      code: PROVIDER_UNAVAILABLE_CODE,
      message: this.message,
      correlationId,
      details: { providerId: this.providerId },
    });
  }
}

/**
 * Thrown when the engine has no configured search provider at all (Req 13.1).
 *
 * Selecting the active provider from configuration means an empty configuration
 * is a deployment error, not a runtime one. Surfaced as `provider_unavailable`
 * so the caller's handling is uniform with {@link ProviderUnavailableError}.
 */
export class NoSearchProviderConfiguredError extends Error {
  constructor() {
    super('No search provider is configured for the Web_Search_Engine');
    this.name = 'NoSearchProviderConfiguredError';
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `provider_unavailable`, code {@link NO_PROVIDER_CONFIGURED_CODE})
   * (Req 13.1, 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'provider_unavailable',
      code: NO_PROVIDER_CONFIGURED_CODE,
      message: this.message,
      correlationId,
    });
  }
}
