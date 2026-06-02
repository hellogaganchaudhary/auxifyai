/**
 * REST_API domain types (Req 45.1, 45.2, 45.3, 45.7).
 *
 * The REST_API is the versioned, framework-agnostic HTTP surface of the
 * platform. It is modelled as a pure request/response port so a thin transport
 * adapter (Node `http`, Next.js route handler, etc.) can normalize an incoming
 * wire request into a {@link RestRequest}, call {@link RestApi.handle}, and
 * serialize the returned {@link RestResponse} (or stream the {@link SseResponse})
 * back out. No HTTP framework is coupled in here.
 *
 * These types describe the inputs and outputs of the dispatcher:
 *   - {@link RestRequest} / {@link RestResponse} — the normalized request and
 *     the buffered JSON response.
 *   - {@link SseResponse} / {@link SseEvent} — the streaming response used for
 *     server-sent-events chat (Req 45.3).
 *   - {@link RouteDefinition} / {@link RouteMatch} / {@link MatchOutcome} — the
 *     router's registered routes and the result of matching a request.
 *   - {@link AuthenticatedContext} — the authenticated identity produced before
 *     any handler runs (Req 45.2).
 *   - {@link RestServices} / {@link ResourceController} / {@link ChatStreamPort}
 *     — the injectable handler ports the router dispatches to, so the router and
 *     dispatcher stay decoupled from any concrete domain implementation.
 */

import type { ProviderChunk, StreamContext } from '@auxify/core';
import type {
  PlatformError,
  Principal,
  Result,
  TenantContext,
} from '@auxify/types';

/** The HTTP methods the REST_API recognizes. */
export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** All {@link HttpMethod} values, for iteration and validation. */
export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;

/** The API version every route is published under (Req 45.1). */
export const API_VERSION = 'v1' as const;

/** The versioned base path prefix for every route (Req 45.1). */
export const API_BASE_PATH = `/${API_VERSION}` as const;

/**
 * A normalized incoming request a transport adapter fills in from the wire.
 *
 * `path` is the decoded path WITHOUT a query string (the parsed query lives in
 * {@link query}); `headers` keys may be supplied in any case (the dispatcher
 * looks them up case-insensitively); `ip` is the originating client IP used for
 * per-IP rate limiting (Req 45.7).
 */
export interface RestRequest {
  /** The HTTP method. */
  method: HttpMethod;
  /** The decoded request path, e.g. `/v1/organizations/abc`. */
  path: string;
  /** The request headers (looked up case-insensitively). */
  headers: Record<string, string>;
  /** The parsed query-string parameters, when any. */
  query?: Record<string, string>;
  /** The parsed request body, when any. */
  body?: unknown;
  /** The originating client IP, used for per-IP rate limiting (Req 45.7). */
  ip?: string;
}

/** A buffered JSON response returned by {@link RestApi.handle}. */
export interface RestResponse {
  /** The HTTP status code. */
  status: number;
  /** The response headers (always carries `x-correlation-id`). */
  headers: Record<string, string>;
  /** The response body — a success value or a {@link PlatformError}. */
  body: unknown;
}

/**
 * A single server-sent event frame (Req 45.3).
 *
 * A transport adapter serializes this to the SSE wire format
 * (`event: <event>\nid: <id>\ndata: <data>\n\n`).
 */
export interface SseEvent {
  /** The SSE `event:` name, when set (e.g. `token`, `completion`). */
  event?: string;
  /** The SSE `data:` payload (typically a JSON string). */
  data: string;
  /** The SSE `id:` field, when set. */
  id?: string;
}

/**
 * A streaming response whose body is delivered as server-sent events (Req 45.3).
 *
 * Returned by {@link RestApi.handle} for the streaming chat route. The
 * {@link stream} is an async iterable a transport adapter drains, writing each
 * {@link SseEvent} to the open connection until the iterable completes.
 */
export interface SseResponse {
  /** The HTTP status code (200 once the stream is established). */
  status: number;
  /** The response headers (`text/event-stream`, plus `x-correlation-id`). */
  headers: Record<string, string>;
  /** The ordered stream of SSE events, ending with a completion event (Req 45.3). */
  stream: AsyncIterable<SseEvent>;
}

/** Extracted `:param` path parameters from a matched route. */
export type RouteParams = Record<string, string>;

/**
 * The authenticated identity established BEFORE any handler runs (Req 45.2).
 *
 * Produced by authentication from a valid JWT/session bearer token or a valid
 * API key. It carries the authoritative {@link Principal} and the derived
 * {@link TenantContext} a handler passes to the repository layer, plus the
 * originating session id (for a JWT) or API-key id (for a key).
 */
export interface AuthenticatedContext {
  /** The authenticated actor. */
  principal: Principal;
  /** The tenant scope derived from the principal. */
  tenant: TenantContext;
  /** The originating session id, when authenticated via a JWT/session token. */
  sessionId?: string;
  /** The presented API-key id, when authenticated via an API key. */
  apiKeyId?: string;
}

/**
 * The successful payload a {@link RouteHandler} returns, serialized into a
 * {@link RestResponse} by the dispatcher.
 */
export interface HandlerSuccess {
  /** The success body to serialize. */
  body: unknown;
  /** The HTTP status code; defaults to `200` (use `201` for a creation). */
  status?: number;
}

/**
 * Everything a {@link RouteHandler} receives: the normalized request, the
 * extracted path params and parsed query, the authenticated context (or `null`
 * for a public route), and the request's correlation id.
 */
export interface RouteHandlerContext {
  /** The normalized incoming request. */
  request: RestRequest;
  /** The extracted `:param` path parameters. */
  params: RouteParams;
  /** The parsed query-string parameters. */
  query: Record<string, string>;
  /** The authenticated context, or `null` on a public route (Req 45.2). */
  auth: AuthenticatedContext | null;
  /** The correlation id propagated across the request (Req 46.7). */
  correlationId: string;
}

/**
 * A resource handler: takes a {@link RouteHandlerContext} and returns a typed
 * {@link Result}. The dispatcher serializes a success to a 2xx response and an
 * {@link PlatformError} to its category's HTTP status.
 */
export type RouteHandler = (ctx: RouteHandlerContext) => Promise<Result<HandlerSuccess>>;

/** Whether (and when) a route is served as a server-sent-events stream (Req 45.3). */
export type StreamMode =
  /** Always streamed (e.g. a dedicated stream endpoint). */
  | 'always'
  /** Streamed only when the request carries `?stream=true`. */
  | 'on-query';

/** The Req 45.1 resource groups the REST_API exposes versioned routes for. */
export type ResourceGroup =
  | 'auth'
  | 'organizations'
  | 'teams'
  | 'projects'
  | 'conversations'
  | 'messages'
  | 'models'
  | 'web-search'
  | 'web-scrape'
  | 'agents'
  | 'knowledge-base'
  | 'knowledge-hub'
  | 'messaging'
  | 'documents'
  | 'unified-search'
  | 'prompts'
  | 'analytics'
  | 'administration';

/** All {@link ResourceGroup} values required by Req 45.1, for iteration and assertions. */
export const RESOURCE_GROUPS: readonly ResourceGroup[] = [
  'auth',
  'organizations',
  'teams',
  'projects',
  'conversations',
  'messages',
  'models',
  'web-search',
  'web-scrape',
  'agents',
  'knowledge-base',
  'knowledge-hub',
  'messaging',
  'documents',
  'unified-search',
  'prompts',
  'analytics',
  'administration',
] as const;

/**
 * A versioned route the router matches and dispatches (Req 45.1).
 *
 * `pattern` is a `/v1/...` path that may contain `:param` segments. `group` and
 * `op` identify which injected handler the route delegates to; `public` marks a
 * route exempt from authentication (the sign-in allowlist, Req 45.2); `stream`
 * marks a server-sent-events route (Req 45.3).
 */
export interface RouteDefinition {
  /** The HTTP method this route matches. */
  method: HttpMethod;
  /** The versioned `/v1/...` path pattern (supports `:param` segments). */
  pattern: string;
  /** The Req 45.1 resource group this route belongs to. */
  group: ResourceGroup;
  /** The logical operation id within the group's {@link ResourceController}. */
  op: string;
  /** The handler invoked on a match. */
  handler: RouteHandler;
  /** When `true`, the route is exempt from authentication (Req 45.2 allowlist). */
  public?: boolean;
  /** When set, the route is served as server-sent events (Req 45.3). */
  stream?: StreamMode;
}

/** A successful route match carrying the route and its extracted path params. */
export interface RouteMatch {
  /** The matched route. */
  route: RouteDefinition;
  /** The extracted `:param` values. */
  params: RouteParams;
}

/**
 * The outcome of matching a method + path against the router's routes:
 *   - `matched` — a route matched both path and method;
 *   - `method_not_allowed` — a route matched the path but not the method (405);
 *   - `not_found` — no route matched the path (404).
 */
export type MatchOutcome =
  | { type: 'matched'; match: RouteMatch }
  | { type: 'method_not_allowed'; allowed: HttpMethod[] }
  | { type: 'not_found' };

/**
 * A resource controller: a map of operation id to {@link RouteHandler}.
 *
 * Modelled as an injectable port so the router delegates the Req 45.1 routes to
 * concrete domain logic without importing it — tests substitute small stubs. A
 * controller need not implement every operation; an unimplemented op resolves
 * to a `not_found` error at request time.
 */
export type ResourceController = Readonly<Record<string, RouteHandler>>;

/** The conversation/message coordinates an SSE chat stream is opened for (Req 45.3). */
export interface ChatStreamRequest {
  /** The conversation the streamed exchange belongs to. */
  conversationId: string;
  /** The authenticated context that opened the stream. */
  auth: AuthenticatedContext;
  /** The originating request. */
  request: RestRequest;
  /** The request's correlation id. */
  correlationId: string;
}

/**
 * The provider chunk source and stream context the Streaming_Engine relays for
 * an SSE chat stream (Req 45.3). The port author supplies the cost source and
 * persistence target on the {@link StreamContext}.
 */
export interface ChatStreamSource {
  /** The provider's incremental chunk stream (the Chat_Service collected chunks). */
  source: AsyncIterable<ProviderChunk>;
  /** The per-request streaming context (cost, persistence target, model). */
  context: StreamContext;
}

/**
 * The injectable port the streaming chat route delegates to (Req 45.3).
 *
 * Production wires this to the Chat_Service (which produces the routed chunks);
 * tests substitute a fake yielding canned chunks. The dispatcher relays the
 * returned source through the Streaming_Engine into SSE events.
 */
export interface ChatStreamPort {
  /** Open a chat stream for a conversation, returning the chunk source + context. */
  open(req: ChatStreamRequest): Promise<ChatStreamSource>;
}

/**
 * The bundle of injectable handler ports the router dispatches to (Req 45.1,
 * 45.3). All members are optional so a deployment (or a test) wires only the
 * resources it needs; an unwired route still exists but returns a `not_found`
 * error until a handler is provided.
 */
export interface RestServices {
  /** Per-resource-group controllers the Req 45.1 routes delegate to. */
  controllers?: Partial<Record<ResourceGroup, ResourceController>>;
  /** The streaming chat port the SSE route delegates to (Req 45.3). */
  chatStream?: ChatStreamPort;
}
