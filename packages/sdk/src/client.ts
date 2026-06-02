/**
 * The Client_SDK's typed client (Req 45.6, 46.8).
 *
 * {@link AuxifyClient} implements {@link ClientSDK} over the narrow, injectable
 * {@link HttpTransport} port: it builds versioned `/v1/...` requests, attaches
 * the configured credential and correlation id on EVERY request (mirroring the
 * REST_API auth contract, Req 45.2), and decodes the platform's typed
 * {@link Result}/{@link PlatformError} responses into SDK values or thrown typed
 * errors. It reuses the shared `@auxify/types` shapes throughout and never
 * imports `@auxify/core` (Req 46.8).
 *
 * Error contract: a non-2xx response (or an `Err` result envelope) carrying a
 * {@link PlatformError} JSON body is surfaced as a rejected promise (or, for the
 * streaming methods, a terminal `error` event) carrying an {@link AuxifyApiError}
 * whose {@link AuxifyApiError.error} is the decoded {@link PlatformError}.
 */

import {
  createPlatformError,
  type ChatFinishReason,
  type ChatMessage,
  type PlatformError,
  type Result,
} from '@auxify/types';

import { FetchHttpTransport } from './transport';
import type {
  AgentRunInput,
  AgentStep,
  AgentStepEvent,
  ChatEvent,
  ChatSendRequest,
  GroupedResults,
  HttpTransport,
  Message,
  RetrievedContext,
  SdkClientOptions,
  SearchRequest,
  SearchResult,
  TransportFrame,
  TransportRequest,
} from './types';

/** The header carrying (and propagating) the request correlation id (Req 46.7). */
const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * The typed client surface of the Client_SDK (Req 45.6).
 *
 * Provides chat, streaming chat, agent runs, web search, knowledge-base search,
 * and unified search, all over the shared `@auxify/types` shapes (Req 46.8).
 */
export interface ClientSDK {
  /** Send a chat message and resolve the assistant {@link Message}. */
  chat(req: ChatSendRequest): Promise<Message>;
  /** Send a chat message and stream the response as {@link ChatEvent}s. */
  streamChat(req: ChatSendRequest): AsyncIterable<ChatEvent>;
  /** Start an agent run and stream its {@link AgentStepEvent}s. */
  runAgent(req: AgentRunInput): AsyncIterable<AgentStepEvent>;
  /** Run a web search and resolve the {@link SearchResult}s. */
  webSearch(req: SearchRequest): Promise<SearchResult[]>;
  /** Search the knowledge base and resolve the {@link RetrievedContext}. */
  knowledgeSearch(query: string): Promise<RetrievedContext>;
  /** Run a unified search across sources and resolve the {@link GroupedResults}. */
  unifiedSearch(query: string): Promise<GroupedResults>;
}

/**
 * An error thrown (or surfaced as a stream `error` event) when the platform
 * returns a typed {@link PlatformError}.
 *
 * Carries the decoded {@link PlatformError} so callers can branch on its
 * `category`/`code`, read its `correlationId`, and honor `retriable`/
 * `retryAfterSeconds` without re-parsing the wire body.
 */
export class AuxifyApiError extends Error {
  /** The decoded platform error this exception carries. */
  readonly error: PlatformError;

  constructor(error: PlatformError) {
    super(error.message);
    this.name = 'AuxifyApiError';
    this.error = error;
  }
}

/**
 * The typed Client_SDK client (Req 45.6).
 *
 * Construct it with the API {@link SdkClientOptions.baseUrl} and a credential
 * (`token` or `apiKey`); inject a custom or fake {@link HttpTransport} for tests.
 */
export class AuxifyClient implements ClientSDK {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly transport: HttpTransport;
  private readonly correlationIdFactory: () => string;

  constructor(options: SdkClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.apiKey = options.apiKey;
    this.transport = options.transport ?? new FetchHttpTransport();
    this.correlationIdFactory =
      options.correlationIdFactory ?? (() => `sdk_${Math.random().toString(36).slice(2)}`);
  }

  /**
   * Send a chat message and resolve the assistant {@link Message} (Req 45.6).
   *
   * Targets the conversation's messages route when {@link ChatSendRequest.conversationId}
   * is set, otherwise the stateless chat route. Rejects with an
   * {@link AuxifyApiError} when the server returns a {@link PlatformError}.
   */
  async chat(req: ChatSendRequest): Promise<Message> {
    const path =
      req.conversationId !== undefined
        ? `/v1/conversations/${encodeURIComponent(req.conversationId)}/messages`
        : '/v1/chat';
    const response = await this.transport.request(
      this.buildRequest('POST', path, this.chatBody(req)),
    );
    return this.unwrap<Message>(response.status, response.body, response.headers);
  }

  /**
   * Send a chat message and stream the response as {@link ChatEvent}s (Req 45.3, 45.6).
   *
   * Targets the conversation's messages route with `?stream=true` when a
   * conversation id is set, otherwise the dedicated chat-stream route. Decodes
   * SSE `token` frames into token events ending with a `completion`, or a
   * terminal `error` event.
   */
  streamChat(req: ChatSendRequest): AsyncIterable<ChatEvent> {
    const path =
      req.conversationId !== undefined
        ? `/v1/conversations/${encodeURIComponent(req.conversationId)}/messages?stream=true`
        : '/v1/chat/stream';
    const transportRequest = this.buildRequest('POST', path, this.chatBody(req));
    const frames = this.transport.stream(transportRequest);
    return mapFrames(frames, decodeChatFrame);
  }

  /**
   * Start an agent run and stream its {@link AgentStepEvent}s (Req 45.6).
   *
   * Decodes SSE `step` frames into step events ending with a `completion`, or a
   * terminal `error` event.
   */
  runAgent(req: AgentRunInput): AsyncIterable<AgentStepEvent> {
    const path = `/v1/agents/${encodeURIComponent(req.agentId)}/runs`;
    const body: Record<string, unknown> = { input: req.input };
    if (req.metadata !== undefined) {
      body.metadata = req.metadata;
    }
    const transportRequest = this.buildRequest('POST', path, body);
    const frames = this.transport.stream(transportRequest);
    return mapFrames(frames, decodeAgentFrame);
  }

  /** Run a web search and resolve the {@link SearchResult}s (Req 45.6). */
  async webSearch(req: SearchRequest): Promise<SearchResult[]> {
    const response = await this.transport.request(
      this.buildRequest('POST', '/v1/web-search', req),
    );
    return this.unwrap<SearchResult[]>(response.status, response.body, response.headers);
  }

  /** Search the knowledge base and resolve the {@link RetrievedContext} (Req 45.6). */
  async knowledgeSearch(query: string): Promise<RetrievedContext> {
    const response = await this.transport.request(
      this.buildRequest('POST', '/v1/knowledge-base/search', { query }),
    );
    return this.unwrap<RetrievedContext>(response.status, response.body, response.headers);
  }

  /** Run a unified search across sources and resolve the {@link GroupedResults} (Req 45.6). */
  async unifiedSearch(query: string): Promise<GroupedResults> {
    const response = await this.transport.request(
      this.buildRequest('POST', '/v1/search', { query }),
    );
    return this.unwrap<GroupedResults>(response.status, response.body, response.headers);
  }

  /** Build the chat request body, reusing the shared {@link ChatMessage} shape. */
  private chatBody(req: ChatSendRequest): Record<string, unknown> {
    const messages: ChatMessage[] =
      req.messages ??
      (req.prompt !== undefined ? [{ role: 'user', content: req.prompt }] : []);
    const body: Record<string, unknown> = { modelId: req.modelId, messages };
    if (req.persona !== undefined) {
      body.persona = req.persona;
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    if (req.maxTokens !== undefined) {
      body.maxTokens = req.maxTokens;
    }
    return body;
  }

  /**
   * Build a {@link TransportRequest}: prefix the base URL, serialize the JSON
   * body, and attach `Content-Type`, the auth credential, and a correlation id
   * on EVERY request (Req 45.2, 46.7). The token/key values are attached only as
   * headers and are never logged.
   */
  private buildRequest(method: string, path: string, body?: unknown): TransportRequest {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      [CORRELATION_ID_HEADER]: this.correlationIdFactory(),
    };
    if (this.token !== undefined) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (this.apiKey !== undefined) {
      headers['x-api-key'] = this.apiKey;
    }
    const request: TransportRequest = { method, url: `${this.baseUrl}${path}`, headers };
    if (body !== undefined) {
      request.body = JSON.stringify(body);
    }
    return request;
  }

  /**
   * Decode a buffered response into its success value or throw an
   * {@link AuxifyApiError}.
   *
   * A non-2xx status whose body is a {@link PlatformError} is thrown as a typed
   * error; a {@link Result} envelope is unwrapped (`Err` thrown, `Ok` returned);
   * otherwise the parsed body is returned as the value.
   */
  private unwrap<T>(status: number, body: string, headers: Record<string, string>): T {
    const correlationId = headers[CORRELATION_ID_HEADER] ?? '';
    const parsed = parseJson(body);

    if (status < 200 || status >= 300) {
      throw new AuxifyApiError(toPlatformError(parsed, correlationId));
    }

    if (isResultEnvelope(parsed)) {
      if (parsed.ok) {
        return parsed.value as T;
      }
      throw new AuxifyApiError(parsed.error);
    }

    return parsed as T;
  }
}

/** Map an SSE frame stream through a per-frame decoder, skipping `null` decodes. */
async function* mapFrames<T>(
  frames: AsyncIterable<TransportFrame>,
  decode: (frame: TransportFrame) => T | null,
): AsyncIterable<T> {
  for await (const frame of frames) {
    const event = decode(frame);
    if (event !== null) {
      yield event;
    }
  }
}

/** Decode one SSE frame into a {@link ChatEvent}, or `null` for an unknown frame. */
function decodeChatFrame(frame: TransportFrame): ChatEvent | null {
  const data = parseJson(frame.data);
  switch (frame.event) {
    case 'token': {
      const record = asRecord(data);
      const delta = typeof record.delta === 'string' ? record.delta : '';
      const event: ChatEvent = { type: 'token', delta };
      if (typeof record.index === 'number') {
        event.index = record.index;
      }
      return event;
    }
    case 'completion': {
      const record = asRecord(data);
      const event: ChatEvent = { type: 'completion' };
      if (typeof record.model === 'string') {
        event.model = record.model;
      }
      if (isTokenUsage(record.usage)) {
        event.usage = record.usage;
      }
      if (typeof record.finishReason === 'string') {
        event.finishReason = record.finishReason as ChatFinishReason;
      }
      return event;
    }
    case 'error':
      return { type: 'error', error: toPlatformError(data, '') };
    default:
      return null;
  }
}

/** Decode one SSE frame into an {@link AgentStepEvent}, or `null` for an unknown frame. */
function decodeAgentFrame(frame: TransportFrame): AgentStepEvent | null {
  const data = parseJson(frame.data);
  switch (frame.event) {
    case 'step': {
      const record = asRecord(data);
      const step: AgentStep = {};
      if (typeof record.id === 'string') {
        step.id = record.id;
      }
      if (typeof record.kind === 'string') {
        step.kind = record.kind;
      }
      if (typeof record.name === 'string') {
        step.name = record.name;
      }
      if (typeof record.content === 'string') {
        step.content = record.content;
      }
      if (record.output !== undefined) {
        step.output = record.output;
      }
      return { type: 'step', step };
    }
    case 'completion': {
      const record = asRecord(data);
      const event: AgentStepEvent = { type: 'completion' };
      if (record.output !== undefined) {
        event.output = record.output;
      }
      if (isTokenUsage(record.usage)) {
        event.usage = record.usage;
      }
      return event;
    }
    case 'error':
      return { type: 'error', error: toPlatformError(data, '') };
    default:
      return null;
  }
}

/** Parse a JSON string, returning `undefined` for empty/invalid input. */
function parseJson(text: string): unknown {
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Narrow an unknown value to a plain record for safe field reads. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Whether a parsed value is a {@link Result} envelope (`{ ok: boolean, ... }`). */
function isResultEnvelope(value: unknown): value is Result<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';
}

/** Whether a value matches the shared `TokenUsage` shape. */
function isTokenUsage(value: unknown): value is { inputTokens: number; outputTokens: number } {
  const record = asRecord(value);
  return typeof record.inputTokens === 'number' && typeof record.outputTokens === 'number';
}

/**
 * Coerce a parsed body into a {@link PlatformError}. A well-formed platform
 * error body is used as-is; anything else is wrapped in a safe `internal` error
 * so callers always receive a typed value (Req 34.7).
 */
function toPlatformError(value: unknown, fallbackCorrelationId: string): PlatformError {
  const record = asRecord(value);
  if (
    typeof record.category === 'string' &&
    typeof record.code === 'string' &&
    typeof record.message === 'string' &&
    typeof record.correlationId === 'string' &&
    typeof record.retriable === 'boolean'
  ) {
    return record as unknown as PlatformError;
  }
  return createPlatformError({
    category: 'internal',
    code: 'SDK_MALFORMED_ERROR',
    message: 'the server returned an error that could not be decoded',
    correlationId: fallbackCorrelationId,
  });
}
