/**
 * @auxify/core — the backend services used by the running Auxify product.
 *
 * Trimmed to the dependency closure of the live chat platform (provider
 * adapters + streaming + the request-edge auth/security primitives the REST API
 * uses). Modules outside this closure were removed; re-add them only when a new
 * feature needs them.
 */
import { AUXIFY_TYPES_PACKAGE } from '@auxify/types';

/** Package marker used to verify the core service package wiring. */
export const AUXIFY_CORE_PACKAGE = '@auxify/core' as const;

export const SHARED_TYPES_PACKAGE = AUXIFY_TYPES_PACKAGE;

/**
 * Replaceable storage layer (Data Layer, Req 44): VectorStore (pgvector+HNSW),
 * ObjectStore (S3/MinIO), and CacheStore (Redis) behind stable interfaces.
 */
export * from './storage/index.js';

/**
 * Tenant-scoped repository layer (application-layer tenant scoping, Req 1.2):
 * every repository requires a TenantContext and injects an `organization_id`
 * predicate into every query.
 */
export * from './repositories/index.js';

/**
 * Audit_Service (Req 37): the immutable, append-only audit trail and the narrow
 * {@link AuditRecorder} port other services depend on.
 */
export * from './audit/index.js';

/**
 * Provider_Abstraction_Layer (Req 2): the unified {@link AIProvider} interface
 * and the config-driven {@link ConfigModelRegistry}, plus the concrete
 * Bedrock/Azure adapters the running server wires.
 */
export * from './providers/index.js';

/**
 * Streaming_Engine (Req 4): the transport-agnostic relay that delivers a model
 * response token-by-token and emits a completion event with usage/cost.
 */
export * from './streaming/index.js';

/**
 * API_Key_Manager (Req 21): masked key metadata and the {@link KeyAuthResult}
 * the REST API's API-key authentication path uses.
 */
export * from './api-keys/index.js';

/**
 * Auth_Service (Req 33): the {@link SessionIdentity} the REST API's JWT/session
 * authentication path uses.
 */
export * from './auth/index.js';

/**
 * Security_Gateway (Req 34): the request-edge guard — rate limiting,
 * validation, IP reputation, CSRF — the REST dispatcher composes. Exported by
 * name so its `constantTimeEqual` is aliased to `csrfConstantTimeEqual` and
 * does not collide with the API_Key_Manager's `constantTimeEqual`.
 */
export {
  SecurityGateway,
  DEFAULT_RATE_LIMIT_CONFIG,
  InMemoryRateLimiter,
  NoopRateLimiter as NoopGatewayRateLimiter,
  StaticIpReputation,
  AllowAllIpReputation,
  DefaultRequestValidator,
  sanitizeText,
  sanitizeDeep,
  encodeForOutput,
  containsDisallowedConstructs,
  MAX_PATH_LENGTH,
  DoubleSubmitCsrfVerifier,
  constantTimeEqual as csrfConstantTimeEqual,
  RequestDeniedError,
  REQUEST_DENIED_CODE,
  REQUIRED_TLS_VERSION,
  HTTP_METHODS,
  STATE_CHANGING_METHODS,
  RATE_LIMIT_DIMENSIONS,
  systemSecurityGatewayClock,
  type SecurityGatewayOptions,
  type DefaultRequestValidatorOptions,
  type HttpMethod,
  type TransportInfo,
  type GatewayRequest,
  type GatewayVerdict,
  type GatewayDenialCode,
  type RateLimit as GatewayRateLimit,
  type RateLimitConfig,
  type RateLimitKey,
  type RateLimitDecision,
  type RateLimitDimension,
  type RateLimiter as GatewayRateLimiter,
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
} from './security-gateway/index.js';
