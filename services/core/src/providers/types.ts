/**
 * The Provider_Abstraction_Layer contract (Req 2).
 *
 * This module defines the single boundary through which all AI model traffic
 * flows: the unified {@link AIProvider} interface (Req 2.1), the
 * configuration-driven {@link ModelRegistry} (Req 2.2), and the
 * {@link RegistryConfig} that onboards models and providers without any code
 * change (Req 2.2). Concrete adapters (Bedrock, Azure — task 5.3) and the
 * health-gating checker (task 5.4) build on these contracts.
 *
 * The request/response payloads ({@link ChatRequest}, {@link ChatChunk},
 * {@link EmbedRequest}/{@link EmbedResponse}, {@link ImageRequest}/
 * {@link ImageResponse}, {@link RealtimeRequest}/{@link RealtimeSession},
 * {@link HealthStatus}) and the catalog record {@link ModelInfo} are shared
 * types from `@auxify/types` because the Client_SDK and web client reuse them
 * (Req 46.8). The backend-only abstractions — the interface, the registry, and
 * the config — live here because concrete adapters are never reused by clients.
 */

import type {
  ChatChunk,
  ChatRequest,
  EmbedRequest,
  EmbedResponse,
  HealthStatus,
  ImageRequest,
  ImageResponse,
  ModelCost,
  ModelInfo,
  ModelModality,
  ModelTier,
  RealtimeRequest,
  RealtimeSession,
} from '@auxify/types';

/**
 * The unified provider interface every AI provider adapter implements (Req 2.1).
 *
 * It exposes chat, embedding, image generation, realtime, model listing, and
 * health-check operations behind one stable contract so the rest of the
 * platform — the Model_Router, Chat_Service, RAG_Retriever — never depends on a
 * specific vendor. Adapters (Bedrock, Azure) implement this same interface
 * (task 5.3) and are selected purely by configuration.
 */
export interface AIProvider {
  /** Stable provider identifier, e.g. `bedrock`, `azure` (matches {@link ModelInfo.provider}). */
  readonly providerId: string;

  /**
   * Stream a chat (or reasoning) completion token-by-token (Req 2.1, 4.2).
   *
   * Image parts in the request are only valid when the target model is
   * vision-capable ({@link ModelInfo.supportsVision}); otherwise the call is
   * rejected (Req 2.8).
   */
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;

  /** Produce 1536-dimension embedding vectors for the request inputs (Req 2.1, 44.2). */
  embed(req: EmbedRequest): Promise<EmbedResponse>;

  /**
   * Generate image assets from a prompt (Req 2.1, 2.9).
   *
   * Only valid for image-modality models; routing to a non-image model is
   * rejected (Req 2.9).
   */
  generateImage(req: ImageRequest): Promise<ImageResponse>;

  /** Open a low-latency realtime session (Req 2.1). */
  realtime(req: RealtimeRequest): RealtimeSession;

  /** List the models this provider serves, each with modality, tier, costs, and capabilities (Req 2.7). */
  listModels(): Promise<ModelInfo[]>;

  /** Report provider health; failures gate model availability (Req 2.10). */
  healthCheck(): Promise<HealthStatus>;
}

/**
 * A provider entry in a {@link RegistryConfig}.
 *
 * Declaring providers lets the registry validate that every model references a
 * known provider, and carries provider-level connection facts (region,
 * endpoint, API version) consumed by the concrete adapters in task 5.3.
 * Provider-specific fields are kept open so onboarding a provider stays a pure
 * configuration change (Req 2.2).
 */
export interface ProviderConfig {
  /** Stable provider id referenced by {@link ModelConfig.provider}. */
  id: string;
  /** Human-readable provider name. */
  displayName?: string;
  /** The kind of adapter that serves this provider (e.g. `bedrock`, `azure`). */
  kind?: string;
  /** Default region (e.g. AWS Bedrock region), when applicable. */
  region?: string;
  /** Default API endpoint/base URL, when applicable. */
  endpoint?: string;
  /** Default API version (e.g. Azure AI Foundry API version), when applicable. */
  apiVersion?: string;
  /** Additional adapter-specific settings, kept open for config-only onboarding. */
  settings?: Record<string, unknown>;
}

/**
 * The configuration record for a single model (Req 2.2, 2.6).
 *
 * It mirrors {@link ModelInfo} minus the runtime `available` flag — availability
 * is health state owned by the registry, not configuration (Req 2.10). An
 * optional `available` may seed the initial state (defaults to `true`).
 * Onboarding a model is achieved by adding one of these to a
 * {@link RegistryConfig}; no source change is required (Req 2.2).
 */
export interface ModelConfig {
  /** Platform-stable model id used by callers and routing (e.g. `gpt-4o`). */
  id: string;
  /** The id of the {@link ProviderConfig} that serves this model. */
  provider: string;
  /** The provider-native model identifier or deployment name. */
  providerModelId: string;
  /** Human-readable display name. */
  displayName: string;
  /** The model's primary modality. */
  modality: ModelModality;
  /** The cost/capability tier the model belongs to. */
  tier: ModelTier;
  /** Maximum total token limit (context window) the model supports. */
  maxTokens: number;
  /** Whether the model accepts image inputs (vision) (Req 2.8, 3.6). */
  supportsVision: boolean;
  /** Whether the model supports tool/function calling. */
  supportsTools: boolean;
  /** Whether the model supports extended reasoning. */
  supportsReasoning: boolean;
  /** Per-1k-token input/output costs. */
  cost: ModelCost;
  /** Optional initial availability; defaults to `true` when omitted. */
  available?: boolean;
}

/**
 * The complete, configuration-driven catalog loaded into a {@link ModelRegistry}
 * (Req 2.2).
 *
 * `providers` is optional; when present, every {@link ModelConfig.provider} must
 * reference a declared provider (referential integrity is validated on load).
 * Adding a provider or model here — by editing a config object or file — is the
 * only step required to onboard it (Req 2.2).
 */
export interface RegistryConfig {
  /** The providers available to the platform. */
  providers?: ProviderConfig[];
  /** Every model the platform exposes. */
  models: ModelConfig[];
}

/**
 * The configuration-driven model catalog (Req 2.2, 2.6, 2.7).
 *
 * Holds the full set of {@link ModelInfo} records and tracks each model's
 * current availability. Onboarding is `load(config)`; lookup is `get`/`list`;
 * the health checker (task 5.4) flips availability through `markUnavailable`/
 * `markAvailable` (Req 2.10).
 */
export interface ModelRegistry {
  /**
   * Load (replacing any prior state) the catalog from configuration (Req 2.2).
   *
   * Validates the config — rejecting duplicate model ids, unknown provider
   * references, and structurally invalid models — so a bad config fails fast
   * rather than silently producing a partial catalog.
   */
  load(config: RegistryConfig): void;

  /** Return the model by id, or throw {@link ModelNotFoundError} when absent. */
  get(modelId: string): ModelInfo;

  /** Return every model with its modality, tier, costs, and capabilities (Req 2.7). */
  list(): ModelInfo[];

  /** Mark a model unavailable (Req 2.10). Throws {@link ModelNotFoundError} if unknown. */
  markUnavailable(modelId: string): void;

  /** Mark a model available again (Req 2.10). Throws {@link ModelNotFoundError} if unknown. */
  markAvailable(modelId: string): void;
}

/** Thrown by {@link ModelRegistry.get} (and availability mutators) for an unknown model id. */
export class ModelNotFoundError extends Error {
  constructor(public readonly modelId: string) {
    super(`No model registered with id "${modelId}".`);
    this.name = 'ModelNotFoundError';
  }
}

/**
 * Thrown when a {@link RegistryConfig} is invalid — duplicate model ids, a model
 * referencing an undeclared provider, or a structurally invalid model entry.
 * Loading fails atomically so the registry is never left partially populated.
 */
export class InvalidRegistryConfigError extends Error {
  constructor(message: string) {
    super(`Invalid registry config: ${message}`);
    this.name = 'InvalidRegistryConfigError';
  }
}

/**
 * Thrown when a request does not match a model's declared capabilities — for
 * example, image attachments sent to a non-vision model (Req 2.8) or an image
 * generation request routed to a non-image model (Req 2.9).
 */
export class UnsupportedModelCapabilityError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly capability: 'vision' | 'image_generation' | 'embedding' | 'realtime' | 'chat',
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedModelCapabilityError';
  }
}
