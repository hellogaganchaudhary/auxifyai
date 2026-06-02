/**
 * Unit tests for the Client_SDK's {@link AuxifyClient} (Req 45.6, 46.8).
 *
 * Every test drives the client through a FAKE {@link HttpTransport} so no network
 * is touched: the fake records each {@link TransportRequest} (for asserting the
 * versioned path and the attached auth/correlation headers) and returns canned
 * buffered responses or canned SSE frames. The suite covers all six
 * {@link ClientSDK} methods, the injected transport, and the bearer/API-key
 * header attachment, plus the typed {@link PlatformError} surfacing contract.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';
import { describe, expect, it } from 'vitest';

import { AuxifyApiError, AuxifyClient } from './client';
import type {
  HttpTransport,
  TransportFrame,
  TransportRequest,
  TransportResponse,
} from './types';

/** A recorded interaction: the request the client built and which method served it. */
interface Recorded {
  /** The request the client handed to the transport. */
  request: TransportRequest;
  /** Whether it went through `request` (buffered) or `stream` (SSE). */
  kind: 'request' | 'stream';
}

/** Build an SSE frame. */
function frame(event: string, data: unknown): TransportFrame {
  return { event, data: JSON.stringify(data) };
}

/**
 * A fake {@link HttpTransport} that records requests and replays canned outputs.
 * `response` serves buffered calls; `frames` serves streaming calls.
 */
class FakeTransport implements HttpTransport {
  readonly calls: Recorded[] = [];
  response: TransportResponse = { status: 200, headers: {}, body: '' };
  frames: TransportFrame[] = [];

  async request(req: TransportRequest): Promise<TransportResponse> {
    this.calls.push({ request: req, kind: 'request' });
    return this.response;
  }

  async *stream(req: TransportRequest): AsyncIterable<TransportFrame> {
    this.calls.push({ request: req, kind: 'stream' });
    for (const f of this.frames) {
      yield f;
    }
  }

  /** The single recorded call (fails the test expectation when there is not exactly one). */
  get only(): Recorded {
    expect(this.calls).toHaveLength(1);
    return this.calls[0] as Recorded;
  }
}

/** An OK buffered response carrying `value` as the JSON body and an optional correlation id. */
function okResponse(value: unknown, correlationId = 'corr-1'): TransportResponse {
  return {
    status: 200,
    headers: { 'x-correlation-id': correlationId },
    body: JSON.stringify(value),
  };
}

const baseUrl = 'https://api.auxify.test';

describe('AuxifyClient.chat (Req 45.6)', () => {
  it('returns the assistant message and sends the bearer auth header', async () => {
    const transport = new FakeTransport();
    const message = {
      role: 'assistant',
      content: [{ type: 'markdown', data: 'hello' }],
      usage: { inputTokens: 3, outputTokens: 5 },
    };
    transport.response = okResponse(message);
    const client = new AuxifyClient({ baseUrl, token: 'jwt-abc', transport });

    const result = await client.chat({ modelId: 'gpt-4o', prompt: 'hi' });

    expect(result).toEqual(message);
    const { request } = transport.only;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${baseUrl}/v1/chat`);
    expect(request.headers.authorization).toBe('Bearer jwt-abc');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['x-correlation-id']).toBeDefined();
    // The single prompt is wrapped into a shared ChatMessage.
    expect(JSON.parse(request.body ?? '{}')).toMatchObject({
      modelId: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('targets the conversation messages route when a conversationId is set', async () => {
    const transport = new FakeTransport();
    transport.response = okResponse({ role: 'assistant', content: [] });
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    await client.chat({ conversationId: 'conv 9', modelId: 'm', prompt: 'q' });

    expect(transport.only.request.url).toBe(`${baseUrl}/v1/conversations/conv%209/messages`);
  });

  it('unwraps an Ok Result envelope', async () => {
    const transport = new FakeTransport();
    const message = { role: 'assistant', content: [] };
    transport.response = okResponse({ ok: true, value: message });
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    await expect(client.chat({ modelId: 'm', prompt: 'q' })).resolves.toEqual(message);
  });

  it('attaches the API key header instead of a bearer token', async () => {
    const transport = new FakeTransport();
    transport.response = okResponse({ role: 'assistant', content: [] });
    const client = new AuxifyClient({ baseUrl, apiKey: 'key-xyz', transport });

    await client.chat({ modelId: 'm', prompt: 'q' });

    const { request } = transport.only;
    expect(request.headers['x-api-key']).toBe('key-xyz');
    expect(request.headers.authorization).toBeUndefined();
  });
});

describe('AuxifyClient.streamChat (Req 45.3, 45.6)', () => {
  it('decodes SSE token frames ending in a completion', async () => {
    const transport = new FakeTransport();
    transport.frames = [
      frame('token', { delta: 'Hel', index: 0 }),
      frame('token', { delta: 'lo', index: 1 }),
      frame('completion', { model: 'gpt-4o', usage: { inputTokens: 2, outputTokens: 4 } }),
    ];
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    const events = [];
    for await (const event of client.streamChat({ modelId: 'gpt-4o', prompt: 'hi' })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'token', delta: 'Hel', index: 0 },
      { type: 'token', delta: 'lo', index: 1 },
      { type: 'completion', model: 'gpt-4o', usage: { inputTokens: 2, outputTokens: 4 } },
    ]);
    const call = transport.only;
    expect(call.kind).toBe('stream');
    expect(call.request.url).toBe(`${baseUrl}/v1/chat/stream`);
    expect(call.request.headers.authorization).toBe('Bearer t');
  });

  it('surfaces a terminal error frame as a ChatEvent error carrying the PlatformError', async () => {
    const platformError = createPlatformError({
      category: 'provider_unavailable',
      code: 'PROVIDER_DOWN',
      message: 'provider is down',
      correlationId: 'corr-err',
    });
    const transport = new FakeTransport();
    transport.frames = [frame('token', { delta: 'x' }), frame('error', platformError)];
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    const events = [];
    for await (const event of client.streamChat({
      conversationId: 'c1',
      modelId: 'm',
      prompt: 'hi',
    })) {
      events.push(event);
    }

    expect(events[1]).toEqual({ type: 'error', error: platformError });
    // A conversation-scoped stream targets the messages route with ?stream=true.
    expect(transport.only.request.url).toBe(`${baseUrl}/v1/conversations/c1/messages?stream=true`);
  });
});

describe('AuxifyClient.runAgent (Req 45.6)', () => {
  it('yields step events then a completion', async () => {
    const transport = new FakeTransport();
    transport.frames = [
      frame('step', { id: 's1', kind: 'thought', content: 'thinking' }),
      frame('step', { id: 's2', kind: 'tool_call', name: 'search' }),
      frame('completion', { output: { answer: 42 } }),
    ];
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    const events = [];
    for await (const event of client.runAgent({ agentId: 'agent-1', input: 'go' })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'step', step: { id: 's1', kind: 'thought', content: 'thinking' } },
      { type: 'step', step: { id: 's2', kind: 'tool_call', name: 'search' } },
      { type: 'completion', output: { answer: 42 } },
    ]);
    const call = transport.only;
    expect(call.kind).toBe('stream');
    expect(call.request.url).toBe(`${baseUrl}/v1/agents/agent-1/runs`);
    expect(JSON.parse(call.request.body ?? '{}')).toMatchObject({ input: 'go' });
  });
});

describe('AuxifyClient search methods (Req 45.6)', () => {
  it('webSearch deserializes the result array and posts to /v1/web-search', async () => {
    const transport = new FakeTransport();
    const results = [{ title: 'A', url: 'https://a.test', snippet: 's', score: 0.9 }];
    transport.response = okResponse(results);
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    await expect(client.webSearch({ query: 'cats', limit: 5 })).resolves.toEqual(results);
    const { request } = transport.only;
    expect(request.url).toBe(`${baseUrl}/v1/web-search`);
    expect(JSON.parse(request.body ?? '{}')).toMatchObject({ query: 'cats', limit: 5 });
  });

  it('knowledgeSearch deserializes RetrievedContext and posts the query', async () => {
    const transport = new FakeTransport();
    const context = {
      chunks: [
        {
          content: 'chunk text',
          attribution: {
            sourceId: 'src-1',
            sourceTitle: 'Doc',
            location: 'p.2',
            link: 'https://doc.test',
          },
          score: 0.7,
        },
      ],
    };
    transport.response = okResponse(context);
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    await expect(client.knowledgeSearch('how to')).resolves.toEqual(context);
    const { request } = transport.only;
    expect(request.url).toBe(`${baseUrl}/v1/knowledge-base/search`);
    expect(JSON.parse(request.body ?? '{}')).toEqual({ query: 'how to' });
  });

  it('unifiedSearch deserializes GroupedResults and posts to /v1/search', async () => {
    const transport = new FakeTransport();
    const grouped = {
      groups: [
        { source: 'web', results: [{ title: 'W', url: 'https://w.test' }] },
        { source: 'knowledge-base', results: [{ title: 'K', url: 'https://k.test' }] },
      ],
    };
    transport.response = okResponse(grouped);
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    await expect(client.unifiedSearch('topic')).resolves.toEqual(grouped);
    expect(transport.only.request.url).toBe(`${baseUrl}/v1/search`);
  });
});

describe('AuxifyClient error handling (Req 45.5, 34.7)', () => {
  it('surfaces a non-2xx PlatformError body as a thrown AuxifyApiError', async () => {
    const platformError: PlatformError = createPlatformError({
      category: 'authorization',
      code: 'FORBIDDEN',
      message: 'not allowed',
      correlationId: 'corr-403',
    });
    const transport = new FakeTransport();
    transport.response = {
      status: 403,
      headers: { 'x-correlation-id': 'corr-403' },
      body: JSON.stringify(platformError),
    };
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    await expect(client.webSearch({ query: 'x' })).rejects.toBeInstanceOf(AuxifyApiError);
    await expect(client.webSearch({ query: 'x' })).rejects.toMatchObject({
      error: { category: 'authorization', code: 'FORBIDDEN', correlationId: 'corr-403' },
    });
  });

  it('surfaces an Err Result envelope as a thrown AuxifyApiError', async () => {
    const platformError = createPlatformError({
      category: 'validation',
      code: 'BAD_INPUT',
      message: 'invalid',
      correlationId: 'corr-400',
    });
    const transport = new FakeTransport();
    transport.response = okResponse({ ok: false, error: platformError });
    const client = new AuxifyClient({ baseUrl, token: 't', transport });

    await expect(client.chat({ modelId: 'm', prompt: 'q' })).rejects.toMatchObject({
      error: { category: 'validation', code: 'BAD_INPUT' },
    });
  });
});
