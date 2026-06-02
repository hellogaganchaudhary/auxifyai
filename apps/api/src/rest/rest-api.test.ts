/**
 * Unit tests for the REST_API dispatcher (Req 45.1, 45.2, 45.3, 45.7).
 *
 * These exercise the full request pipeline through {@link RestApi.handle}:
 *   - an unauthenticated request to a protected route returns 401 and NEVER
 *     invokes the handler (Req 45.2, default-deny);
 *   - a valid JWT and a valid API key each authenticate and route to the handler
 *     (Req 45.2);
 *   - a public route (sign-in) routes without a credential (Req 45.2 exception);
 *   - an over-limit burst returns 429 `rate_limited` with a retry-after hint
 *     (Req 45.7);
 *   - the streaming chat route yields SSE events ending in a completion event
 *     (Req 45.3);
 *   - an unknown route returns 404 and a wrong method returns 405;
 *   - a handler `Err` maps to the correct HTTP status via `httpStatusForError`;
 *   - an internal exception is caught and returned as a safe `internal` error;
 *   - every response carries `X-Correlation-Id` (Req 46.7).
 */

import { InMemoryRateLimiter, StreamingEngine } from '@auxify/core';
import { ERROR_CATEGORY_HTTP_STATUS } from '@auxify/types';
import { describe, expect, it } from 'vitest';

import { RestAuthenticator } from './authentication';
import { RestApi, type RestApiOptions } from './rest-api';
import { createRouter } from './router';
import type { ResourceController, RestResponse, RestServices, SseResponse } from './types';
import {
  collectSse,
  makeMaskedKey,
  makeRequest,
  makeSessionIdentity,
  RecordingHandler,
  StubApiKeyAuthenticator,
  StubChatStreamPort,
  StubJwtAuthenticator,
  withApiKey,
  withBearer,
} from './rest-api.fixtures';

const VALID_TOKEN = 'valid-jwt-token';
const VALID_API_KEY = 'sk_test_valid';

/** Whether a response is the buffered (non-streaming) variant. */
function isBuffered(response: RestResponse | SseResponse): response is RestResponse {
  return !('stream' in response);
}

/** Build a {@link RestApi} over stub ports, returning the recording handler for assertions. */
function makeApi(
  overrides: {
    handler?: RecordingHandler;
    services?: RestServices;
    options?: Partial<RestApiOptions>;
    chatStream?: StubChatStreamPort;
  } = {},
): { api: RestApi; handler: RecordingHandler } {
  const handler = overrides.handler ?? new RecordingHandler();
  const organizations: ResourceController = { list: handler.handle, get: handler.handle };
  const auth: ResourceController = {
    // eslint-disable-next-line @typescript-eslint/require-await
    signIn: async () => ({ ok: true, value: { body: { token: 'issued' }, status: 201 } }),
  };
  const services: RestServices = overrides.services ?? {
    controllers: { organizations, auth },
    ...(overrides.chatStream !== undefined ? { chatStream: overrides.chatStream } : {}),
  };
  const api = new RestApi({
    router: createRouter(services),
    authenticator: new RestAuthenticator({
      jwt: new StubJwtAuthenticator(VALID_TOKEN, makeSessionIdentity()),
      apiKey: new StubApiKeyAuthenticator(VALID_API_KEY, makeMaskedKey()),
    }),
    services,
    ...overrides.options,
  });
  return { api, handler };
}

// ---------------------------------------------------------------------------
// Authentication before routing (Req 45.2)
// ---------------------------------------------------------------------------

describe('RestApi — authentication before routing (Req 45.2)', () => {
  it('returns 401 and NEVER invokes the handler for an unauthenticated protected route', async () => {
    const { api, handler } = makeApi();
    const response = await api.handle(makeRequest({ path: '/v1/organizations' }));
    expect(isBuffered(response)).toBe(true);
    if (isBuffered(response)) {
      expect(response.status).toBe(401);
      expect((response.body as { category: string }).category).toBe('authentication');
    }
    expect(handler.invoked).toBe(false);
  });

  it('authenticates a valid JWT bearer token and routes to the handler (Req 45.2)', async () => {
    const { api, handler } = makeApi();
    const response = await api.handle(
      withBearer(makeRequest({ path: '/v1/organizations' }), VALID_TOKEN),
    );
    expect(isBuffered(response)).toBe(true);
    if (isBuffered(response)) {
      expect(response.status).toBe(200);
    }
    expect(handler.invoked).toBe(true);
    expect(handler.calls[0]?.auth?.principal.userId).toBe('user-1');
    expect(handler.calls[0]?.auth?.sessionId).toBe('sess-1');
  });

  it('authenticates a valid API key and routes to the handler (Req 45.2)', async () => {
    const { api, handler } = makeApi();
    const response = await api.handle(
      withApiKey(makeRequest({ path: '/v1/organizations' }), VALID_API_KEY),
    );
    expect(isBuffered(response)).toBe(true);
    if (isBuffered(response)) {
      expect(response.status).toBe(200);
    }
    expect(handler.invoked).toBe(true);
    expect(handler.calls[0]?.auth?.apiKeyId).toBe('key-1');
    expect(handler.calls[0]?.auth?.principal.organizationId).toBe('org-1');
  });

  it('rejects an invalid JWT with 401 and does not route', async () => {
    const { api, handler } = makeApi();
    const response = await api.handle(
      withBearer(makeRequest({ path: '/v1/organizations' }), 'wrong-token'),
    );
    if (isBuffered(response)) {
      expect(response.status).toBe(401);
    }
    expect(handler.invoked).toBe(false);
  });

  it('rejects an invalid API key with 401 and does not route', async () => {
    const { api, handler } = makeApi();
    const response = await api.handle(
      withApiKey(makeRequest({ path: '/v1/organizations' }), 'sk_bad'),
    );
    if (isBuffered(response)) {
      expect(response.status).toBe(401);
    }
    expect(handler.invoked).toBe(false);
  });

  it('routes a public route (sign-in) WITHOUT a credential (Req 45.2 exception)', async () => {
    const { api } = makeApi();
    const response = await api.handle(
      makeRequest({ method: 'POST', path: '/v1/auth/sign-in', body: { email: 'a@b.c' } }),
    );
    expect(isBuffered(response)).toBe(true);
    if (isBuffered(response)) {
      expect(response.status).toBe(201);
      expect((response.body as { token: string }).token).toBe('issued');
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (Req 45.7)
// ---------------------------------------------------------------------------

describe('RestApi — rate limiting (Req 45.7)', () => {
  it('rejects an over-limit burst with 429 rate_limited and a retry-after hint', async () => {
    const { api } = makeApi({
      options: {
        rateLimiter: new InMemoryRateLimiter(),
        rateLimitConfig: { ip: { requestsPerWindow: 2, windowSeconds: 60 } },
        clock: { now: () => 0 },
      },
    });

    const req = withBearer(makeRequest({ path: '/v1/organizations', ip: '203.0.113.9' }), VALID_TOKEN);
    expect((await api.handle(req) as RestResponse).status).toBe(200);
    expect((await api.handle(req) as RestResponse).status).toBe(200);

    const third = (await api.handle(req)) as RestResponse;
    expect(third.status).toBe(429);
    const body = third.body as { category: string; code: string; retryAfterSeconds?: number };
    expect(body.category).toBe('rate_limited');
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('runs the rate-limit gate BEFORE authentication (an over-limit request is 429, not 401)', async () => {
    const { api, handler } = makeApi({
      options: {
        rateLimiter: new InMemoryRateLimiter(),
        rateLimitConfig: { ip: { requestsPerWindow: 1, windowSeconds: 60 } },
        clock: { now: () => 0 },
      },
    });
    const req = makeRequest({ path: '/v1/organizations', ip: '203.0.113.11' });
    // First (unauthenticated) request consumes the single slot -> 401.
    expect((await api.handle(req) as RestResponse).status).toBe(401);
    // Second request is over the IP limit -> 429 (gate precedes auth).
    expect((await api.handle(req) as RestResponse).status).toBe(429);
    expect(handler.invoked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Streaming chat over SSE (Req 45.3)
// ---------------------------------------------------------------------------

describe('RestApi — streaming chat over SSE (Req 45.3)', () => {
  function makeStreamingApi(): RestApi {
    const chatStream = new StubChatStreamPort(['Hello', ', ', 'world']);
    const services: RestServices = { controllers: {}, chatStream };
    return new RestApi({
      router: createRouter(services),
      authenticator: new RestAuthenticator({
        jwt: new StubJwtAuthenticator(VALID_TOKEN, makeSessionIdentity()),
      }),
      services,
      streaming: new StreamingEngine({ persister: { persist: () => undefined } }),
    });
  }

  it('returns an SSE response yielding token events ending in a completion event', async () => {
    const api = makeStreamingApi();
    const response = await api.handle(
      withBearer(makeRequest({ method: 'POST', path: '/v1/chat/stream', body: {} }), VALID_TOKEN),
    );
    expect(isBuffered(response)).toBe(false);
    if (!isBuffered(response)) {
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');
      const events = await collectSse(response.stream);
      const tokenEvents = events.filter((e) => e.event === 'token');
      expect(tokenEvents.length).toBe(3);
      const last = events.at(-1);
      expect(last?.event).toBe('completion');
      const completion = JSON.parse(last?.data ?? '{}') as { model: string; usage: unknown };
      expect(completion.model).toBe('gpt-test');
      expect(completion.usage).toEqual({ inputTokens: 3, outputTokens: 3 });
    }
  });

  it('serves the messages route as SSE only when ?stream=true is set (Req 45.3)', async () => {
    const api = makeStreamingApi();
    const streamed = await api.handle(
      withBearer(
        makeRequest({
          method: 'POST',
          path: '/v1/conversations/conv-1/messages',
          query: { stream: 'true' },
          body: {},
        }),
        VALID_TOKEN,
      ),
    );
    expect(isBuffered(streamed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routing errors (Req 45.1)
// ---------------------------------------------------------------------------

describe('RestApi — routing errors (Req 45.1)', () => {
  it('returns 404 for an unknown route', async () => {
    const { api } = makeApi();
    const response = (await api.handle(
      withBearer(makeRequest({ path: '/v1/does-not-exist' }), VALID_TOKEN),
    )) as RestResponse;
    expect(response.status).toBe(404);
    expect((response.body as { code: string }).code).toBe('ROUTE_NOT_FOUND');
  });

  it('returns 405 for a known path with the wrong method', async () => {
    const { api } = makeApi();
    const response = (await api.handle(
      withBearer(makeRequest({ method: 'DELETE', path: '/v1/models' }), VALID_TOKEN),
    )) as RestResponse;
    expect(response.status).toBe(405);
    expect((response.body as { code: string }).code).toBe('METHOD_NOT_ALLOWED');
    expect(response.headers.allow).toContain('GET');
  });
});

// ---------------------------------------------------------------------------
// Result serialization (Req 45.x, 46.8)
// ---------------------------------------------------------------------------

describe('RestApi — Result serialization', () => {
  it('maps a handler Err to the correct HTTP status via httpStatusForError', async () => {
    const failing: ResourceController = {
      // eslint-disable-next-line @typescript-eslint/require-await
      list: async (ctx) => ({
        ok: false,
        error: {
          category: 'authorization',
          code: 'FORBIDDEN',
          message: 'not allowed',
          correlationId: ctx.correlationId,
          retriable: false,
        },
      }),
    };
    const services: RestServices = { controllers: { organizations: failing } };
    const api = new RestApi({
      router: createRouter(services),
      authenticator: new RestAuthenticator({
        jwt: new StubJwtAuthenticator(VALID_TOKEN, makeSessionIdentity()),
      }),
      services,
    });
    const response = (await api.handle(
      withBearer(makeRequest({ path: '/v1/organizations' }), VALID_TOKEN),
    )) as RestResponse;
    expect(response.status).toBe(ERROR_CATEGORY_HTTP_STATUS.authorization);
    expect(response.status).toBe(403);
  });

  it('catches an internal exception and returns a safe internal error (Req 34.7)', async () => {
    const throwing: ResourceController = {
      list: () => {
        throw new Error('secret stack trace detail');
      },
    };
    const services: RestServices = { controllers: { organizations: throwing } };
    const api = new RestApi({
      router: createRouter(services),
      authenticator: new RestAuthenticator({
        jwt: new StubJwtAuthenticator(VALID_TOKEN, makeSessionIdentity()),
      }),
      services,
    });
    const response = (await api.handle(
      withBearer(makeRequest({ path: '/v1/organizations' }), VALID_TOKEN),
    )) as RestResponse;
    expect(response.status).toBe(500);
    const body = response.body as { category: string; message: string };
    expect(body.category).toBe('internal');
    expect(body.message).not.toContain('secret stack trace detail');
  });

  it('propagates X-Correlation-Id from the request onto the response (Req 46.7)', async () => {
    const { api } = makeApi();
    const response = (await api.handle(
      withBearer(
        makeRequest({ path: '/v1/organizations', headers: { 'x-correlation-id': 'corr-xyz' } }),
        VALID_TOKEN,
      ),
    )) as RestResponse;
    expect(response.headers['x-correlation-id']).toBe('corr-xyz');
  });

  it('mints a correlation id when the request carries none', async () => {
    const { api } = makeApi();
    const response = (await api.handle(makeRequest({ path: '/v1/organizations' }))) as RestResponse;
    expect(response.headers['x-correlation-id']).toBeDefined();
    expect(response.headers['x-correlation-id']?.length).toBeGreaterThan(0);
  });
});
