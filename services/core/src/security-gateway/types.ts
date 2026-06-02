/**
 * Security_Gateway domain types and injectable ports (Req 34.1, 34.2, 34.3,
 * 34.4, 34.5, 34.6, 34.8).
 *
 * The Security_Gateway is the request-edge guard every client request passes
 * through before it reaches a backend service. It composes the platform's
 * network and application defenses into a single fail-closed verdict: TLS 1.3
 * enforcement (Req 34.1), IP / abuse gating, per-user / per-key / per-IP rate
 * limiting (Req 34.3), authentication before routing (Req 34.2), input
 * validation and sanitization (Req 34.4), a CSRF token on state-changing
 * requests (Req 34.6), and authorization (Req 34.8) — defaulting to deny
 * whenever any stage cannot positively admit the request.
 *
 * These types describe the inputs and outputs of
 * {@link import('./security-gateway.js').SecurityGateway.evaluate}:
 *
 *   - {@link GatewayRequest} — the descriptor of an incoming request (transport,
 *     method, path, IP, claimed identity, CSRF tokens, body, …).
 *   - {@link GatewayVerdict} / {@link GatewayDenialCode} — the structured
 *     allow/deny verdict, mirroring Access_Control's
 *     {@link import('../access/index.js').AuthzDecision}, with a denial code
 *     naming the fail-closed stage that refused the request.
 *   - the narrow injectable ports the gateway composes — {@link IpReputation},
 *     {@link RateLimiter}, {@link Authenticator}, {@link RequestValidator},
 *     {@link CsrfVerifier}, {@link Authorizer} — and the {@link RateLimit} /
 *     {@link RateLimitConfig} / {@link RateLimitKey} rate-limit model plus the
 *     {@link SecurityGatewayClock} seam.
 *
 * Every port is a one-method (or near) interface so the gateway stays pure
 * orchestration and is fully unit-testable with the fakes in `./fakes.js` —
 * no real network, TLS terminator, rate-limit backend, or Auth_Service.
 */

import type { Principal } from '@auxify/types';

/**
 * The HTTP methods the gateway recognizes.
 *
 * The state-changing subset (`POST`, `PUT`, `PATCH`, `DELETE`) triggers the
 * CSRF check (Req 34.6); the safe methods (`GET`, `HEAD`, `OPTIONS`) do not.
 */
export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** All {@link HttpMethod} values, for iteration, validation, and test generators. */
export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;

/** The methods that mutate state and therefore require a valid CSRF token (Req 34.6). */
export const STATE_CHANGING_METHODS: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** The TLS version every client and inter-service connection must use (Req 34.1, 35.2). */
export const REQUIRED_TLS_VERSION = '1.3' as const;

/**
 * Transport-level facts about the connection the request arrived on.
 *
 * The gateway enforces TLS 1.3 (Req 34.1) from {@link tlsVersion}: a connection
 * negotiated at any lower version (or no TLS at all) is denied before any other
 * stage runs.
 */
export interface TransportInfo {
  /** The negotiated TLS version, e.g. `"1.3"`. A value other than {@link REQUIRED_TLS_VERSION} is denied. */
  tlsVersion: string;
}

/**
 * The descriptor of an incoming request as seen at the edge.
 *
 * It carries everything the fail-closed pipeline needs without coupling the
 * gateway to a concrete HTTP framework: the {@link TransportInfo}, the method
 * and path, the originating IP, any identity the request *claims* (a
 * {@link Principal} and/or an API-key id resolved by an upstream filter — used
 * for pre-auth rate-limit dimensions, then verified by the
 * {@link Authenticator}), CSRF tokens, headers, and the request body.
 */
export interface GatewayRequest {
  /** The transport the request arrived on, used to enforce TLS 1.3 (Req 34.1). */
  transport: TransportInfo;
  /** The HTTP method (Req 34.6 keys the CSRF check off this). */
  method: HttpMethod;
  /** The request path (validated and sanitized, Req 34.4). */
  path: string;
  /** The originating client IP address, used for IP/abuse gating and per-IP rate limiting (Req 34.3). */
  ip: string;
  /**
   * The identity the request claims, when an upstream filter resolved one. Used
   * only to derive the per-user rate-limit dimension before authentication; the
   * authoritative principal is the one the {@link Authenticator} returns (Req 34.2).
   */
  principal?: Principal;
  /** The API key id the request presents, when any — the per-key rate-limit dimension (Req 34.3). */
  apiKeyId?: string;
  /** The CSRF token submitted with the request (the double-submit header/body value, Req 34.6). */
  csrfToken?: string;
  /** The CSRF token bound to the session (the double-submit cookie value, Req 34.6). */
  csrfCookie?: string;
  /** Request headers (lower-cased keys recommended). */
  headers?: Record<string, string>;
  /** The request body (validated and sanitized before processing, Req 34.4). */
  body?: unknown;
  /** The originating user agent, recorded on a denial (Req 37.1). */
  userAgent?: string;
}

/**
 * The fail-closed stage that produced a gateway denial.
 *
 * Each value maps to a requirement so a caller (and the audit record) can tell
 * the denials apart:
 *   - `tls_required` — the connection did not negotiate TLS 1.3 (Req 34.1).
 *   - `ip_blocked` — the originating IP is on an abuse/block list (Req 34, WAF).
 *   - `rate_limited` — a per-user, per-key, or per-IP rate limit was exceeded (Req 34.3).
 *   - `unauthenticated` — the request could not be authenticated (Req 34.2, 34.8).
 *   - `invalid_request` — input failed validation/sanitization (Req 34.4).
 *   - `csrf_failed` — a state-changing request lacked a valid CSRF token (Req 34.6).
 *   - `unauthorized` — the authenticated principal is not authorized for the request (Req 34.8).
 *   - `fail_closed` — a security check could not be completed (a port errored), so
 *     the gateway denied by default rather than assuming success (Req 34.8).
 */
export type GatewayDenialCode =
  | 'tls_required'
  | 'ip_blocked'
  | 'rate_limited'
  | 'unauthenticated'
  | 'invalid_request'
  | 'csrf_failed'
  | 'unauthorized'
  | 'fail_closed';

/**
 * The verdict returned by {@link import('./security-gateway.js').SecurityGateway.evaluate}.
 *
 * `allowed` is `true` only when every applicable stage passed; in every other
 * case it is `false` and `denialCode` names the stage that denied. `reason` is a
 * human-readable explanation suitable for logs and audit metadata. On an allow,
 * {@link principal} carries the authenticated actor and {@link sanitizedBody}
 * the validated, sanitized request body the backend should process (Req 34.4).
 * On a `rate_limited` denial, {@link retryAfterSeconds} hints when to retry.
 */
export interface GatewayVerdict {
  /** Whether the request may proceed. Fail-closed: `false` unless every applicable stage passes. */
  allowed: boolean;
  /** A human-readable explanation of the verdict. */
  reason: string;
  /** The stage that denied, present only when `allowed` is `false`. */
  denialCode?: GatewayDenialCode;
  /** The authenticated actor, present when `allowed` is `true`. */
  principal?: Principal;
  /** The validated, sanitized request body to process, present when `allowed` is `true` (Req 34.4). */
  sanitizedBody?: unknown;
  /** For a `rate_limited` denial, the seconds the client should wait before retrying (Req 34.3, 45.7). */
  retryAfterSeconds?: number;
}

/**
 * A request rate limit (Req 34.3), modelled as a fixed count per rolling window:
 * at most {@link requestsPerWindow} requests are permitted within any
 * {@link windowSeconds}-second window. Mirrors the API_Key_Manager's
 * {@link import('../api-keys/index.js').RateLimit} shape so the two layers speak
 * the same rate-limit vocabulary.
 */
export interface RateLimit {
  /** The maximum number of requests permitted within each rolling window. */
  requestsPerWindow: number;
  /** The rolling window length, in seconds. */
  windowSeconds: number;
}

/** The dimension a rate limit is keyed on — per user, per API key, or per IP (Req 34.3). */
export type RateLimitDimension = 'user' | 'api_key' | 'ip';

/** All {@link RateLimitDimension} values, for iteration and test generators. */
export const RATE_LIMIT_DIMENSIONS: readonly RateLimitDimension[] = ['user', 'api_key', 'ip'];

/**
 * The per-dimension rate-limit configuration the gateway applies (Req 34.3).
 *
 * The gateway derives a {@link RateLimitKey} for each present dimension —
 * always the IP, plus the user and/or API key when the request carries them —
 * and asks the {@link RateLimiter} to admit the request only if no dimension is
 * over its limit.
 */
export interface RateLimitConfig {
  /** The per-user request limit (Req 34.3). */
  user: RateLimit;
  /** The per-API-key request limit (Req 34.3). */
  apiKey: RateLimit;
  /** The per-IP request limit (Req 34.3). */
  ip: RateLimit;
}

/**
 * A single rate-limit key the gateway asks the {@link RateLimiter} to account
 * for: the {@link dimension}, the {@link id} that scopes the counter (a user id,
 * API-key id, or IP), and the {@link limit} to enforce for it.
 */
export interface RateLimitKey {
  /** The dimension this key counts within (Req 34.3). */
  dimension: RateLimitDimension;
  /** The identifier the counter is scoped to (user id, API-key id, or IP). */
  id: string;
  /** The limit to enforce for this key. */
  limit: RateLimit;
}

/**
 * The decision a {@link RateLimiter} returns for a set of {@link RateLimitKey}s.
 *
 * `allowed` is `true` only when *no* key would exceed its limit by admitting the
 * request. On a denial, {@link exceededDimension} names the offending dimension
 * and {@link retryAfterSeconds} hints when its window frees up. An implementation
 * MUST NOT count a denied request against any dimension, so an admitted request
 * count never exceeds the configured limit (Property 44).
 */
export interface RateLimitDecision {
  /** Whether the request is within every keyed limit. */
  allowed: boolean;
  /** The dimension that was over its limit, present only when `allowed` is `false`. */
  exceededDimension?: RateLimitDimension;
  /** Seconds until the exceeded window frees up, present only when `allowed` is `false`. */
  retryAfterSeconds?: number;
}

/**
 * The narrow per-dimension rate-limiting port (Req 34.3) — injectable so the
 * gateway never hard-wires a counter backend.
 *
 * Production wires a distributed (e.g. Redis-backed) limiter; tests and simple
 * deployments use the bundled
 * {@link import('./rate-limiter.js').InMemoryRateLimiter}. `consume` is
 * all-or-nothing: it admits the request and accounts for it against every key,
 * or it admits nothing and accounts for nothing, naming the exceeded dimension.
 */
export interface RateLimiter {
  /**
   * Atomically test-and-record the request against every key (Req 34.3).
   *
   * @param keys The per-dimension keys (IP plus any user/API-key) to account for.
   * @param nowMs The current time in epoch milliseconds (supplied by the gateway's clock).
   * @returns Whether the request is within every limit; if not, the exceeded dimension.
   */
  consume(keys: readonly RateLimitKey[], nowMs: number): Promise<RateLimitDecision>;
}

/**
 * The verdict the {@link IpReputation} port returns for an originating IP.
 *
 * `blocked: true` denies the request as IP/abuse-gated (`ip_blocked`); the
 * optional {@link reason} is copied into the audit record.
 */
export interface IpReputationVerdict {
  /** Whether the IP is blocked (on an abuse/deny list). */
  blocked: boolean;
  /** An optional human-readable reason for the block. */
  reason?: string;
}

/**
 * The narrow IP / abuse-gating port (Req 34, WAF) — injectable so the gateway
 * never hard-wires a reputation/deny-list source.
 *
 * Production wires a WAF / threat-intel feed; tests use the bundled
 * {@link import('./ip-reputation.js').StaticIpReputation}. A `blocked` verdict
 * denies the request; an implementation that throws causes the gateway to fail
 * closed (deny `fail_closed`) rather than admit an un-screened request.
 */
export interface IpReputation {
  /**
   * Evaluate an originating IP against the abuse/deny list (Req 34).
   *
   * @param ip The originating client IP.
   * @returns Whether the IP is blocked.
   */
  evaluate(ip: string): Promise<IpReputationVerdict>;
}

/**
 * The outcome of authenticating a request (Req 34.2).
 *
 * `authenticated: true` carries the authoritative {@link Principal} the rest of
 * the pipeline (and the backend) acts on; `authenticated: false` carries a
 * reason and denies the request as `unauthenticated` (Req 34.8).
 */
export type AuthOutcome =
  | { authenticated: true; principal: Principal }
  | { authenticated: false; reason: string };

/**
 * The narrow authentication port (Req 34.2) — injectable so the gateway routes
 * requests through the Auth_Service / API_Key_Manager without importing them.
 *
 * Production wires an authenticator backed by the Auth_Service (session/JWT) and
 * the API_Key_Manager (API keys); tests use the fakes in `./fakes.js`. An
 * implementation that throws causes the gateway to fail closed (deny
 * `fail_closed`) — a request whose authentication could not be completed is
 * never routed (Req 34.2, 34.8).
 */
export interface Authenticator {
  /**
   * Authenticate the request before it is routed to a backend service (Req 34.2).
   *
   * @param request The incoming request descriptor.
   * @returns The authenticated principal, or a structured authentication failure.
   */
  authenticate(request: GatewayRequest): Promise<AuthOutcome>;
}

/**
 * The result of validating and sanitizing a request (Req 34.4).
 *
 * `valid: false` with one or more {@link issues} denies the request as
 * `invalid_request`. When valid, {@link sanitizedBody} carries the request body
 * with disallowed constructs neutralized, so the backend only ever processes
 * sanitized input.
 */
export interface ValidationResult {
  /** Whether the request passed validation. */
  valid: boolean;
  /** The validation issues found, present (non-empty) only when `valid` is `false`. */
  issues: string[];
  /** The sanitized request body, present when `valid` is `true` (Req 34.4). */
  sanitizedBody?: unknown;
}

/**
 * The narrow input-validation / sanitization port (Req 34.4) — injectable so a
 * route can supply a schema-specific validator.
 *
 * The bundled {@link import('./validation.js').DefaultRequestValidator} performs
 * the baseline checks (method, path shape and length, no control characters)
 * and sanitizes string content. A validator that throws causes the gateway to
 * fail closed (deny `fail_closed`).
 */
export interface RequestValidator {
  /**
   * Validate and sanitize a request before processing (Req 34.4).
   *
   * @param request The incoming request descriptor.
   * @returns The validation result, including the sanitized body when valid.
   */
  validate(request: GatewayRequest): ValidationResult;
}

/**
 * The narrow CSRF-verification port (Req 34.6) — injectable so the gateway is
 * decoupled from the token scheme.
 *
 * The bundled {@link import('./csrf.js').DoubleSubmitCsrfVerifier} implements the
 * double-submit-cookie pattern. The gateway only consults it for state-changing
 * methods; a verifier that throws causes the gateway to fail closed (deny
 * `csrf_failed`).
 */
export interface CsrfVerifier {
  /**
   * Verify the CSRF token on a state-changing request (Req 34.6).
   *
   * @param request The incoming request descriptor.
   * @returns `true` when the request carries a valid CSRF token.
   */
  verify(request: GatewayRequest): boolean;
}

/**
 * The outcome of authorizing an authenticated request (Req 34.8).
 *
 * `allowed: false` denies the request as `unauthorized`. The optional
 * {@link reason} is copied into the audit record.
 */
export interface AuthzOutcome {
  /** Whether the authenticated principal is authorized for the request. */
  allowed: boolean;
  /** An optional human-readable reason, copied into the audit record on a denial. */
  reason?: string;
}

/**
 * The narrow authorization port (Req 34.8) — optional and injectable so the
 * gateway can route an authenticated request through Access_Control without
 * importing it.
 *
 * When supplied, an authenticated request is authorized through it and a denial
 * fails the request closed (`unauthorized`); when omitted, fine-grained
 * authorization is deferred to the downstream Access_Control gate and the
 * gateway grants once the request is authenticated and validated. An authorizer
 * that throws causes the gateway to fail closed (deny `fail_closed`).
 */
export interface Authorizer {
  /**
   * Authorize an authenticated request (Req 34.8).
   *
   * @param principal The authenticated actor.
   * @param request The incoming request descriptor.
   * @returns Whether the request is authorized.
   */
  authorize(principal: Principal, request: GatewayRequest): Promise<AuthzOutcome>;
}

/**
 * A monotonic clock seam for rate-limit windowing and audit timestamps
 * (Req 34.3) — injectable so tests advance time deterministically.
 *
 * Named `SecurityGatewayClock` (rather than a bare `Clock`) so it never collides
 * with the Model_Router's, Scheduler's, or Cache_Manager's clocks at the package
 * barrel.
 */
export interface SecurityGatewayClock {
  /** The current time in epoch milliseconds. */
  now(): number;
}

/** The production {@link SecurityGatewayClock}, backed by `Date.now()`. */
export const systemSecurityGatewayClock: SecurityGatewayClock = {
  now: () => Date.now(),
};
