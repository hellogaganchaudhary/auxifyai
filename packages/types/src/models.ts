/**
 * AI model registry domain types.
 *
 * `ModelInfo` is the config-driven description of a single model exposed by the
 * Model_Registry (Req 2.6, 2.7). It is shared by the provider abstraction
 * layer, the Model_Router, the Client_SDK, and the web client so capability and
 * tier facts are described once (Req 46.8).
 */

/**
 * The cost/capability tier a model belongs to.
 *
 * Tiers drive Auto Mode routing and access gating: simple queries map to
 * `economy`, complex reasoning to `premium`, and code to `standard` (Req 3.4).
 * Premium-tier models require explicit Premium authorization (Req 19.5), and a
 * viewer is restricted to Economy models (Req 19.6).
 */
export type ModelTier = 'economy' | 'standard' | 'premium';

/** All {@link ModelTier} values, for iteration, validation, and test generators. */
export const MODEL_TIERS: readonly ModelTier[] = ['economy', 'standard', 'premium'] as const;

/**
 * The primary input/output modality a model serves.
 *
 * - `chat` — conversational text generation.
 * - `reasoning` — extended-thinking/reasoning text models.
 * - `realtime` — low-latency realtime (voice/streaming) sessions.
 * - `image` — image generation models that return image assets (Req 2.9).
 * - `embedding` — produces fixed-dimension embedding vectors.
 */
export type ModelModality = 'chat' | 'reasoning' | 'realtime' | 'image' | 'embedding';

/** All {@link ModelModality} values, for iteration, validation, and test generators. */
export const MODEL_MODALITIES: readonly ModelModality[] = [
  'chat',
  'reasoning',
  'realtime',
  'image',
  'embedding',
] as const;

/**
 * Per-1k-token costs for a model, in the platform's accounting currency.
 *
 * Costs feed routing, usage attribution, and budgets (Req 2.6, 3.9, 22.1).
 */
export interface ModelCost {
  /** Cost per 1,000 input (prompt) tokens. */
  per1kInputTokens: number;
  /** Cost per 1,000 output (completion) tokens. */
  per1kOutputTokens: number;
}

/**
 * The config-driven description of a single model in the Model_Registry.
 *
 * Onboarding a model is a configuration change, never a code change (Req 2.2),
 * and every listed model exposes its provider, identifier, modality, token
 * limit, capability flags, per-1k costs, and tier (Req 2.6, 2.7). `available`
 * reflects the most recent health check — failed checks mark a model
 * unavailable until a later check succeeds (Req 2.10).
 */
export interface ModelInfo {
  /** Platform-stable model id used by callers and routing (e.g. `gpt-4o`). */
  id: string;
  /** The provider that serves the model (e.g. `azure`, `bedrock`). */
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
  /**
   * Whether the model is currently available for routing. Set to `false` when
   * its provider's health check fails and back to `true` on a later success
   * (Req 2.10).
   */
  available: boolean;
}
