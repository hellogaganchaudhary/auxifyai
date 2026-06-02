/**
 * Security_Gateway (Req 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.8).
 *
 * The request-edge guard every client request passes through before it reaches
 * a backend service. It composes the platform's network and application defenses
 * into a single fail-closed verdict, applying its stages in order: TLS 1.3
 * enforcement (Req 34.1), IP / abuse gating, per-user / per-key / per-IP rate
 * limiting (Req 34.3), input validation and sanitization with XSS-safe output
 * encoding (Req 34.4, 34.5), a CSRF token on state-changing requests (Req 34.6),
 * authentication before routing (Req 34.2), and authorization (Req 34.8). It
 * denies by default — any failing stage, or any guard that errors, refuses the
 * request (`fail_closed`) — and records every denial through the injected
 * AuditRecorder port (Req 37.1). On an allow it hands the backend the
 * authenticated principal and the sanitized request body.
 *
 * Surface:
 *   - {@link SecurityGateway} — the gate; `evaluate(request)` returns a
 *     structured {@link GatewayVerdict}, and `evaluateOrThrow` throws
 *     {@link RequestDeniedError} on a denial.
 *   - {@link SecurityGatewayOptions} / {@link DEFAULT_RATE_LIMIT_CONFIG} — the
 *     injected guards and the default per-dimension rate limits.
 *   - The bundled default guards: {@link InMemoryRateLimiter} /
 *     {@link NoopRateLimiter} (the {@link RateLimiter} port, Req 34.3),
 *     {@link StaticIpReputation} / {@link AllowAllIpReputation} (the
 *     {@link IpReputation} port), {@link DefaultRequestValidator} (the
 *     {@link RequestValidator} port, Req 34.4), and {@link DoubleSubmitCsrfVerifier}
 *     (the {@link CsrfVerifier} port, Req 34.6).
 *   - The pure validation/encoding helpers {@link sanitizeText},
 *     {@link sanitizeDeep}, {@link encodeForOutput},
 *     {@link containsDisallowedConstructs} (Req 34.4, 34.5), the
 *     {@link constantTimeEqual} comparator, and the {@link MAX_PATH_LENGTH} /
 *     {@link REQUIRED_TLS_VERSION} / {@link HTTP_METHODS} /
 *     {@link STATE_CHANGING_METHODS} / {@link RATE_LIMIT_DIMENSIONS} constants.
 *   - {@link RequestDeniedError} — the typed denial raised by `evaluateOrThrow`,
 *     projecting to a category-correct PlatformError (Req 46.8).
 *   - The injectable port interfaces ({@link RateLimiter}, {@link IpReputation},
 *     {@link Authenticator}, {@link RequestValidator}, {@link CsrfVerifier},
 *     {@link Authorizer}, {@link SecurityGatewayClock} with
 *     {@link systemSecurityGatewayClock}) and the domain types
 *     ({@link GatewayRequest}, {@link GatewayVerdict}, {@link GatewayDenialCode},
 *     {@link TransportInfo}, {@link HttpMethod}, {@link RateLimit},
 *     {@link RateLimitConfig}, {@link RateLimitKey}, {@link RateLimitDecision},
 *     {@link RateLimitDimension}, {@link AuthOutcome}, {@link AuthzOutcome},
 *     {@link IpReputationVerdict}, {@link ValidationResult}).
 *
 * The in-memory test fakes (a capturing audit recorder, a fake authenticator/
 * authorizer, a manual clock, builders) live in `./fakes.js` and are
 * intentionally NOT re-exported from this barrel — they would collide with the
 * equally-named audit-recorder fakes of sibling modules at the package barrel.
 * Following the established convention, the tests import them directly from
 * `./fakes.js`.
 *
 * Naming: the clock seam is exported as {@link SecurityGatewayClock} /
 * {@link systemSecurityGatewayClock} (not a bare `Clock`) so it never collides
 * with the Model_Router's, Scheduler's, Cache_Manager's, or Document_Management's
 * clocks at the package barrel.
 */

export {
  SecurityGateway,
  DEFAULT_RATE_LIMIT_CONFIG,
  type SecurityGatewayOptions,
} from './security-gateway.js';

export { InMemoryRateLimiter, NoopRateLimiter } from './rate-limiter.js';

export { StaticIpReputation, AllowAllIpReputation } from './ip-reputation.js';

export {
  DefaultRequestValidator,
  sanitizeText,
  sanitizeDeep,
  encodeForOutput,
  containsDisallowedConstructs,
  MAX_PATH_LENGTH,
  type DefaultRequestValidatorOptions,
} from './validation.js';

export { DoubleSubmitCsrfVerifier, constantTimeEqual } from './csrf.js';

export { RequestDeniedError, REQUEST_DENIED_CODE } from './errors.js';

export {
  REQUIRED_TLS_VERSION,
  HTTP_METHODS,
  STATE_CHANGING_METHODS,
  RATE_LIMIT_DIMENSIONS,
  systemSecurityGatewayClock,
  type HttpMethod,
  type TransportInfo,
  type GatewayRequest,
  type GatewayVerdict,
  type GatewayDenialCode,
  type RateLimit,
  type RateLimitConfig,
  type RateLimitKey,
  type RateLimitDecision,
  type RateLimitDimension,
  type RateLimiter,
  type IpReputation,
  type IpReputationVerdict,
  type Authenticator,
  type AuthOutcome,
  type RequestValidator,
  type ValidationResult,
  type CsrfVerifier,
  type Authorizer,
  type AuthzOutcome,
  type SecurityGatewayClock,
} from './types.js';
