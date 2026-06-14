/**
 * Cross-cutting AI provider request/response types.
 *
 * These describe the request and response payloads of the unified provider
 * interface (the `AIProvider` port) exposed by the Provider_Abstraction_Layer
 * (Req 2.1). They are defined here — rather than in the backend — because the
 * Client_SDK and the web client reuse the exact same chat/embed/image/realtime
 * shapes when they talk to the REST_API and WebSocket_Gateway, so the wire
 * contract is described exactly once (Req 46.8).
 *
 * The backend-only abstractions that consume these types — the `AIProvider`
 * interface itself, the `ModelRegistry`, and the `RegistryConfig` — live in
 * `@auxify/core`'s provider layer, since concrete adapters (Bedrock, Azure) are
 * never reused by clients.
 */

/** The author of a {@link ChatMessage}. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * An image supplied as chat input, by inline bytes or by reference.
 *
 * Image inputs are only accepted by vision-capable models
 * ({@link ModelInfo.supportsVision}); routing a request with image parts to a
 * non-vision model is rejected by the Provider_Abstraction_Layer (Req 2.8,
 * 3.6).
 */
export interface ImageInput {
  /** The image MIME type, e.g. `image/png`, `image/jpeg`, `image/webp`. */
  mimeType: string;
  /** Base64-encoded image bytes, when the image is supplied inline. */
  base64?: string;
  /** A resolvable URL to the image, when supplied by reference. */
  url?: string;
}

/**
 * A single part of a multimodal chat message: either text or an image.
 *
 * A message whose content is a plain `string` is text-only; an array of parts
 * lets a vision-capable model receive interleaved text and image attachments
 * (Req 2.8).
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: ImageInput };

/**
 * One message in a chat conversation sent to a model.
 *
 * `content` is either plain text or an ordered list of {@link ChatContentPart}s
 * for multimodal (vision) input. Image parts are only valid for vision-capable
 * models (Req 2.8).
 */
export interface ChatMessage {
  /** Who authored the message. */
  role: ChatRole;
  /** Plain text, or multimodal parts for vision-capable models (Req 2.8). */
  content: string | ChatContentPart[];
  /** The tool name, when `role` is `tool` (carries a tool result back to the model). */
  name?: string;
}

/**
 * A tool/function the model may call, advertised on a {@link ChatRequest}.
 *
 * Only honored by models that declare {@link ModelInfo.supportsTools}. The
 * `parameters` schema is a JSON Schema object describing the tool's arguments.
 */
export interface ChatToolDefinition {
  /** The tool's unique name. */
  name: string;
  /** A human-readable description used by the model to decide when to call it. */
  description?: string;
  /** JSON Schema describing the tool's input arguments. */
  parameters?: Record<string, unknown>;
}

/**
 * A request to a chat (or reasoning) model through the unified provider
 * interface (Req 2.1).
 */
export interface ChatRequest {
  /** The platform-stable model id to route to (see {@link ModelInfo.id}). */
  modelId: string;
  /** The conversation so far, oldest first. */
  messages: ChatMessage[];
  /** An optional system prompt applied ahead of `messages`. */
  systemPrompt?: string;
  /** Sampling temperature; provider defaults apply when omitted. */
  temperature?: number;
  /** Maximum number of tokens to generate in the response. */
  maxTokens?: number;
  /** Tools the model may call (honored only by tool-capable models). */
  tools?: ChatToolDefinition[];
  /** Opaque per-request metadata (correlation ids, routing hints, etc.). */
  metadata?: Record<string, unknown>;
}

/** Token counts reported by a provider for a single request. */
export interface TokenUsage {
  /** Number of input (prompt) tokens consumed. */
  inputTokens: number;
  /** Number of output (completion) tokens produced. */
  outputTokens: number;
}

/** Why a streamed chat response stopped producing tokens. */
export type ChatFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'cancelled'
  | 'error';

/**
 * A single incremental chunk of a streamed chat response.
 *
 * Providers yield a sequence of chunks as tokens are produced (Req 4.2); the
 * final chunk carries `done: true` together with the model used, the total
 * {@link TokenUsage}, and a {@link ChatFinishReason} so the Streaming_Engine can
 * emit a completion event with model, token counts, and cost (Req 4.3).
 */
export interface ChatChunk {
  /** The incremental text produced since the previous chunk (a token delta). */
  delta: string;
  /** `true` on the terminal chunk; absent/`false` on intermediate chunks. */
  done?: boolean;
  /** The model that produced the response (typically set on the final chunk). */
  model?: string;
  /** Cumulative token usage, included on the final chunk. */
  usage?: TokenUsage;
  /** Why generation stopped, included on the final chunk. */
  finishReason?: ChatFinishReason;
}

/**
 * A request to embed one or more inputs into fixed-dimension vectors (Req 2.1).
 *
 * Every embedding the platform persists has exactly 1536 dimensions (Req 44.2),
 * enforced at the storage boundary; an embedding model must therefore produce
 * 1536-dimension vectors.
 */
export interface EmbedRequest {
  /** The embedding model id to use. */
  modelId: string;
  /** A single input or a batch of inputs to embed. */
  input: string | string[];
}

/** The result of an {@link EmbedRequest}: one 1536-dimension vector per input. */
export interface EmbedResponse {
  /** One embedding vector per input, each exactly 1536 dimensions (Req 44.2). */
  embeddings: number[][];
  /** The model that produced the embeddings. */
  model: string;
  /** Token usage for the embedding call, when reported by the provider. */
  usage?: TokenUsage;
}

/** A request to generate one or more images (Req 2.9). */
export interface ImageRequest {
  /** The image-generation model id to use. */
  modelId: string;
  /** The text prompt describing the desired image. */
  prompt: string;
  /** The requested image dimensions, e.g. `1024x1024`. */
  size?: string;
  /** How many images to generate (defaults to 1). */
  count?: number;
}

/** A single generated image asset, returned inline or by reference (Req 2.9). */
export interface GeneratedImage {
  /** The image MIME type, e.g. `image/png`. */
  mimeType: string;
  /** Base64-encoded image bytes, when returned inline. */
  base64?: string;
  /** A resolvable URL to the generated image, when returned by reference. */
  url?: string;
}

/** The result of an {@link ImageRequest}: the generated image assets (Req 2.9). */
export interface ImageResponse {
  /** The generated images. */
  images: GeneratedImage[];
  /** The model that produced the images. */
  model: string;
}

/** A request to open a low-latency realtime (voice/streaming) session (Req 2.1). */
export interface RealtimeRequest {
  /** The realtime model id to use. */
  modelId: string;
  /** Optional system instructions for the session. */
  instructions?: string;
  /** Optional voice identifier for audio output. */
  voice?: string;
  /** Opaque per-session metadata. */
  metadata?: Record<string, unknown>;
}

/** The lifecycle state of a {@link RealtimeSession}. */
export type RealtimeSessionStatus = 'open' | 'closed';

/**
 * A handle to an open realtime session (Req 2.1).
 *
 * Returned synchronously by `AIProvider.realtime` so the caller can immediately
 * reference the session; concrete adapters extend this with their transport
 * (WebSocket/WebRTC) plumbing.
 */
export interface RealtimeSession {
  /** The session's unique id. */
  sessionId: string;
  /** The model serving the session. */
  modelId: string;
  /** The session's current lifecycle state. */
  status: RealtimeSessionStatus;
  /** Close the session and release its resources. */
  close(): Promise<void>;
}

/**
 * The outcome of a provider health check (Req 2.10).
 *
 * A periodic checker calls `AIProvider.healthCheck`; when `healthy` is `false`
 * the Provider_Abstraction_Layer marks that provider's models unavailable until
 * a later check reports `healthy: true`.
 */
export interface HealthStatus {
  /** The provider this status describes. */
  providerId: string;
  /** Whether the provider is currently healthy. */
  healthy: boolean;
  /** ISO-8601 timestamp of when the check was performed. */
  checkedAt: string;
  /** Round-trip latency of the health probe, in milliseconds, when measured. */
  latencyMs?: number;
  /** A human-readable detail, typically the failure reason when unhealthy. */
  detail?: string;
}
