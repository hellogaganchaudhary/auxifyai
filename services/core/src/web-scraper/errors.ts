/**
 * Web_Scraper and Browser_Automation typed errors (Req 14.1-14.7).
 *
 * Scraping reaches out to *untrusted* external pages, so every failure mode is
 * surfaced as a dedicated, typed error rather than a leaked exception or a
 * silent empty result:
 *
 *  - {@link ScrapeFetchError} — the page could not be retrieved (network
 *    failure, or a non-OK HTTP status such as 403/404/5xx) (Req 14.1).
 *  - {@link RobotsDisallowedError} — the target path is disallowed by the
 *    domain's `robots.txt`, so the scrape is skipped (Req 14.5).
 *  - {@link BrowserAutomationError} — a headless-browser render or action run
 *    failed (Req 14.2, 14.7).
 *  - {@link InvalidUrlError} — the supplied URL is not a usable absolute URL.
 *
 * Each projects into the platform-wide serializable {@link PlatformError} so the
 * same wire shape crosses the REST_API, the WebSocket_Gateway, and the SDK
 * (Req 46.8), and each carries structured, secret-free `details` (the URL,
 * status, or robots rule) so a client can render an exact explanation. A
 * fetch/browser failure maps to `provider_unavailable` (a transient, retriable
 * upstream problem); a robots disallow maps to `authorization` (a deliberate,
 * non-retriable refusal to fetch); an invalid URL maps to `validation`.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** The stable machine-readable code for a failed page fetch (Req 14.1). */
export const SCRAPE_FETCH_FAILED_CODE = 'SCRAPE_FETCH_FAILED' as const;

/** The stable machine-readable code for a robots.txt-disallowed path (Req 14.5). */
export const ROBOTS_DISALLOWED_CODE = 'ROBOTS_DISALLOWED' as const;

/** The stable machine-readable code for a headless-browser failure (Req 14.2, 14.7). */
export const BROWSER_AUTOMATION_FAILED_CODE = 'BROWSER_AUTOMATION_FAILED' as const;

/** The stable machine-readable code for an unusable scrape/browse URL. */
export const INVALID_URL_CODE = 'INVALID_SCRAPE_URL' as const;

/**
 * Thrown when a page cannot be fetched: the network request failed, or the
 * upstream returned a non-OK HTTP status (Req 14.1).
 *
 * The offending {@link url} and the {@link status} (when an HTTP response was
 * received; `undefined` for a pure network failure) are carried so the caller
 * can distinguish a blocked page (403) from a missing one (404) or a flaky
 * upstream (5xx) without parsing the message.
 */
export class ScrapeFetchError extends Error {
  /** The URL whose fetch failed. */
  readonly url: string;
  /** The HTTP status, when a response was received; `undefined` for a network failure. */
  readonly status: number | undefined;

  constructor(url: string, status?: number, cause?: string) {
    super(
      `Failed to fetch "${url}"` +
        (status !== undefined ? ` (HTTP ${status})` : '') +
        (cause !== undefined ? `: ${cause}` : ''),
    );
    this.name = 'ScrapeFetchError';
    this.url = url;
    this.status = status;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `provider_unavailable`, code {@link SCRAPE_FETCH_FAILED_CODE}),
   * carrying the URL and status in structured `details` (Req 14.1, 46.8). The
   * category is retriable so a client may retry a transient upstream failure.
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'provider_unavailable',
      code: SCRAPE_FETCH_FAILED_CODE,
      message: this.message,
      correlationId,
      details: { url: this.url, status: this.status },
    });
  }
}

/**
 * Thrown when a target path is disallowed by the domain's `robots.txt` and the
 * scrape is therefore skipped (Req 14.5).
 *
 * The {@link url} and the matched disallow {@link rule} are carried so the
 * refusal is self-describing.
 */
export class RobotsDisallowedError extends Error {
  /** The URL whose path is disallowed. */
  readonly url: string;
  /** The matched `Disallow:` rule path from `robots.txt`. */
  readonly rule: string;

  constructor(url: string, rule: string) {
    super(`Scraping "${url}" is disallowed by robots.txt (Disallow: ${rule})`);
    this.name = 'RobotsDisallowedError';
    this.url = url;
    this.rule = rule;
  }

  /**
   * Project this refusal into the platform-wide serializable error shape
   * (category `authorization`, code {@link ROBOTS_DISALLOWED_CODE}) (Req 14.5,
   * 46.8). The category is non-retriable: retrying would not change the
   * site's stated policy.
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authorization',
      code: ROBOTS_DISALLOWED_CODE,
      message: this.message,
      correlationId,
      details: { url: this.url, rule: this.rule },
    });
  }
}

/**
 * Thrown when a headless-browser render (Req 14.2) or an action run (Req 14.7)
 * fails.
 *
 * The {@link url} and a safe {@link reason} are carried; the underlying engine
 * exception is never propagated verbatim (Req 34.7).
 */
export class BrowserAutomationError extends Error {
  /** The URL the browser was driving. */
  readonly url: string;
  /** A safe, secret-free description of what failed. */
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`Browser automation failed for "${url}": ${reason}`);
    this.name = 'BrowserAutomationError';
    this.url = url;
    this.reason = reason;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `provider_unavailable`, code {@link BROWSER_AUTOMATION_FAILED_CODE})
   * (Req 14.2, 14.7, 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'provider_unavailable',
      code: BROWSER_AUTOMATION_FAILED_CODE,
      message: this.message,
      correlationId,
      details: { url: this.url, reason: this.reason },
    });
  }
}

/**
 * Thrown when a supplied scrape/browse URL is not a usable absolute `http`/
 * `https` URL.
 *
 * Failing closed on a malformed URL keeps the scraper from issuing requests to
 * unexpected schemes (e.g. `file:`/`javascript:`).
 */
export class InvalidUrlError extends Error {
  /** The rejected URL string. */
  readonly url: string;

  constructor(url: string, reason = 'not an absolute http(s) URL') {
    super(`Invalid scrape URL "${url}": ${reason}`);
    this.name = 'InvalidUrlError';
    this.url = url;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link INVALID_URL_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_URL_CODE,
      message: this.message,
      correlationId,
      details: { url: this.url },
    });
  }
}
