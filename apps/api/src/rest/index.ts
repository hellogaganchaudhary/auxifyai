/**
 * REST_API (Req 45.1, 45.2, 45.3, 45.7).
 *
 * The framework-agnostic, versioned HTTP surface of the platform. It is a pure
 * `handle(request) -> RestResponse | SseResponse` port a transport adapter
 * (Node `http`, Next.js, etc.) drives — no HTTP framework is coupled in.
 *
 * Surface:
 *   - {@link RestApi} — the dispatcher composing the rate-limit gate (Req 45.7),
 *     authentication-before-routing (Req 45.2), the versioned router (Req 45.1),
 *     SSE chat streaming (Req 45.3), and Result→response serialization.
 *   - {@link createRouter} / {@link Router} — the versioned `/v1` route table for
 *     every Req 45.1 resource group.
 *   - {@link RestAuthenticator} — JWT-or-API-key authentication, default-deny.
 *   - The domain types and injectable handler ports ({@link RestServices},
 *     {@link ResourceController}, {@link ChatStreamPort}, {@link RestRequest},
 *     {@link RestResponse}, {@link SseResponse}, …).
 */

export { RestApi, type RestApiOptions } from './rest-api';
export { Router, createRouter } from './router';
export {
  RestAuthenticator,
  type RestAuthenticatorOptions,
  type RestAuthOutcome,
  type JwtAuthenticator,
  type ApiKeyAuthenticator,
} from './authentication';

export {
  API_VERSION,
  API_BASE_PATH,
  HTTP_METHODS,
  RESOURCE_GROUPS,
  type HttpMethod,
  type RestRequest,
  type RestResponse,
  type SseResponse,
  type SseEvent,
  type RouteDefinition,
  type RouteMatch,
  type MatchOutcome,
  type RouteParams,
  type RouteHandler,
  type RouteHandlerContext,
  type HandlerSuccess,
  type AuthenticatedContext,
  type ResourceGroup,
  type ResourceController,
  type RestServices,
  type AgentRunPort,
  type AgentRunRequest,
  type ChatStreamPort,
  type ChatStreamRequest,
  type ChatStreamSource,
  type StreamMode,
} from './types';
