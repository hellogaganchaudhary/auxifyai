/**
 * The Azure_Provider adapter — OpenAI GPT, reasoning, realtime, and image
 * models through Azure AI Foundry (Req 2.5).
 *
 * {@link AzureProvider} implements the unified {@link AIProvider} interface
 * (Req 2.1) for the GPT-family chat models, OpenAI reasoning models, realtime
 * models, and image-generation models served by Azure AI Foundry / Azure
 * OpenAI. When a request targets one of those models, it submits the request to
 * Azure using the *configured* deployment name (the platform model's
 * {@link ModelInfo.providerModelId}) and the *configured* API version (from
 * {@link ProviderConfig.apiVersion}) — exactly the contract Req 2.5 states.
 *
 * Design note (testability): the adapter never imports the Azure SDK. It talks
 * to Azure exclusively through a narrow {@link AzureClientPort} — the same
 * "port + adapter" boundary used by the storage layer. All the value lives in
 * this file: translating the unified {@link ChatRequest} into the Azure OpenAI
 * Chat Completions wire shape, mapping the streamed SSE deltas to
 * {@link ChatChunk}s, accumulating {@link TokenUsage}, mapping the finish
 * reason, and routing every call to `/openai/deployments/{deployment}/...` with
 * `?api-version={apiVersion}`. Wiring the port over the Azure OpenAI SDK is left
 * to infra; the adapter is fully unit-testable with a fake client.
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
 * A request to an Azure OpenAI deployment.
 *
 * `deployment` is the configured Azure deployment name (the platform model's
 * {@link ModelInfo.providerModelId}, e.g. `gpt-4o`), `apiVersion` is the
 * configured API version (e.g. `2024-10-21`), and `operation` selects the
 * REST surface — together they form the Azure route
 * `/openai/deployments/{deployment}/{operation}?api-version={apiVersion}`
 * (Req 2.5). `body` is the JSON-serialized payload the adapter shaped.
 */
export interface AzureRequestInput {
  /** The configured Azure deployment name — the model's `providerModelId` (Req 2.5). */
  deployment: string;
  /** The configured Azure API version (Req 2.5). */
  apiVersion: string;
  /** The deployment operation: `chat/completions`, `embeddings`, or `images/generations`. */
  operation: 'chat/completions' | 'embeddings' | 'images/generations';
  /** JSON-serialized request body in the Azure OpenAI wire shape. */
  body: string;
}

/** The result of a non-streaming {@link AzureClientPort.send} call. */
export interface AzureResponseResult {
  /** JSON-serialized response body in the Azure OpenAI wire shape. */
  body: string;
}

/**
 * A single decoded SSE event from an Azure OpenAI streaming response.
 *
 * The Chat Completions streaming API emits `data:` lines each carrying one JSON
 * chunk with a `choices[].delta`. The port yields the already-parsed JSON
 * objects so the adapter owns all mapping logic and stays SDK-agnostic.
 */
export type AzureStreamEvent = Record<string, unknown>;

/**
 * Narrow port over the Azure AI Foundry / Azure OpenAI surface the adapter
 * needs.
 *
 * The method signatures carry the configured `deployment` and `apiVersion` so a
 * real adapter is a thin wrapper that builds the
 * `/openai/deployments/{deployment}/...?api-version=...` URL. Keeping the
 * dependency behind this port is the single boundary where the platform depends
 * on the Azure SDK, and it keeps {@link AzureProvider} unit-testable without
 * network access or credentials.
 */
export interface AzureClientPort {
  /** Send a non-streaming request to a deployment and return the response body. */
  send(input: AzureRequestInput): Promise<AzureResponseResult>;
  /** Send a streaming chat request and yield decoded SSE chunks as they arrive (Req 4.2). */
  sendStream(input: AzureRequestInput): AsyncIterable<AzureStreamEvent>;
  /** Open a realtime session against a deployment (Req 2.5). */
  openRealtime(input: {
    deployment: string;
    apiVersion: string;
    instructions?: string;
    voice?: string;
  }): Promise<{ sessionId: string; close(): Promise<void> }>;
  /** Lightweight reachability probe for the configured endpoint (Req 2.10). */
  healthProbe(apiVersion: string): Promise<void>;
}

/** Construction options for an {@link AzureProvider}. */
export interface AzureProviderOptions {
  /**
   * Per-modality API-version overrides. Azure image and realtime models often
   * require a different (preview) API version than chat; when omitted the
   * provider's configured `apiVersion` is used for every modality.
   */
  apiVersionOverrides?: Partial<Record<ModelInfo['modality'], string>>;
  /** Clock for deterministic health-check timestamps in tests; defaults to {@link Date.now}. */
  now?: () => number;
}

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
 * Map an OpenAI `finish_reason` to the unified {@link ChatFinishReason}
 * (Req 4.3). Unknown/absent reasons fall back to `stop`.
 */
function mapFinishReason(finishReason: string | undefined): ChatFinishReason {
  switch (finishReason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** Translate one {@link ChatMessage}'s content into the OpenAI content shape. */
function toOpenAIContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    const url =
      part.image.url ??
      (part.image.base64 !== undefined
        ? `data:${part.image.mimeType};base64,${part.image.base64}`
        : '');
    return { type: 'image_url', image_url: { url } };
  });
}

/**
 * The Azure AI Foundry provider adapter for GPT/reasoning/realtime/image
 * models (Req 2.5).
 */
export class AzureProvider implements AIProvider {
  readonly providerId: string;

  private readonly apiVersion: string;
  private readonly apiVersionOverrides: Partial<Record<ModelInfo['modality'], string>>;
  private readonly now: () => number;

  /**
   * @param config   The provider's configuration; `apiVersion` is required and
   *                 is sent on every request (Req 2.5).
   * @param registry The Model_Registry used to resolve a platform model id to
   *                 its deployment name (`providerModelId`) and capabilities.
   * @param client   The injected Azure transport port (a real SDK wrapper in
   *                 production, a fake in tests).
   */
  constructor(
    config: ProviderConfig,
    private readonly registry: ModelRegistry,
    private readonly client: AzureClientPort,
    options: AzureProviderOptions = {},
  ) {
    this.providerId = config.id;
    if (typeof config.apiVersion !== 'string' || config.apiVersion.length === 0) {
      throw new Error(
        `AzureProvider "${config.id}" requires a configured apiVersion (ProviderConfig.apiVersion)`,
      );
    }
    this.apiVersion = config.apiVersion;
    this.apiVersionOverrides = options.apiVersionOverrides ?? {};
    this.now = options.now ?? Date.now;
  }

  /**
   * Stream a GPT/reasoning chat completion through Azure (Req 2.5, 4.2).
   *
   * Builds the Azure OpenAI Chat Completions request from the unified
   * {@link ChatRequest}, submits it to the configured deployment with the
   * configured API version, maps each streamed `choices[].delta.content` to a
   * {@link ChatChunk}, and ends with a terminal chunk carrying the model,
   * accumulated {@link TokenUsage}, and finish reason (Req 4.3). Enforces the
   * vision capability gate (Req 2.8).
   */
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const model = this.resolveModel(req.modelId);
    assertChatCapability(model, req);

    const body = this.buildChatBody(req, model);
    const stream = this.client.sendStream({
      deployment: model.providerModelId,
      apiVersion: this.apiVersionFor(model),
      operation: 'chat/completions',
      body: JSON.stringify(body),
    });

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: string | undefined;

    for await (const event of stream) {
      const choices = Array.isArray(event.choices) ? (event.choices as unknown[]) : [];
      const choice = asRecord(choices[0]);
      if (choice !== undefined) {
        const delta = asRecord(choice.delta);
        const text = readString(delta, 'content');
        if (text !== undefined && text.length > 0) {
          yield { delta: text };
        }
        finishReason = readString(choice, 'finish_reason') ?? finishReason;
      }

      // Azure emits a trailing chunk with `usage` when `stream_options.include_usage`
      // is set; capture it for the terminal chunk.
      const eventUsage = asRecord(event.usage);
      if (eventUsage !== undefined) {
        usage.inputTokens = readNumber(eventUsage, 'prompt_tokens') ?? usage.inputTokens;
        usage.outputTokens = readNumber(eventUsage, 'completion_tokens') ?? usage.outputTokens;
      }
    }

    yield {
      delta: '',
      done: true,
      model: req.modelId,
      finishReason: mapFinishReason(finishReason),
      usage,
    };
  }

  /**
   * Produce embeddings through Azure for an embedding-modality model.
   *
   * Sends one `embeddings` request (a batched `input`) to the configured
   * deployment/API version and maps each `data[].embedding`.
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
    const result = await this.client.send({
      deployment: model.providerModelId,
      apiVersion: this.apiVersionFor(model),
      operation: 'embeddings',
      body: JSON.stringify({ input: inputs }),
    });

    const parsed = asRecord(JSON.parse(result.body));
    const data = Array.isArray(parsed?.data) ? (parsed.data as unknown[]) : [];
    const embeddings = data.map((entry) => {
      const vector = asRecord(entry)?.embedding;
      if (!Array.isArray(vector)) {
        throw new Error(`Azure embedding response for "${model.id}" lacked an embedding array`);
      }
      return vector as number[];
    });

    const usageRecord = asRecord(parsed?.usage);
    return {
      embeddings,
      model: req.modelId,
      usage: {
        inputTokens: readNumber(usageRecord, 'prompt_tokens') ?? 0,
        outputTokens: 0,
      },
    };
  }

  /**
   * Generate image assets through Azure for an image-modality model (Req 2.5, 2.9).
   *
   * Enforces the image-generation capability gate, submits an
   * `images/generations` request to the configured deployment/API version, and
   * maps the returned `data[]` (base64 or url) to {@link ImageResponse}.
   */
  async generateImage(req: ImageRequest): Promise<ImageResponse> {
    const model = this.resolveModel(req.modelId);
    assertImageGenerationCapability(model);

    const result = await this.client.send({
      deployment: model.providerModelId,
      apiVersion: this.apiVersionFor(model),
      operation: 'images/generations',
      body: JSON.stringify({
        prompt: req.prompt,
        n: req.count ?? 1,
        size: req.size ?? '1024x1024',
      }),
    });

    const parsed = asRecord(JSON.parse(result.body));
    const data = Array.isArray(parsed?.data) ? (parsed.data as unknown[]) : [];
    return {
      images: data.map((entry) => {
        const record = asRecord(entry);
        const base64 = readString(record, 'b64_json');
        const url = readString(record, 'url');
        return {
          mimeType: 'image/png',
          ...(base64 !== undefined ? { base64 } : {}),
          ...(url !== undefined ? { url } : {}),
        };
      }),
      model: req.modelId,
    };
  }

  /**
   * Open a realtime session through Azure for a realtime-modality model
   * (Req 2.5). Uses the configured deployment and the realtime API version.
   */
  realtime(req: RealtimeRequest): RealtimeSession {
    const model = this.resolveModel(req.modelId);
    if (model.modality !== 'realtime') {
      throw new UnsupportedModelCapabilityError(
        model.id,
        'realtime',
        `model "${model.id}" (modality "${model.modality}") does not support realtime sessions`,
      );
    }

    const session: RealtimeSession = {
      sessionId: `azure-rt-pending-${this.now()}`,
      modelId: req.modelId,
      status: 'open',
      close: async () => {
        session.status = 'closed';
      },
    };

    // Establish the underlying transport asynchronously; the handle is returned
    // synchronously per the AIProvider contract.
    void this.client
      .openRealtime({
        deployment: model.providerModelId,
        apiVersion: this.apiVersionFor(model),
        instructions: req.instructions,
        voice: req.voice,
      })
      .then((opened) => {
        session.sessionId = opened.sessionId;
        const innerClose = opened.close;
        session.close = async () => {
          session.status = 'closed';
          await innerClose();
        };
      })
      .catch(() => {
        session.status = 'closed';
      });

    return session;
  }

  /** List the registry's models served by this provider, with full metadata (Req 2.7). */
  async listModels(): Promise<ModelInfo[]> {
    return this.registry.list().filter((model) => model.provider === this.providerId);
  }

  /** Probe Azure reachability for the configured API version (Req 2.10). */
  async healthCheck(): Promise<HealthStatus> {
    const startedAt = this.now();
    try {
      await this.client.healthProbe(this.apiVersion);
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

  /** Build the Azure OpenAI Chat Completions request body from the unified request. */
  private buildChatBody(req: ChatRequest, model: ModelInfo): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];
    if (req.systemPrompt !== undefined && req.systemPrompt.length > 0) {
      // Reasoning models use a `developer` role in place of `system`.
      const systemRole = model.modality === 'reasoning' ? 'developer' : 'system';
      messages.push({ role: systemRole, content: req.systemPrompt });
    }
    for (const message of req.messages) {
      messages.push({
        role: message.role,
        content: toOpenAIContent(message.content),
        ...(message.name !== undefined ? { name: message.name } : {}),
      });
    }

    const body: Record<string, unknown> = {
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (req.maxTokens !== undefined) {
      // Reasoning models require `max_completion_tokens`; chat uses `max_tokens`.
      if (model.modality === 'reasoning') {
        body.max_completion_tokens = req.maxTokens;
      } else {
        body.max_tokens = req.maxTokens;
      }
    }
    // Reasoning models reject `temperature`; only forward it for non-reasoning.
    if (req.temperature !== undefined && model.modality !== 'reasoning') {
      body.temperature = req.temperature;
    }
    if (model.supportsTools && req.tools !== undefined && req.tools.length > 0) {
      body.tools = req.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      }));
    }
    return body;
  }

  /** The API version to use for a model: a per-modality override, else the configured default. */
  private apiVersionFor(model: ModelInfo): string {
    return this.apiVersionOverrides[model.modality] ?? this.apiVersion;
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
