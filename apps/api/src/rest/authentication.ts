/**
 * REST_API authentication — authenticate EVERY request BEFORE routing (Req 45.2,
 * 34.2, 34.8).
 *
 * Default-deny: a request to any non-public route must present EITHER a valid
 * JWT/session bearer token OR a valid API key; otherwise it is rejected with a
 * `401 authentication` PlatformError and NO handler runs. Authentication is
 * performed through two narrow injectable ports so this module never imports a
 * concrete service:
 *   - {@link JwtAuthenticator} — `validate(token)` resolving a {@link SessionIdentity};
 *     `AuthService.validate` structurally satisfies it.
 *   - {@link ApiKeyAuthenticator} — `authenticate(key)` resolving a {@link KeyAuthResult};
 *     `ApiKeyManager.authenticate` structurally satisfies it.
 *
 * Public auth endpoints (sign-in, token refresh) are the documented exception
 * (Req 45.2): they are marked `public` on their {@link RouteDefinition} and the
 * dispatcher skips authentication for them.
 *
 * SECURITY: a token or key value is never logged or echoed — only the resolved,
 * non-secret identity (user id, organization, session/key id) is carried
 * forward on the {@link AuthenticatedContext}.
 */

import type { KeyAuthResult, MaskedKey, SessionIdentity } from '@auxify/core';
import {
  createPlatformError,
  tenantContextFromPrincipal,
  type PlatformError,
  type Principal,
} from '@auxify/types';

import type { AuthenticatedContext, RestRequest } from './types';

/**
 * The JWT / session authentication port (Req 45.2).
 *
 * `AuthService.validate` satisfies this structurally: it accepts a raw access
 * token and resolves the live session's {@link SessionIdentity}, throwing when
 * the token is unknown, expired, or revoked.
 */
export interface JwtAuthenticator {
  /**
   * Validate a presented access token and resolve its session identity.
   *
   * @param accessToken The raw bearer token presented by the client.
   * @returns The authenticated session identity for a live session.
   * @throws when the token is unknown, expired, or revoked.
   */
  validate(accessToken: string): Promise<SessionIdentity>;
}

/**
 * The API-key authentication port (Req 45.2).
 *
 * `ApiKeyManager.authenticate` satisfies this structurally: it accepts a raw
 * key and returns a structured {@link KeyAuthResult} (never throwing on an
 * invalid key, and never revealing whether a similar key exists).
 */
export interface ApiKeyAuthenticator {
  /**
   * Authenticate a presented raw API key.
   *
   * @param presented The raw API key string presented by the client.
   * @returns The structured authentication result.
   */
  authenticate(presented: string): Promise<KeyAuthResult>;
}

/** The outcome of authenticating a non-public request (Req 45.2). */
export type RestAuthOutcome =
  | { authenticated: true; context: AuthenticatedContext }
  | { authenticated: false; error: PlatformError };

/** Construction dependencies for the {@link RestAuthenticator} (all injectable). */
export interface RestAuthenticatorOptions {
  /** The JWT/session bearer authenticator (Req 45.2). */
  jwt?: JwtAuthenticator;
  /** The API-key authenticator (Req 45.2). */
  apiKey?: ApiKeyAuthenticator;
}

/** The header carrying a JWT/session bearer token. */
const AUTHORIZATION_HEADER = 'authorization';
/** The `Authorization` scheme prefix for a bearer token (case-insensitive). */
const BEARER_PREFIX = 'bearer ';
/** The header carrying a raw API key. */
const API_KEY_HEADER = 'x-api-key';

/**
 * Authenticates a request from a JWT bearer token or an API key, before routing
 * (Req 45.2). It tries the bearer token first (when present), then the API key;
 * a missing or invalid credential yields a `401 authentication` PlatformError so
 * the dispatcher can stop processing before any handler runs.
 */
export class RestAuthenticator {
  private readonly jwt: JwtAuthenticator | undefined;
  private readonly apiKey: ApiKeyAuthenticator | undefined;

  constructor(options: RestAuthenticatorOptions = {}) {
    this.jwt = options.jwt;
    this.apiKey = options.apiKey;
  }

  /**
   * Authenticate a request (Req 45.2).
   *
   * Resolves a JWT bearer token through the {@link JwtAuthenticator}, or an API
   * key through the {@link ApiKeyAuthenticator}, into an
   * {@link AuthenticatedContext}. A request with no credential, an unsupported
   * scheme, or an invalid/expired/revoked credential fails closed with a
   * `401 authentication` PlatformError.
   *
   * @param request The normalized incoming request.
   * @param correlationId The request's correlation id, copied onto any error.
   * @returns The authenticated context, or a 401 PlatformError.
   */
  async authenticate(request: RestRequest, correlationId: string): Promise<RestAuthOutcome> {
    const bearer = this.bearerToken(request);
    if (bearer !== null) {
      return this.authenticateJwt(bearer, correlationId);
    }

    const key = this.apiKeyValue(request);
    if (key !== null) {
      return this.authenticateApiKey(key, correlationId);
    }

    return this.failure(
      correlationId,
      'MISSING_CREDENTIALS',
      'request requires a JWT bearer token or an API key',
    );
  }

  /** Authenticate via the JWT/session port, mapping a thrown invalid-session to a 401. */
  private async authenticateJwt(token: string, correlationId: string): Promise<RestAuthOutcome> {
    if (this.jwt === undefined) {
      return this.failure(
        correlationId,
        'JWT_AUTH_UNAVAILABLE',
        'bearer-token authentication is not configured',
      );
    }
    let identity: SessionIdentity;
    try {
      identity = await this.jwt.validate(token);
    } catch {
      // A thrown InvalidSessionError (unknown/expired/revoked) is a clean 401;
      // the underlying reason is never surfaced to the client (Req 34.7).
      return this.failure(
        correlationId,
        'INVALID_TOKEN',
        'the presented bearer token is invalid or expired',
      );
    }
    const principal = principalFromSession(identity);
    return {
      authenticated: true,
      context: {
        principal,
        tenant: tenantContextFromPrincipal(principal),
        sessionId: identity.sessionId,
      },
    };
  }

  /** Authenticate via the API-key port, mapping any non-authenticated result to a 401. */
  private async authenticateApiKey(key: string, correlationId: string): Promise<RestAuthOutcome> {
    if (this.apiKey === undefined) {
      return this.failure(
        correlationId,
        'API_KEY_AUTH_UNAVAILABLE',
        'API-key authentication is not configured',
      );
    }
    let result: KeyAuthResult;
    try {
      result = await this.apiKey.authenticate(key);
    } catch {
      return this.failure(
        correlationId,
        'INVALID_API_KEY',
        'the presented API key is invalid',
      );
    }
    if (!result.authenticated) {
      return this.failure(
        correlationId,
        'INVALID_API_KEY',
        'the presented API key is invalid',
      );
    }
    const principal = principalFromKey(result.key);
    return {
      authenticated: true,
      context: {
        principal,
        tenant: tenantContextFromPrincipal(principal),
        apiKeyId: result.key.id,
      },
    };
  }

  /** Extract the raw bearer token from the `Authorization` header, or `null`. */
  private bearerToken(request: RestRequest): string | null {
    const header = headerValue(request.headers, AUTHORIZATION_HEADER);
    if (header === undefined) {
      return null;
    }
    if (header.toLowerCase().startsWith(BEARER_PREFIX)) {
      const token = header.slice(BEARER_PREFIX.length).trim();
      return token.length > 0 ? token : null;
    }
    return null;
  }

  /** Extract the raw API key from the `X-API-Key` header, or `null`. */
  private apiKeyValue(request: RestRequest): string | null {
    const header = headerValue(request.headers, API_KEY_HEADER);
    if (header === undefined) {
      return null;
    }
    const trimmed = header.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** Build a `401 authentication` failure outcome. */
  private failure(correlationId: string, code: string, message: string): RestAuthOutcome {
    return {
      authenticated: false,
      error: createPlatformError({
        category: 'authentication',
        code,
        message,
        correlationId,
      }),
    };
  }
}

/**
 * Build the minimal authenticated {@link Principal} from a session identity
 * (Req 45.2). The authorization-only fields the session does not carry
 * (memberships, allowed models, premium authorization) default to the
 * most-restrictive empty/false; a downstream Access_Control gate enriches them
 * from the user record when finer authorization is required.
 */
function principalFromSession(identity: SessionIdentity): Principal {
  return {
    userId: identity.userId,
    organizationId: identity.organizationId,
    roles: [...identity.roles],
    teamIds: [],
    projectIds: [],
    allowedModels: [],
    premiumAuthorized: false,
    sessionId: identity.sessionId,
  };
}

/**
 * Build the minimal authenticated {@link Principal} from an authenticated API
 * key (Req 45.2). The key's owner and Organization identify the principal; the
 * authorization-only fields default to the most-restrictive empty/false.
 */
function principalFromKey(key: MaskedKey): Principal {
  return {
    userId: key.ownerId,
    organizationId: key.organizationId,
    roles: [],
    teamIds: [],
    projectIds: [],
    allowedModels: [],
    premiumAuthorized: false,
  };
}

/** Case-insensitive header lookup over a plain record. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}
