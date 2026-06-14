/**
 * Client_SDK request/result shapes (Req 45.6, 46.8).
 *
 * The SDK is a CLIENT of the platform's versioned REST_API (Req 45) and
 * WebSocket/SSE surface. To keep the wire contract described exactly once, these
 * shapes REUSE the shared domain types from `@auxify/types` wherever a shared
 * shape already exists — {@link ChatMessage}/{@link ChatRequest} for chat input,
 * {@link ContentBlock}/{@link TokenUsage} for chat output, {@link SourceAttribution}
 * for retrieval provenance, and {@link PlatformError}/{@link Result} for the typed
 * error model (Req 46.8). Only SDK-specific aggregates (the streaming event
 * unions, the search projections, and the transport port) are defined here.
 *
 * The SDK depends ONLY on `@auxify/types`; it never imports `@auxify/core`, so a
 * browser or third-party consumer pulls in just the shared shapes (Req 46.8).
 */

import type {
  ChatFinishReason,
  ChatMessage,
  ContentBlock,
  PlatformError,
  SourceAttribution,
  TokenUsage,
} from '@auxify/types';

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * A request to send a chat message (Req 45.6).
 *
 * A caller supplies either an ordered {@link messages} history (reusing the
 * shared {@link ChatMessage} shape) or a single {@link prompt} string that the
 * client wraps into a `user` message. `conversationId` targets an existing
 * conversation's messages route; when omitted the request goes to the
 * stateless chat route.
 */
export interface ChatSendRequest {
  /** The conversation to append to; when omitted the stateless chat route is used. */
  conversationId?: string;
  /** The platform-stable model id to route to (see `ModelInfo.id`). */
  modelId: string;
  /** The conversation so far, oldest first (reuses the shared {@link ChatMessage}). */
  messages?: ChatMessage[];
  /** A single prompt the client wraps into a `user` message when {@link messages} is absent. */
  prompt?: string;
  /** An optional persona id applied to the exchange. */
  persona?: string;
  /** Request a streamed response; informational for {@link ChatSendRequest} senders. */
  stream?: boolean;
  /** Sampling temperature; provider defaults apply when omitted. */
  temperature?: number;
  /** Maximum number of tokens to generate. */
  maxTokens?: number;
}

/**
 * An assistant message returned by a non-streaming chat call.
 *
 * `content` reuses the shared {@link ContentBlock} list (so retrieval-augmented
 * blocks keep their {@link SourceAttribution}); `usage` reuses the shared
 * {@link TokenUsage}. `id`/`conversationId` are present when the server persisted
 * the message.
 */
export interface Message {
  /** The persisted message id, when the server assigned one. */
  id?: string;
  /** The conversation the message belongs to, when persisted. */
  conversationId?: string;
  /** The author role; always `assistant` for a returned completion. */
  role: 'assistant';
  /** The rendered message content (reuses the shared {@link ContentBlock}). */
  content: ContentBlock[];
  /** The model that produced the message. */
  model?: string;
  /** Token usage for the call (reuses the shared {@link TokenUsage}). */
  usage?: TokenUsage;
  /** Why generation stopped. */
  finishReason?: ChatFinishReason;
}

/**
 * One event in a streamed chat response (Req 45.3, 45.6).
 *
 * A stream yields a sequence of `token` deltas and ends with a single
 * `completion` carrying the model and total {@link TokenUsage}, or terminates
 * with an `error` carrying the shared {@link PlatformError}. Callers branch on
 * `type` to narrow the variant.
 */
export type ChatEvent =
  | { type: 'token'; delta: string; index?: number }
  | {
      type: 'completion';
      model?: string;
      usage?: TokenUsage;
      finishReason?: ChatFinishReason;
      /** Total cost of the call in the platform's accounting currency, when reported. */
      cost?: number;
    }
  | { type: 'error'; error: PlatformError };

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * Input to start an agent run (Req 45.6).
 *
 * This is an SDK projection of the agent invocation contract; the backend
 * agent abstractions live in `@auxify/core` and are intentionally NOT imported
 * here (Req 46.8).
 */
export interface AgentRunInput {
  /** The agent to run. */
  agentId: string;
  /** The task/prompt the agent should act on. */
  input: string;
  /** Opaque per-run metadata (correlation hints, parameters, etc.). */
  metadata?: Record<string, unknown>;
}

/**
 * A single step an agent reports during a run.
 *
 * Kept minimal and structural: the SDK surfaces the step's kind, name, and any
 * human-readable content/output without coupling to the backend's internal
 * agent step model.
 */
export interface AgentStep {
  /** The step's id, when assigned. */
  id?: string;
  /** The kind of step (e.g. `thought`, `tool_call`, `observation`). */
  kind?: string;
  /** A human-readable step name. */
  name?: string;
  /** Human-readable step content, when present. */
  content?: string;
  /** Structured step output, when present. */
  output?: unknown;
}

/**
 * One event in a streamed agent run (Req 45.6).
 *
 * The stream yields a sequence of `step` events and ends with a `completion`
 * carrying the final output, or terminates with an `error` carrying the shared
 * {@link PlatformError}.
 */
export type AgentStepEvent =
  | { type: 'step'; step: AgentStep }
  | { type: 'completion'; output?: unknown; usage?: TokenUsage }
  | { type: 'error'; error: PlatformError };

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A web-search request (Req 45.6). */
export interface SearchRequest {
  /** The free-text query. */
  query: string;
  /** Maximum number of results to return. */
  limit?: number;
  /** Optional domain allow-list to constrain the search. */
  domains?: string[];
}

/** A single web-search result (Req 45.6). */
export interface SearchResult {
  /** The result title. */
  title: string;
  /** The resolvable result URL. */
  url: string;
  /** A short snippet/summary, when available. */
  snippet?: string;
  /** A relevance score, when reported. */
  score?: number;
}

/** A single retrieved knowledge-base chunk with its provenance (Req 24.4, 45.6). */
export interface RetrievedChunk {
  /** The retrieved chunk text. */
  content: string;
  /** Complete provenance for the chunk (reuses the shared {@link SourceAttribution}). */
  attribution: SourceAttribution;
  /** The retrieval similarity score, when reported. */
  score?: number;
}

/** The result of a knowledge-base search: the retrieved chunks and their sources (Req 45.6). */
export interface RetrievedContext {
  /** The retrieved chunks, most relevant first. */
  chunks: RetrievedChunk[];
}

/** A group of results from a single source within a unified search (Req 45.6). */
export interface SearchResultGroup {
  /** The source the group came from (e.g. `web`, `knowledge-base`, `documents`). */
  source: string;
  /** The results in this group. */
  results: SearchResult[];
}

/** The result of a unified search across sources (Req 45.6). */
export interface GroupedResults {
  /** The result groups, one per contributing source. */
  groups: SearchResultGroup[];
}

// ---------------------------------------------------------------------------
// Transport port (transport-agnostic, injectable)
// ---------------------------------------------------------------------------

/**
 * A normalized outbound request the {@link HttpTransport} carries on the wire.
 *
 * Headers are a plain string map; `body` is an already-serialized JSON string
 * (or omitted for a bodyless request). The SDK never assumes a concrete HTTP
 * client, so this stays a minimal value.
 */
export interface TransportRequest {
  /** The HTTP method. */
  method: string;
  /** The fully-qualified request URL. */
  url: string;
  /** The request headers to send. */
  headers: Record<string, string>;
  /** The serialized request body, when any. */
  body?: string;
}

/**
 * A buffered response returned by {@link HttpTransport.request}.
 *
 * `headers` keys are lower-cased so the SDK can read `x-correlation-id`
 * uniformly; `body` is the raw response text (parsed by the client).
 */
export interface TransportResponse {
  /** The HTTP status code. */
  status: number;
  /** The response headers, with lower-cased keys. */
  headers: Record<string, string>;
  /** The raw response body text. */
  body: string;
}

/**
 * A single server-sent-events frame yielded by {@link HttpTransport.stream}.
 *
 * Mirrors the SSE wire fields the REST_API emits (`event:`/`data:`/`id:`); the
 * client decodes `data` (a JSON string) into a {@link ChatEvent} or
 * {@link AgentStepEvent} based on `event`.
 */
export interface TransportFrame {
  /** The SSE `event:` name (e.g. `token`, `completion`, `error`), when set. */
  event?: string;
  /** The SSE `data:` payload (typically a JSON string). */
  data: string;
  /** The SSE `id:` field, when set. */
  id?: string;
}

/**
 * The narrow wire-transport port the SDK depends on (Req 45.6).
 *
 * Modelled as an injectable port so the SDK has NO hard dependency on
 * `fetch`/`undici`/`axios`: production wires {@link FetchHttpTransport} (global
 * `fetch`), and tests inject a fake. `request` performs a buffered call; `stream`
 * performs a server-sent-events call yielding decoded {@link TransportFrame}s.
 */
export interface HttpTransport {
  /** Perform a buffered request and return the full response. */
  request(req: TransportRequest): Promise<TransportResponse>;
  /** Perform a streaming (SSE) request, yielding decoded frames in order. */
  stream(req: TransportRequest): AsyncIterable<TransportFrame>;
}

/**
 * Construction options for the {@link AuxifyClient} (Req 45.2, 45.6).
 *
 * `baseUrl` is the API origin (e.g. `https://api.auxify.dev`); the client appends
 * the versioned `/v1/...` paths. Exactly one credential is normally supplied: a
 * JWT bearer `token` (attached as `Authorization: Bearer <token>`) or an
 * `apiKey` (attached as `X-API-Key`), mirroring the REST_API auth contract
 * (Req 45.2). A `transport` override injects a custom or fake {@link HttpTransport}.
 */
export interface SdkClientOptions {
  /** The API origin the client prefixes onto every versioned path. */
  baseUrl: string;
  /** A JWT bearer token, attached as `Authorization: Bearer <token>`. */
  token?: string;
  /** An API key, attached as `X-API-Key`. */
  apiKey?: string;
  /** A transport override; defaults to a global-`fetch` transport. */
  transport?: HttpTransport;
  /** A correlation-id factory for requests; defaults to a random id. */
  correlationIdFactory?: () => string;
}
