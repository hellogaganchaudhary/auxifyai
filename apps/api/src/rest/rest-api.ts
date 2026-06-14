/**
 * The REST_API dispatcher (Req 45.1, 45.2, 45.3, 45.7).
 *
 * {@link RestApi} is the framework-agnostic core of the platform's versioned
 * HTTP surface. A transport adapter normalizes a wire request into a
 * {@link RestRequest} and calls {@link RestApi.handle}; the dispatcher applies
 * the platform's request-edge contract in a fixed order and returns either a
 * buffered {@link RestResponse} or a streaming {@link SseResponse}:
 *
 *   1. **Rate-limit gate FIRST (Req 45.7).** Every request is metered through
 *      the injected rate limiter (per IP, plus per user/key when an authorized
 *      identity is already known) BEFORE any other work; an over-limit request
 *      is rejected with a `429 rate_limited` PlatformError carrying a
 *      `retryAfterSeconds` hint, and no handler runs.
 *   2. **Authentication before routing (Req 45.2, default-deny).** Every request
 *      to a non-public route must present a valid JWT bearer token OR a valid
 *      API key; a missing/invalid credential returns a `401 authentication`
 *      PlatformError and the request is NOT routed. The small public allowlist
 *      (sign-in, refresh) is the documented exception.
 *   3. **Routing + dispatch (Req 45.1).** The {@link Router} matches the
 *      versioned `(method, path)` to a handler; an unknown path is `404
 *      not_found` and a known path with the wrong method is `405`.
 *   4. **Streaming chat over SSE (Req 45.3).** A streaming route returns an
 *      {@link SseResponse} whose `stream` yields `data:` events relayed from the
 *      Chat_Service/Streaming_Engine token stream, ending with a completion
 *      event.
 *   5. **Result serialization.** A handler's {@link Result} success becomes a
 *      `200`/`201` body; an `Err` maps to `httpStatusForError` with the
 *      PlatformError body. An internal exception is caught and returned as a
 *      safe `internal` PlatformError that never leaks internals (Req 34.7).
 *
 * Every response carries `X-Correlation-Id` (reused from the request header when
 * present), and every PlatformError already carries the same `correlationId`
 * (Req 46.7).
 */

import {
  StreamingEngine,
  type EventSink,
  type GatewayRateLimit,
  type GatewayRateLimiter,
  type RateLimitConfig,
  type RateLimitKey,
  type SecurityGatewayClock,
  type StreamEvent,
} from '@auxify/core';
import {
  createPlatformError,
  httpStatusForError,
  type PlatformError,
  type Result,
} from '@auxify/types';

import { RestAuthenticator } from './authentication';
import { Router } from './router';
import {
  type AuthenticatedContext,
  type HandlerSuccess,
  type RestRequest,
  type RestResponse,
  type RestServices,
  type RouteDefinition,
  type RouteHandlerContext,
  type SseEvent,
  type SseResponse,
} from './types';

/** The header carrying (and propagating) the request correlation id (Req 46.7). */
const CORRELATION_ID_HEADER = 'x-correlation-id';

/** The default per-IP rate limit applied when no config is supplied (Req 45.7). */
const DEFAULT_IP_RATE_LIMIT: GatewayRateLimit = { requestsPerWindow: 120, windowSeconds: 60 };

/** Construction dependencies for the {@link RestApi} (all injectable). */
export interface RestApiOptions {
  /** The versioned route table (Req 45.1). */
  router: Router;
  /** Authenticates every non-public request before routing (Req 45.2). */
  authenticator: RestAuthenticator;
  /** The injectable handler ports the routes dispatch to (Req 45.1, 45.3). */
  services?: RestServices;
  /** The Streaming_Engine that relays chat tokens to SSE (Req 45.3). */
  streaming?: StreamingEngine;
  /**
   * The per-dimension rate limiter the gate runs first (Req 45.7). When omitted,
   * rate limiting is disabled (no gate). `InMemoryRateLimiter` from the core
   * Security_Gateway satisfies this port.
   */
  rateLimiter?: GatewayRateLimiter;
  /** The per-dimension rate-limit configuration (Req 45.7); IP limit is always used. */
  rateLimitConfig?: Partial<RateLimitConfig>;
  /** The clock for rate-limit windowing; defaults to `Date.now()`. */
  clock?: SecurityGatewayClock;
  /** A correlation-id factory for requests without one; defaults to a random id. */
  correlationIdFactory?: () => string;
}

/**
 * The REST_API dispatcher. Construct once with its injected ports, then call
 * {@link handle} on every normalized request.
 */
export class RestApi {
  private readonly router: Router;
  private readonly authenticator: RestAuthenticator;
  private readonly services: RestServices;
  private readonly streaming: StreamingEngine | undefined;
  private readonly rateLimiter: GatewayRateLimiter | undefined;
  private readonly ipRateLimit: GatewayRateLimit;
  private readonly clock: SecurityGatewayClock;
  private readonly correlationIdFactory: () => string;

  constructor(options: RestApiOptions) {
    this.router = options.router;
    this.authenticator = options.authenticator;
    this.services = options.services ?? {};
    this.streaming = options.streaming;
    this.rateLimiter = options.rateLimiter;
    this.ipRateLimit = options.rateLimitConfig?.ip ?? DEFAULT_IP_RATE_LIMIT;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.correlationIdFactory =
      options.correlationIdFactory ?? (() => `req_${Math.random().toString(36).slice(2)}`);
  }

  /** The router, exposed for introspection (e.g. asserting the Req 45.1 route table). */
  get routes(): readonly RouteDefinition[] {
    return this.router.routes;
  }

  /**
   * Handle one normalized request end to end (Req 45.1, 45.2, 45.3, 45.7).
   *
   * Applies the rate-limit gate, authentication-before-routing, routing, SSE
   * streaming, and result serialization described on the class, always returning
   * a response carrying `X-Correlation-Id`. It never throws: an unexpected
   * internal exception is caught and returned as a safe `internal` error.
   *
   * @param request The normalized incoming request.
   * @returns A buffered {@link RestResponse} or a streaming {@link SseResponse}.
   */
  async handle(request: RestRequest): Promise<RestResponse | SseResponse> {
    const correlationId = this.correlationId(request);
    try {
      return await this.dispatch(request, correlationId);
    } catch {
      // Req 34.7: never leak an internal exception's details to the client.
      return this.errorResponse(
        createPlatformError({
          category: 'internal',
          code: 'INTERNAL_ERROR',
          message: 'an unexpected error occurred while processing the request',
          correlationId,
        }),
      );
    }
  }

  /** The ordered pipeline, factored out so {@link handle} can wrap it in a safe catch. */
  private async dispatch(
    request: RestRequest,
    correlationId: string,
  ): Promise<RestResponse | SseResponse> {
    // Stage 1 — rate-limit gate FIRST (Req 45.7).
    const rateError = await this.checkRateLimit(request, correlationId);
    if (rateError !== null) {
      return this.errorResponse(rateError);
    }

    // Resolve the route up front so a public route can skip authentication, and
    // an unknown path / wrong method is reported precisely.
    const outcome = this.router.match(request.method, request.path);
    if (outcome.type === 'not_found') {
      return this.errorResponse(
        createPlatformError({
          category: 'not_found',
          code: 'ROUTE_NOT_FOUND',
          message: `no route matches ${request.method} ${request.path}`,
          correlationId,
        }),
      );
    }
    if (outcome.type === 'method_not_allowed') {
      return this.errorResponse(
        createPlatformError({
          category: 'validation',
          code: 'METHOD_NOT_ALLOWED',
          message: `method ${request.method} is not allowed for ${request.path}`,
          correlationId,
          details: { allow: outcome.allowed },
        }),
        // A known path with the wrong method is a 405.
        405,
        { allow: outcome.allowed.join(', ') },
      );
    }

    const { route, params } = outcome.match;

    // Stage 2 — authentication before routing (Req 45.2), unless the route is
    // on the public allowlist (sign-in, refresh). Default-deny: a non-public
    // route with no valid credential is rejected and NO handler runs.
    let auth: AuthenticatedContext | null = null;
    if (route.public !== true) {
      const authOutcome = await this.authenticator.authenticate(request, correlationId);
      if (!authOutcome.authenticated) {
        return this.errorResponse(authOutcome.error);
      }
      auth = authOutcome.context;
    }

    const handlerContext: RouteHandlerContext = {
      request,
      params,
      query: request.query ?? {},
      auth,
      correlationId,
    };

    // Stage 3 — streaming chat over SSE when the route is (or is requested as)
    // a stream (Req 45.3).
    if (this.isStreamingRequest(route, request) && auth !== null) {
      if (route.group === 'agents' && route.op === 'run') {
        return this.streamAgent(params.agentId ?? '', request, auth, correlationId);
      }
      return this.streamChat(request, auth, correlationId);
    }

    // Stage 4 — dispatch to the matched handler and serialize its Result.
    const result = await route.handler(handlerContext);
    return this.serialize(result, correlationId);
  }

  /**
   * Run the rate-limit gate (Req 45.7). Meters the request per IP (always) — the
   * pre-auth dimension available before authentication — returning a
   * `429 rate_limited` PlatformError with a retry-after hint when over limit, or
   * `null` when within limits (or when no limiter is wired).
   */
  private async checkRateLimit(
    request: RestRequest,
    correlationId: string,
  ): Promise<PlatformError | null> {
    if (this.rateLimiter === undefined) {
      return null;
    }
    const ip = request.ip ?? 'unknown';
    const keys: RateLimitKey[] = [{ dimension: 'ip', id: ip, limit: this.ipRateLimit }];
    const decision = await this.rateLimiter.consume(keys, this.clock.now());
    if (decision.allowed) {
      return null;
    }
    return createPlatformError({
      category: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      message: `rate limit exceeded for ${decision.exceededDimension ?? 'request'}`,
      correlationId,
      ...(decision.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: decision.retryAfterSeconds }
        : {}),
    });
  }

  /** Whether this request should be served as a server-sent-events stream (Req 45.3). */
  private isStreamingRequest(route: RouteDefinition, request: RestRequest): boolean {
    if (route.stream === 'always') {
      return true;
    }
    if (route.stream === 'on-query') {
      return request.query?.stream === 'true';
    }
    return false;
  }

  /**
   * Open and relay an SSE chat stream (Req 45.3).
   *
   * Delegates to the injected {@link ChatStreamPort} for the provider chunk
   * source and stream context, then relays it through the {@link StreamingEngine}
   * into an {@link SseResponse} whose `stream` yields one `data:` event per token
   * and ends with a completion event. When streaming is not configured, returns
   * a buffered error response instead of a stream.
   */
  private streamChat(
    request: RestRequest,
    auth: AuthenticatedContext,
    correlationId: string,
  ): RestResponse | SseResponse {
    const chatStream = this.services.chatStream;
    if (chatStream === undefined || this.streaming === undefined) {
      return this.errorResponse(
        createPlatformError({
          category: 'not_found',
          code: 'STREAMING_NOT_CONFIGURED',
          message: 'streaming chat is not configured on this deployment',
          correlationId,
        }),
      );
    }

    const conversationId = request.query?.conversationId ?? '';
    const engine = this.streaming;
    const self = this;
    const stream = (async function* (): AsyncGenerator<SseEvent> {
      let opened;
      try {
        opened = await chatStream.open({
          conversationId,
          auth,
          request,
          correlationId,
        });
      } catch {
        yield self.sseError(
          createPlatformError({
            category: 'internal',
            code: 'STREAM_OPEN_FAILED',
            message: 'the chat stream could not be opened',
            correlationId,
          }),
        );
        return;
      }
      yield* relayEngineToSse(engine, opened.source, opened.context, correlationId);
    })();

    return {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        [CORRELATION_ID_HEADER]: correlationId,
      },
      stream,
    };
  }

  /** Open and relay an SSE agent run (Req 45.6). */
  private streamAgent(
    agentId: string,
    request: RestRequest,
    auth: AuthenticatedContext,
    correlationId: string,
  ): RestResponse | SseResponse {
    const agentRuns = this.services.agentRuns;
    if (agentRuns === undefined) {
      return this.errorResponse(
        createPlatformError({
          category: 'not_found',
          code: 'AGENTS_NOT_CONFIGURED',
          message: 'agent runs are not configured on this deployment',
          correlationId,
        }),
      );
    }

    const self = this;
    const stream = (async function* (): AsyncGenerator<SseEvent> {
      try {
        const events = await agentRuns.open({ agentId, auth, request, correlationId });
        yield* events;
      } catch {
        yield self.sseError(
          createPlatformError({
            category: 'internal',
            code: 'AGENT_RUN_FAILED',
            message: 'the agent run ended unexpectedly',
            correlationId,
          }),
        );
      }
    })();

    return {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        [CORRELATION_ID_HEADER]: correlationId,
      },
      stream,
    };
  }

  /** Serialize a handler {@link Result} into a buffered {@link RestResponse}. */
  private serialize(result: Result<HandlerSuccess>, correlationId: string): RestResponse {
    if (result.ok) {
      const status = result.value.status ?? 200;
      return {
        status,
        headers: { 'content-type': 'application/json', [CORRELATION_ID_HEADER]: correlationId },
        body: result.value.body,
      };
    }
    // Keep the handler's correlation id when set; otherwise stamp the request's.
    const error: PlatformError =
      result.error.correlationId === ''
        ? { ...result.error, correlationId }
        : result.error;
    return this.errorResponse(error);
  }

  /** Build an error {@link RestResponse} from a PlatformError, mapping its category to a status. */
  private errorResponse(
    error: PlatformError,
    statusOverride?: number,
    extraHeaders: Record<string, string> = {},
  ): RestResponse {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [CORRELATION_ID_HEADER]: error.correlationId,
      ...extraHeaders,
    };
    if (error.retryAfterSeconds !== undefined) {
      headers['retry-after'] = String(error.retryAfterSeconds);
    }
    return {
      status: statusOverride ?? httpStatusForError(error),
      headers,
      body: error,
    };
  }

  /** Project a PlatformError into a terminal SSE error event. */
  private sseError(error: PlatformError): SseEvent {
    return { event: 'error', data: JSON.stringify(error) };
  }

  /** Resolve (or mint) the request's correlation id, propagated onto the response (Req 46.7). */
  private correlationId(request: RestRequest): string {
    for (const [key, value] of Object.entries(request.headers)) {
      if (key.toLowerCase() === CORRELATION_ID_HEADER && value.trim().length > 0) {
        return value.trim();
      }
    }
    return this.correlationIdFactory();
  }
}

/**
 * Relay a Streaming_Engine token stream into SSE events (Req 45.3).
 *
 * Bridges the engine's push-based {@link EventSink} to a pull-based async
 * iterable: each {@link StreamEvent} the engine emits is converted to an
 * {@link SseEvent} and yielded in order, ending with the engine's completion
 * event. A source/engine failure terminates the stream with an `error` event so
 * the consumer always sees a clean end.
 */
async function* relayEngineToSse(
  engine: StreamingEngine,
  source: Parameters<StreamingEngine['stream']>[0],
  context: Parameters<StreamingEngine['stream']>[2],
  correlationId: string,
): AsyncGenerator<SseEvent> {
  const queue: SseEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;

  const sink: EventSink = {
    emit(event: StreamEvent): void {
      queue.push(toSseEvent(event));
      wake?.();
    },
  };

  const runner = engine.stream(source, sink, context).then(
    () => {
      finished = true;
      wake?.();
    },
    (error: unknown) => {
      failure = error;
      finished = true;
      wake?.();
    },
  );

  for (;;) {
    if (queue.length > 0) {
      yield queue.shift() as SseEvent;
      continue;
    }
    if (finished) {
      break;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = null;
  }

  await runner;
  if (failure !== null) {
    yield {
      event: 'error',
      data: JSON.stringify(
        createPlatformError({
          category: 'internal',
          code: 'STREAM_FAILED',
          message: 'the chat stream ended unexpectedly',
          correlationId,
        }),
      ),
    };
  }
}

/** Convert a Streaming_Engine {@link StreamEvent} into an SSE frame (Req 45.3). */
function toSseEvent(event: StreamEvent): SseEvent {
  if (event.type === 'token') {
    return { event: 'token', data: JSON.stringify({ delta: event.delta, index: event.index }) };
  }
  return {
    event: 'completion',
    data: JSON.stringify({
      model: event.model,
      usage: event.usage,
      cost: event.cost,
      ...(event.finishReason !== undefined ? { finishReason: event.finishReason } : {}),
    }),
  };
}
