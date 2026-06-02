/**
 * Test fixtures for the REST_API unit tests (Req 45.1, 45.2, 45.3, 45.7).
 *
 * Small in-memory fakes/stubs for the injected ports so the dispatcher, router,
 * and authenticator are exercised with no real Auth_Service, API_Key_Manager,
 * Chat_Service, or network. These deliberately model only what the tests need.
 */

import type { KeyAuthResult, MaskedKey, ProviderChunk, SessionIdentity, StreamContext } from '@auxify/core';
import type { Result } from '@auxify/types';

import type { ApiKeyAuthenticator, JwtAuthenticator } from './authentication';
import type {
  ChatStreamPort,
  ChatStreamRequest,
  ChatStreamSource,
  HandlerSuccess,
  RestRequest,
  RouteHandlerContext,
} from './types';

/** A JWT authenticator that accepts exactly one token and resolves a fixed identity. */
export class StubJwtAuthenticator implements JwtAuthenticator {
  public calls = 0;

  constructor(
    private readonly validToken: string,
    private readonly identity: SessionIdentity,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port
  async validate(accessToken: string): Promise<SessionIdentity> {
    this.calls += 1;
    if (accessToken !== this.validToken) {
      throw new Error('invalid session');
    }
    return this.identity;
  }
}

/** An API-key authenticator that accepts exactly one raw key and resolves a fixed masked key. */
export class StubApiKeyAuthenticator implements ApiKeyAuthenticator {
  public calls = 0;

  constructor(
    private readonly validKey: string,
    private readonly key: MaskedKey,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port
  async authenticate(presented: string): Promise<KeyAuthResult> {
    this.calls += 1;
    if (presented !== this.validKey) {
      return { authenticated: false, reason: 'unknown' };
    }
    return { authenticated: true, key: this.key };
  }
}

/** Build a {@link MaskedKey} with sensible defaults for the API-key auth path. */
export function makeMaskedKey(overrides: Partial<MaskedKey> = {}): MaskedKey {
  return {
    id: 'key-1',
    organizationId: 'org-1',
    ownerId: 'user-1',
    name: 'test key',
    prefix: 'sk_test',
    masked: 'sk_test…',
    active: true,
    rateLimit: { requestsPerWindow: 1000, windowSeconds: 60 },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a {@link SessionIdentity} with sensible defaults for the JWT auth path. */
export function makeSessionIdentity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    roles: ['standard_user'],
    sessionId: 'sess-1',
    ...overrides,
  };
}

/** A handler that records every invocation and returns a canned success value. */
export class RecordingHandler {
  public calls: RouteHandlerContext[] = [];

  constructor(private readonly value: HandlerSuccess = { body: { ok: true } }) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port
  handle = async (ctx: RouteHandlerContext): Promise<Result<HandlerSuccess>> => {
    this.calls.push(ctx);
    return { ok: true, value: this.value };
  };

  get invoked(): boolean {
    return this.calls.length > 0;
  }
}

/** Build a normalized {@link RestRequest} with sensible defaults. */
export function makeRequest(overrides: Partial<RestRequest> = {}): RestRequest {
  return {
    method: 'GET',
    path: '/v1/organizations',
    headers: {},
    ip: '203.0.113.5',
    ...overrides,
  };
}

/** Add a bearer-token `Authorization` header to a request. */
export function withBearer(request: RestRequest, token: string): RestRequest {
  return { ...request, headers: { ...request.headers, authorization: `Bearer ${token}` } };
}

/** Add an `X-API-Key` header to a request. */
export function withApiKey(request: RestRequest, key: string): RestRequest {
  return { ...request, headers: { ...request.headers, 'x-api-key': key } };
}

/**
 * A {@link ChatStreamPort} that yields a fixed sequence of provider chunks,
 * ending with a terminal chunk carrying the usage/model so the Streaming_Engine
 * emits a completion event (Req 45.3).
 */
export class StubChatStreamPort implements ChatStreamPort {
  public opened: ChatStreamRequest[] = [];

  constructor(private readonly deltas: string[] = ['Hello', ', ', 'world']) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port
  async open(req: ChatStreamRequest): Promise<ChatStreamSource> {
    this.opened.push(req);
    const deltas = this.deltas;
    const source: AsyncIterable<ProviderChunk> = (async function* () {
      for (const delta of deltas) {
        yield { delta };
      }
      yield {
        delta: '',
        done: true,
        model: 'gpt-test',
        usage: { inputTokens: 3, outputTokens: deltas.length },
        finishReason: 'stop',
      };
    })();
    const context: StreamContext = {
      target: { conversationId: req.conversationId, messageId: 'msg-1' },
      cost: 0.0005,
      modelId: 'gpt-test',
    };
    return { source, context };
  }
}

/** Drain an SSE stream into an array of its events, for assertions. */
export async function collectSse<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
