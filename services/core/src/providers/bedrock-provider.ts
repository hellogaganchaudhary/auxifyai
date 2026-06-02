/**
 * The Bedrock_Provider adapter — Anthropic Claude through AWS Bedrock (Req 2.4).
 *
 * {@link BedrockProvider} implements the unified {@link AIProvider} interface
 * (Req 2.1) for the Anthropic Claude Opus/Sonnet/Haiku families served by AWS
 * Bedrock. When a chat request targets a Claude model, it submits the request
 * to Bedrock using the *configured* Bedrock model identifier (the platform
 * model's {@link ModelInfo.providerModelId}) and the *configured* region (from
 * {@link ProviderConfig.region}) — exactly the contract Req 2.4 states.
 *
 * Design note (testability): the adapter never imports the AWS SDK. It talks to
 * Bedrock exclusively through a narrow {@link BedrockClientPort} — the same
 * "port + adapter" boundary used by the storage layer ({@link S3ClientPort},
 * {@link RedisClientPort}). All the value lives in this file: translating the
 * unified {@link ChatRequest} into Bedrock's Anthropic Messages wire shape,
 * mapping the streamed response events to {@link ChatChunk}s, accumulating
 * {@link TokenUsage}, mapping the stop reason, and applying the configured
 * identifiers/region. Wiring the port over `@aws-sdk/client-bedrock-runtime`
 * is left to infra; the adapter is fully unit-testable with a fake client.
 */

import type {
  ChatChunk,
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  EmbedRequest,
  EmbedResponse,
  HealthStatus,
  ImageRequest,
  ImageResponse,
  ModelInfo,
  RealtimeRequest,
  RealtimeSession,
  TokenUsage,
} from '@auxify/types';

import {
  assertChatCapability,
  assertImageGenerationCapability,
} from './capabilities.js';
import {
  UnsupportedModelCapabilityError,
  type AIProvider,
  type ModelRegistry,
  type ProviderConfig,
} from './types.js';

/**
 * The input to a single Bedrock model invocation.
 *
 * `modelId` is the Bedrock-native model id (the platform model's
 * {@link ModelInfo.providerModelId}, e.g. `anthropic.claude-sonnet-4-...`) and
 * `region` is the configured AWS region (Req 2.4). `body` is the JSON-serialized
 * request payload in the model's native wire shape (the adapter does the
 * shaping). Headers mirror the Bedrock Runtime API defaults.
 */
export interface BedrockInvokeModelInput {
  /** The Bedrock model id — the platform model's `providerModelId` (Req 2.4). */
  modelId: string;
  /** The configured AWS region the request targets (Req 2.4). */
  region: string;
  /** JSON-serialized request body in the model's native wire shape. */
  body: string;
  /** The `Accept` header; defaults to `application/json`. */
  accept?: string;
  /** The `Content-Type` header; defaults to `application/json`. */
  contentType?: string;
}

/** The result of a non-streaming {@link BedrockClientPort.invokeModel} call. */
export interface BedrockInvokeModelResult {
  /** JSON-serialized response body in the model's native wire shape. */
  body: string;
}

/**
 * A single decoded event from a Bedrock model response stream.
 *
 * Bedrock returns an event stream whose chunks each carry one decoded JSON
 * object; for Anthropic models these follow the Messages streaming shape
 * (`message_start`, `content_block_delta`, `message_delta`, `message_stop`).
 * The port yields the already-decoded JSON objects so the adapter owns all
 * mapping logic and stays SDK-agnostic.
 */
export type BedrockStreamEvent = Record<string, unknown>;

/**
 * Narrow port over the AWS Bedrock Runtime surface the adapter needs.
 *
 * Method names mirror the Bedrock Runtime API (`InvokeModel`,
 * `InvokeModelWithResponseStream`) so an adapter over
 * `@aws-sdk/client-bedrock-runtime` is a thin wrapper. Keeping the dependency
 * behind this port is the single boundary where the platform depends on the
 * AWS SDK, and it keeps {@link BedrockProvider} unit-testable without network
 * access or credentials.
 */
export interface BedrockClientPort {
  /** Invoke a model and return the full (non-streamed) response body. */
  invokeModel(input: BedrockInvokeModelInput): Promise<BedrockInvokeModelResult>;
  /** Invoke a model and stream decoded response events as they arrive (Req 4.2). */
  invokeModelWithResponseStream(
    input: BedrockInvokeModelInput,
  ): AsyncIterable<BedrockStreamEvent>;
  /** Lightweight reachability probe for the configured region (Req 2.10). */
  healthProbe(region: string): Promise<void>;
}

/** Construction options for a {@link BedrockProvider}. */
export interface BedrockProviderOptions {
  /** Default max output tokens when a request omits `maxTokens` (Anthropic requires it). */
  defaultMaxTokens?: number;
  /** The `anthropic_version` sent to Bedrock; defaults to `bedrock-2023-05-31`. */
  anthropicVersion?: string;
  /** Clock for deterministic health-check timestamps in tests; defaults to {@link Date.now}. */
  now?: () => number;
}

/** Default max output tokens for an Anthropic request when the caller omits it. */
const DEFAULT_MAX_TOKENS = 4096;
/** The Bedrock-specific Anthropic version string. */
const DEFAULT_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/** Narrow `unknown` to a plain record, or `undefined` when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read a string field from a record, or `undefined`. */
function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a finite number field from a record, or `undefined`. */
function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Map an Anthropic `stop_reason` to the unified {@link ChatFinishReason}
 * (Req 4.3). Unknown reasons fall back to `stop`.
 */
function mapStopReason(stopReason: string | undefined): ChatFinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

/** Translate one {@link ChatMessage}'s content into Anthropic content blocks. */
function toAnthropicContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    // Vision input: Bedrock Anthropic accepts a base64 source, or a url source.
    if (part.image.base64 !== undefined) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.image.mimeType,
          data: part.image.base64,
        },
      };
    }
    return { type: 'image', source: { type: 'url', url: part.image.url } };
  });
}

/**
 * The AWS Bedrock provider adapter for Anthropic Claude models (Req 2.4).
 */
export class BedrockProvider implements AIProvider {
  readonly providerId: string;

  private readonly region: string;
  private readonly anthropicVersion: string;
  private readonly defaultMaxTokens: number;
  private readonly now: () => number;

  /**
   * @param config   The provider's configuration; `region` is required and is
   *                 the region every request targets (Req 2.4).
   * @param registry The Model_Registry used to resolve a platform model id to
   *                 its `providerModelId` and capability flags.
   * @param client   The injected Bedrock transport port (a real SDK wrapper in
   *                 production, a fake in tests).
   */
  constructor(
    config: ProviderConfig,
    private readonly registry: ModelRegistry,
    private readonly client: BedrockClientPort,
    options: BedrockProviderOptions = {},
  ) {
    this.providerId = config.id;
    if (typeof config.region !== 'string' || config.region.length === 0) {
      throw new Error(
        `BedrockProvider "${config.id}" requires a configured region (ProviderConfig.region)`,
      );
    }
    this.region = config.region;
    this.anthropicVersion =
      options.anthropicVersion ??
      readString(config.settings, 'anthropicVersion') ??
      DEFAULT_ANTHROPIC_VERSION;
    this.defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Stream a Claude chat completion through Bedrock (Req 2.4, 4.2).
   *
   * Builds the Anthropic Messages request from the unified {@link ChatRequest},
   * submits it with the configured `providerModelId` and region, maps each
   * streamed `content_block_delta` to a {@link ChatChunk}, and ends with a
   * terminal chunk carrying the model, accumulated {@link TokenUsage}, and
   * finish reason (Req 4.3). Enforces the vision capability gate (Req 2.8).
   */
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const model = this.resolveModel(req.modelId);
    assertChatCapability(model, req);

    const body = this.buildChatBody(req, model);
    const stream = this.client.invokeModelWithResponseStream({
      modelId: model.providerModelId,
      region: this.region,
      body: JSON.stringify(body),
    });

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: string | undefined;

    for await (const event of stream) {
      const type = readString(event, 'type');

      if (type === 'message_start') {
        const message = asRecord(event.message);
        const inputTokens = readNumber(asRecord(message?.usage), 'input_tokens');
        if (inputTokens !== undefined) {
          usage.inputTokens = inputTokens;
        }
        continue;
      }

      if (type === 'content_block_delta') {
        const delta = asRecord(event.delta);
        const text = readString(delta, 'text');
        if (text !== undefined && text.length > 0) {
          yield { delta: text };
        }
        continue;
      }

      if (type === 'message_delta') {
        const delta = asRecord(event.delta);
        stopReason = readString(delta, 'stop_reason') ?? stopReason;
        const outputTokens = readNumber(asRecord(event.usage), 'output_tokens');
        if (outputTokens !== undefined) {
          usage.outputTokens = outputTokens;
        }
        continue;
      }
      // `content_block_start`, `content_block_stop`, `message_stop`, `ping`
      // carry no token deltas for the unified contract and are ignored.
    }

    yield {
      delta: '',
      done: true,
      model: req.modelId,
      finishReason: mapStopReason(stopReason),
      usage,
    };
  }

  /**
   * Produce embeddings through Bedrock for an embedding-modality model.
   *
   * Sends one Titan-style `{ inputText }` invocation per input via the
   * configured `providerModelId`/region and maps each response `embedding`.
   */
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const model = this.resolveModel(req.modelId);
    if (model.modality !== 'embedding') {
      throw new UnsupportedModelCapabilityError(
        model.id,
        'embedding',
        `model "${model.id}" (modality "${model.modality}") does not support embeddings`,
      );
    }

    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const embeddings: number[][] = [];
    let inputTokens = 0;

    for (const text of inputs) {
      const result = await this.client.invokeModel({
        modelId: model.providerModelId,
        region: this.region,
        body: JSON.stringify({ inputText: text }),
      });
      const parsed = asRecord(JSON.parse(result.body));
      const vector = parsed?.embedding;
      if (!Array.isArray(vector)) {
        throw new Error(`Bedrock embedding response for "${model.id}" lacked an embedding array`);
      }
      embeddings.push(vector as number[]);
      inputTokens += readNumber(parsed, 'inputTextTokenCount') ?? 0;
    }

    return {
      embeddings,
      model: req.modelId,
      usage: { inputTokens, outputTokens: 0 },
    };
  }

  /**
   * Generate image assets through Bedrock for an image-modality model (Req 2.9).
   *
   * Enforces the image-generation capability gate and maps the returned base64
   * `images` array to {@link ImageResponse}.
   */
  async generateImage(req: ImageRequest): Promise<ImageResponse> {
    const model = this.resolveModel(req.modelId);
    assertImageGenerationCapability(model);

    const count = req.count ?? 1;
    const result = await this.client.invokeModel({
      modelId: model.providerModelId,
      region: this.region,
      body: JSON.stringify({
        taskType: 'TEXT_IMAGE',
        textToImageParams: { text: req.prompt },
        imageGenerationConfig: { numberOfImages: count },
      }),
    });

    const parsed = asRecord(JSON.parse(result.body));
    const images = Array.isArray(parsed?.images) ? (parsed.images as unknown[]) : [];
    return {
      images: images
        .filter((value): value is string => typeof value === 'string')
        .map((base64) => ({ mimeType: 'image/png', base64 })),
      model: req.modelId,
    };
  }

  /**
   * Bedrock does not serve realtime sessions; routing a realtime request here
   * is a capability mismatch (Req 2.5 places realtime on the Azure_Provider).
   */
  realtime(req: RealtimeRequest): RealtimeSession {
    const model = this.resolveModel(req.modelId);
    throw new UnsupportedModelCapabilityError(
      model.id,
      'realtime',
      `provider "${this.providerId}" does not support realtime sessions`,
    );
  }

  /** List the registry's models served by this provider, with full metadata (Req 2.7). */
  async listModels(): Promise<ModelInfo[]> {
    return this.registry.list().filter((model) => model.provider === this.providerId);
  }

  /** Probe Bedrock reachability for the configured region (Req 2.10). */
  async healthCheck(): Promise<HealthStatus> {
    const startedAt = this.now();
    try {
      await this.client.healthProbe(this.region);
      return {
        providerId: this.providerId,
        healthy: true,
        checkedAt: new Date(this.now()).toISOString(),
        latencyMs: this.now() - startedAt,
      };
    } catch (error) {
      return {
        providerId: this.providerId,
        healthy: false,
        checkedAt: new Date(this.now()).toISOString(),
        latencyMs: this.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Build the Anthropic Messages request body from the unified request. */
  private buildChatBody(req: ChatRequest, model: ModelInfo): Record<string, unknown> {
    const systemParts: string[] = [];
    if (req.systemPrompt !== undefined && req.systemPrompt.length > 0) {
      systemParts.push(req.systemPrompt);
    }

    const messages: Array<{ role: string; content: unknown }> = [];
    for (const message of req.messages) {
      if (message.role === 'system') {
        const text = typeof message.content === 'string' ? message.content : '';
        if (text.length > 0) {
          systemParts.push(text);
        }
        continue;
      }
      // Anthropic recognizes `user` and `assistant`; a tool result is carried
      // back as a user-authored turn.
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: toAnthropicContent(message.content) });
    }

    const body: Record<string, unknown> = {
      anthropic_version: this.anthropicVersion,
      max_tokens: req.maxTokens ?? this.defaultMaxTokens,
      messages,
    };
    if (systemParts.length > 0) {
      body.system = systemParts.join('\n\n');
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    if (model.supportsTools && req.tools !== undefined && req.tools.length > 0) {
      body.tools = req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters ?? { type: 'object', properties: {} },
      }));
    }
    return body;
  }

  /**
   * Resolve a platform model id to a {@link ModelInfo} served by this provider.
   * @throws {ModelNotFoundError} when the id is unknown.
   * @throws {Error} when the model belongs to a different provider.
   */
  private resolveModel(modelId: string): ModelInfo {
    const model = this.registry.get(modelId);
    if (model.provider !== this.providerId) {
      throw new Error(
        `model "${modelId}" is served by provider "${model.provider}", not "${this.providerId}"`,
      );
    }
    return model;
  }
}
