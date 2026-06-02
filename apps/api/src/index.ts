/**
 * @auxify/api — backend API application entry point. Hosts the modular
 * services (currently the web search provider abstraction under
 * `modules/search`) and reuses the shared domain types.
 */
import { AUXIFY_CORE_PACKAGE } from '@auxify/core';
import { AUXIFY_TYPES_PACKAGE } from '@auxify/types';

export { ProviderRotationService } from './modules/search/provider-rotation.service';

// WebSocket_Gateway (Req 45.4, 45.5): JWT-authenticated, transport-agnostic
// real-time event delivery. Added additively; see `./websocket`.
export { WebSocketGateway, WsSessionError } from './websocket/index';
export type {
  Authenticator as WsAuthenticator,
  ConnectParams as WsConnectParams,
  WsConnection,
  WsEventType,
  WsServerEvent,
  WsSession,
  WsTarget,
} from './websocket/index';

// Monitoring_Service and per-service health/readiness endpoints (Req 39.8,
// 42.8, 42.9, 46.6, 46.7): JSON log sink, multi-channel alert dispatcher,
// per-service liveness/readiness HTTP responses, and the composition factory.
// Added additively; see `./modules/monitoring`.
export {
  CoreServiceMonitor,
  HEALTH_HTTP_NOT_FOUND,
  HEALTH_HTTP_OK,
  HEALTH_HTTP_UNAVAILABLE,
  JsonLogSink,
  MonitoringEndpoints,
  MultiChannelAlertDispatcher,
  createMonitoringComposition,
  loggingFallbackHandler,
} from './modules/monitoring/index';
export type {
  AlertChannelHandler,
  CreateMonitoringCompositionOptions,
  HealthEndpointResponse,
  HealthLookupResponse,
  JsonLogSinkOptions,
  MonitoringComposition,
  MultiChannelAlertDispatcherOptions,
  ReadinessEndpointResponse,
  ReadinessLookupResponse,
  ServiceMonitor,
  UnknownServiceResponse,
} from './modules/monitoring/index';

// REST_API (Req 45.1, 45.2, 45.3, 45.7): the versioned, framework-agnostic HTTP
// surface — authenticate-before-routing (JWT or API key), per-IP rate limiting,
// and SSE chat streaming. Added additively; see `./rest`.
export { RestApi, Router as RestRouter, createRouter, RestAuthenticator } from './rest/index';
export type {
  RestApiOptions,
  RestAuthenticatorOptions,
  RestAuthOutcome,
  JwtAuthenticator as RestJwtAuthenticator,
  ApiKeyAuthenticator as RestApiKeyAuthenticator,
  RestRequest,
  RestResponse,
  SseResponse,
  SseEvent,
  RouteDefinition as RestRouteDefinition,
  RouteHandler as RestRouteHandler,
  RouteHandlerContext as RestRouteHandlerContext,
  AuthenticatedContext as RestAuthenticatedContext,
  ResourceGroup as RestResourceGroup,
  ResourceController as RestResourceController,
  RestServices,
  ChatStreamPort as RestChatStreamPort,
} from './rest/index';

export const AUXIFY_API_PACKAGE = '@auxify/api' as const;
export const LINKED_PACKAGES = [AUXIFY_CORE_PACKAGE, AUXIFY_TYPES_PACKAGE] as const;
