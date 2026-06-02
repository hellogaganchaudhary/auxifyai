/**
 * Code_Sandbox typed errors (Req 18.2, 18.6).
 *
 * The Code_Sandbox draws a sharp line between *resource-limit outcomes* and
 * *rejections*. A timeout (Req 18.3) or a memory breach (Req 18.4) is an
 * ordinary {@link import('./types.js').SandboxResult}, not an error, because the
 * code actually ran. A rejection, by contrast, means the untrusted code was
 * never allowed to run at all, and is surfaced as a dedicated typed error so a
 * caller can branch on the exact violation without parsing messages:
 *
 *  - {@link UnsupportedLanguageError} — the requested runtime is not one of the
 *    supported runtimes (Python 3.12 / Node 22 / shell / read-only SQL, Req 18.2).
 *  - {@link UnauthorizedPackageError} — the source imports at least one package
 *    that is not on the Allow_List, so execution is rejected before it runs
 *    (Req 18.6, Property 39).
 *
 * Each projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, and carries structured, secret-free `details`. An unauthorized
 * import is the security-relevant rejection the design maps to the
 * `sandbox_limit` category (Req 18.6); an unsupported language is a plain
 * `validation` rejection.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { SandboxLanguage } from './types.js';

/** The stable machine-readable code for an unsupported sandbox language (Req 18.2). */
export const UNSUPPORTED_LANGUAGE_CODE = 'SANDBOX_UNSUPPORTED_LANGUAGE' as const;

/** The stable machine-readable code for a non-allow-listed import (Req 18.6). */
export const UNAUTHORIZED_PACKAGE_CODE = 'SANDBOX_UNAUTHORIZED_PACKAGE' as const;

/**
 * Thrown when a code-execution request names a runtime outside the supported
 * set (Python 3.12, Node.js 22, shell, read-only SQL) (Req 18.2).
 *
 * The offending {@link language} is carried so the rejection is self-describing.
 * Categorized `validation` (bad client input), distinct from the security-
 * relevant `sandbox_limit` used for an unauthorized import.
 */
export class UnsupportedLanguageError extends Error {
  /** The unsupported runtime that was requested. */
  readonly language: string;

  constructor(language: string) {
    super(
      `Language "${language}" is not supported by the Code_Sandbox ` +
        `(expected one of: python, node, shell, sql)`,
    );
    this.name = 'UnsupportedLanguageError';
    this.language = language;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link UNSUPPORTED_LANGUAGE_CODE}) (Req 18.2,
   * 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNSUPPORTED_LANGUAGE_CODE,
      message: this.message,
      correlationId,
      details: { language: this.language },
    });
  }
}

/**
 * Thrown when submitted code imports at least one package that is not on the
 * Allow_List, rejecting the execution before any code runs (Req 18.6,
 * Property 39).
 *
 * The full set of {@link unauthorizedPackages} that tripped the gate is carried
 * (sorted, deduplicated) so the caller can show exactly which imports must be
 * allow-listed. Categorized `sandbox_limit` per the design's error model
 * (Req 18.6), since it is a sandbox policy rejection rather than a malformed
 * request.
 */
export class UnauthorizedPackageError extends Error {
  /** The runtime whose import the rejection concerns. */
  readonly language: SandboxLanguage;
  /** The non-allow-listed package names that caused the rejection (sorted, unique). */
  readonly unauthorizedPackages: readonly string[];

  constructor(language: SandboxLanguage, unauthorizedPackages: readonly string[]) {
    const unique = [...new Set(unauthorizedPackages)].sort();
    super(
      `Execution rejected: ${language} code imports non-allow-listed package(s): ` +
        `${unique.join(', ')}`,
    );
    this.name = 'UnauthorizedPackageError';
    this.language = language;
    this.unauthorizedPackages = unique;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `sandbox_limit`, code {@link UNAUTHORIZED_PACKAGE_CODE}) (Req 18.6,
   * 46.8). The `sandbox_limit` category surfaces as HTTP 422.
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'sandbox_limit',
      code: UNAUTHORIZED_PACKAGE_CODE,
      message: this.message,
      correlationId,
      details: { language: this.language, unauthorizedPackages: this.unauthorizedPackages },
    });
  }
}
