/**
 * Integration tests for the public API and SDK (Req 45.2, 45.3, 45.7).
 *
 * These exercise the REAL Client_SDK ({@link AuxifyClient}) against the REAL
 * REST_API ({@link RestApi}) connected by an in-memory {@link RestApiTransport}
 * bridge (no network, no sockets). The SDK drives the production dispatcher end
 * to end so the auth contract, SSE relay, and rate-limit gate are verified
 * across the actual client/server boundary:
 *
 *   1. AUTH GATING (Req 45.2): a client with NO credential is rejected with a
 *      401 `authentication` error surfaced as {@link AuxifyApiError}, and the
 *      backing handler is NEVER invoked (default-deny). A valid JWT token and a
 *      valid API key each succeed; an invalid token/key is rejected 401.
 *   2. SSE STREAMING (Req 45.3): `streamChat` through the bridge yields token
 *      {@link ChatEvent}s ending in a `completion` carrying model + usage,
 *      relayed by the real {@link StreamingEngine} from the stub chat stream.
 *   3. RATE-LIMIT REJECTION (Req 45.7): with the per-IP limiter set low, a burst
 *      of SDK calls surfaces a 429 `rate_limited` {@link AuxifyApiError} with a
 *      retry-after, and the over-limit request is rejected.
 */

import { InMemoryRateLimiter, StreamingEngine } from '@auxify/core';
import { AuxifyApiError, AuxifyClient } from '@auxify/sdk';
import type { GroupedResults, SearchResult } from '@auxify/sdk';
import { describe, expect, it } from 'vitest';

import { RestAuthenticator } from '../rest/authentication';
import { RestApi, type RestApiOptions } from '../rest/rest-api';
import { createRouter } from '../rest/router';
import {
  makeMaskedKey,
  makeSessionIdentity,
  RecordingHandler,
  StubApiKeyAuthenticator,
  StubChatStreamPort,
  StubJwtAuthenticator,
} from '../rest/rest-api.fixtures';
import type { ResourceController, RestServices, RouteHandlerContext } from '../rest/types';
import { RestApiTransport } from './rest-api-transport';

const BASE_URL = 'https://api.auxify.test';
const VALID_TOKEN = 'valid-jwt-token';
const VALID_API_KEY = 'sk_test_valid';

/** A canned unified-search result the stub `unified-search` controller returns. */
const GROUPED: GroupedResults = {
  groups: [{ source: 'web', results: [{ title: 'Auxify', url: 'https://auxify.test' }] }],
};

/** A canned web-search result list the stub `web-search` controller returns. */
const WEB_RESULTS: SearchResult[] = [{ title: 'Auxify', url: 'https://auxify.test', score: 0.9 }];

/**
 * Build a REST_API over stub ports plus the recording search handler, returning
 * the handler so a test can assert whether it was invoked (default-deny).
 */
function makeRestApi(
  options: Partial<RestApiOptions> = {},
): { restApi: RestApi; search: RecordingHandler } {
  const search = new RecordingHandler({ body: GROUPED });
  // eslint-disable-next-line @typescript-eslint/require-await
  const webSearchHandler = async (ctx: RouteHandlerContext) => {
    void ctx;
    return { ok: true as const, value: { body: WEB_RESULTS } };
  };
  const unifiedSearch: ResourceController = { search: search.handle };
  const webSearch: ResourceController = { search: webSearchHandler };
  const chatStream = new StubChatStreamPort(['Hello', ', ', 'world']);
  const services: RestServices = {
    controllers: { 'unified-search': unifiedSearch, 'web-search': webSearch },
    chatStream,
  };
  const restApi = new RestApi({
    router: createRouter(services),
    authenticator: new RestAuthenticator({
      jwt: new StubJwtAuthenticator(VALID_TOKEN, makeSessionIdentity()),
      apiKey: new StubApiKeyAuthenticator(VALID_API_KEY, makeMaskedKey()),
    }),
    services,
    streaming: new StreamingEngine({ persister: { persist: () => undefined } }),
    ...options,
  });
  return { restApi, search };
}

/** Build an {@link AuxifyClient} wired to a REST_API through the in-memory bridge. */
function makeClient(
  restApi: RestApi,
  credential: { token?: string; apiKey?: string } = {},
  transportIp?: string,
): AuxifyClient {
  return new AuxifyClient({
    baseUrl: BASE_URL,
    ...credential,
    transport: new RestApiTransport(restApi, transportIp !== undefined ? { ip: transportIp } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. Authentication gating end to end (Req 45.2)
// ---------------------------------------------------------------------------

describe('SDK ↔ REST_API — authentication gating (Req 45.2)', () => {
  it('rejects a protected call from a client with NO credential and NEVER invokes the handler', async () => {
    const { restApi, search } = makeRestApi();
    const client = makeClient(restApi);

    const error = await client.unifiedSearch('hello').then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AuxifyApiError);
    expect((error as AuxifyApiError).error.category).toBe('authentication');
    // Default-deny: the backing handler was never reached.
    expect(search.invoked).toBe(false);
  });

  it('authenticates a VALID JWT token and resolves the unified-search result', async () => {
    const { restApi, search } = makeRestApi();
    const client = makeClient(restApi, { token: VALID_TOKEN });

    const result = await client.unifiedSearch('hello');

    expect(result).toEqual(GROUPED);
    expect(search.invoked).toBe(true);
    expect(search.calls[0]?.auth?.principal.userId).toBe('user-1');
  });

  it('authenticates a VALID API key and resolves a web-search result', async () => {
    const { restApi } = makeRestApi();
    const client = makeClient(restApi, { apiKey: VALID_API_KEY });

    const results = await client.webSearch({ query: 'auxify' });

    expect(results).toEqual(WEB_RESULTS);
  });

  it('rejects an INVALID JWT token with a 401 authentication error and never routes', async () => {
    const { restApi, search } = makeRestApi();
    const client = makeClient(restApi, { token: 'wrong-token' });

    const error = await client.unifiedSearch('hello').then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AuxifyApiError);
    expect((error as AuxifyApiError).error.category).toBe('authentication');
    expect(search.invoked).toBe(false);
  });

  it('rejects an INVALID API key with a 401 authentication error', async () => {
    const { restApi } = makeRestApi();
    const client = makeClient(restApi, { apiKey: 'sk_bad' });

    const error = await client.webSearch({ query: 'auxify' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AuxifyApiError);
    expect((error as AuxifyApiError).error.category).toBe('authentication');
  });
});

// ---------------------------------------------------------------------------
// 2. SSE streaming end to end (Req 45.3)
// ---------------------------------------------------------------------------

describe('SDK ↔ REST_API — SSE streaming chat (Req 45.3)', () => {
  it('streams token events ending in a completion carrying model + usage', async () => {
    const { restApi } = makeRestApi();
    const client = makeClient(restApi, { token: VALID_TOKEN });

    const events = [];
    for await (const event of client.streamChat({ modelId: 'gpt-test', prompt: 'hi' })) {
      events.push(event);
    }

    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.map((t) => (t.type === 'token' ? t.delta : ''))).toEqual([
      'Hello',
      ', ',
      'world',
    ]);

    const last = events.at(-1);
    expect(last?.type).toBe('completion');
    if (last?.type === 'completion') {
      expect(last.model).toBe('gpt-test');
      expect(last.usage).toEqual({ inputTokens: 3, outputTokens: 3 });
    }
  });

  it('surfaces a terminal error event when streaming without a credential (default-deny)', async () => {
    const { restApi } = makeRestApi();
    const client = makeClient(restApi);

    const events = [];
    for await (const event of client.streamChat({ modelId: 'gpt-test', prompt: 'hi' })) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    const only = events[0];
    expect(only?.type).toBe('error');
    if (only?.type === 'error') {
      expect(only.error.category).toBe('authentication');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Rate-limit rejection end to end (Req 45.7)
// ---------------------------------------------------------------------------

describe('SDK ↔ REST_API — rate-limit rejection (Req 45.7)', () => {
  it('surfaces a 429 rate_limited error with a retry-after once the per-IP limit is exceeded', async () => {
    const { restApi } = makeRestApi({
      rateLimiter: new InMemoryRateLimiter(),
      rateLimitConfig: { ip: { requestsPerWindow: 2, windowSeconds: 60 } },
      clock: { now: () => 0 },
    });
    const client = makeClient(restApi, { token: VALID_TOKEN }, '198.51.100.10');

    // The first two calls are within the limit.
    await expect(client.unifiedSearch('one')).resolves.toEqual(GROUPED);
    await expect(client.unifiedSearch('two')).resolves.toEqual(GROUPED);

    // The third call is over the per-IP limit and is rejected.
    const error = await client.unifiedSearch('three').then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AuxifyApiError);
    const platformError = (error as AuxifyApiError).error;
    expect(platformError.category).toBe('rate_limited');
    expect(platformError.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(platformError.retryAfterSeconds ?? 0).toBeGreaterThan(0);
  });
});
