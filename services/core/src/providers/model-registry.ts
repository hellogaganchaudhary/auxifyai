/**
 * The configuration-driven Model_Registry (Req 2.2, 2.6, 2.7, 2.10).
 *
 * {@link ConfigModelRegistry} is the in-memory catalog the rest of the platform
 * reads to discover models. It is loaded entirely from a {@link RegistryConfig}
 * — onboarding a new provider or model is a configuration change, never a code
 * change (Req 2.2) — and exposes each model's provider, identifier, modality,
 * token limit, capability flags, per-1k costs, and tier (Req 2.6, 2.7). The
 * health checker (task 5.4) flips per-model availability through
 * {@link ConfigModelRegistry.markUnavailable}/{@link ConfigModelRegistry.markAvailable}
 * so listings always reflect the most recent health outcome (Req 2.10).
 */

import type { ModelInfo } from '@auxify/types';

import {
  InvalidRegistryConfigError,
  ModelNotFoundError,
  type ModelConfig,
  type ModelRegistry,
  type RegistryConfig,
} from './types.js';

/** The modalities a {@link ModelConfig} may declare (used for structural validation). */
const VALID_MODALITIES = new Set(['chat', 'reasoning', 'realtime', 'image', 'embedding']);
/** The tiers a {@link ModelConfig} may declare (used for structural validation). */
const VALID_TIERS = new Set(['economy', 'standard', 'premium']);

/**
 * Project a {@link ModelConfig} into a runtime {@link ModelInfo}, applying the
 * initial availability (config `available`, defaulting to `true`). The result
 * is a fresh object so the registry owns its mutable availability state and
 * callers cannot mutate the catalog by holding a reference.
 */
function toModelInfo(config: ModelConfig): ModelInfo {
  return {
    id: config.id,
    provider: config.provider,
    providerModelId: config.providerModelId,
    displayName: config.displayName,
    modality: config.modality,
    tier: config.tier,
    maxTokens: config.maxTokens,
    supportsVision: config.supportsVision,
    supportsTools: config.supportsTools,
    supportsReasoning: config.supportsReasoning,
    cost: {
      per1kInputTokens: config.cost.per1kInputTokens,
      per1kOutputTokens: config.cost.per1kOutputTokens,
    },
    available: config.available ?? true,
  };
}

/** Validate a single model config entry, throwing on the first structural problem. */
function validateModelConfig(model: ModelConfig, index: number): void {
  const where = `models[${index}] (id "${model.id ?? '<missing>'}")`;
  if (typeof model.id !== 'string' || model.id.length === 0) {
    throw new InvalidRegistryConfigError(`${where} must have a non-empty string id`);
  }
  if (typeof model.provider !== 'string' || model.provider.length === 0) {
    throw new InvalidRegistryConfigError(`${where} must reference a non-empty provider id`);
  }
  if (typeof model.providerModelId !== 'string' || model.providerModelId.length === 0) {
    throw new InvalidRegistryConfigError(`${where} must have a non-empty providerModelId`);
  }
  if (!VALID_MODALITIES.has(model.modality)) {
    throw new InvalidRegistryConfigError(`${where} has an invalid modality "${model.modality}"`);
  }
  if (!VALID_TIERS.has(model.tier)) {
    throw new InvalidRegistryConfigError(`${where} has an invalid tier "${model.tier}"`);
  }
  if (!Number.isFinite(model.maxTokens) || model.maxTokens <= 0) {
    throw new InvalidRegistryConfigError(`${where} must have a positive numeric maxTokens`);
  }
  if (
    model.cost === undefined ||
    !Number.isFinite(model.cost.per1kInputTokens) ||
    !Number.isFinite(model.cost.per1kOutputTokens) ||
    model.cost.per1kInputTokens < 0 ||
    model.cost.per1kOutputTokens < 0
  ) {
    throw new InvalidRegistryConfigError(`${where} must have non-negative numeric per-1k costs`);
  }
}

/**
 * In-memory {@link ModelRegistry} loaded from a {@link RegistryConfig} (Req 2.2).
 *
 * Insertion order is preserved across {@link ConfigModelRegistry.list} so a
 * config's ordering is stable and deterministic. Availability is tracked
 * separately from configuration so health transitions (Req 2.10) never mutate
 * the loaded config.
 */
export class ConfigModelRegistry implements ModelRegistry {
  /** Loaded models keyed by id; a Map preserves insertion order for `list()`. */
  private readonly models = new Map<string, ModelInfo>();

  /**
   * Construct an empty registry, or one preloaded from `config`.
   *
   * @param config Optional initial configuration to {@link ConfigModelRegistry.load}.
   */
  constructor(config?: RegistryConfig) {
    if (config !== undefined) {
      this.load(config);
    }
  }

  /**
   * Replace the catalog with the models declared in `config` (Req 2.2).
   *
   * Validates atomically before mutating: duplicate model ids, models that
   * reference an undeclared provider (when `providers` is supplied), and
   * structurally invalid entries all throw {@link InvalidRegistryConfigError}
   * and leave the prior catalog untouched.
   */
  load(config: RegistryConfig): void {
    if (config === null || typeof config !== 'object' || !Array.isArray(config.models)) {
      throw new InvalidRegistryConfigError('config must be an object with a `models` array');
    }

    // Build the set of declared provider ids for referential-integrity checks.
    // When no providers are declared, model.provider is accepted as-is so a
    // minimal config (models only) still loads.
    const declaredProviders = new Set<string>();
    if (config.providers !== undefined) {
      if (!Array.isArray(config.providers)) {
        throw new InvalidRegistryConfigError('`providers` must be an array when present');
      }
      for (const [index, provider] of config.providers.entries()) {
        if (typeof provider.id !== 'string' || provider.id.length === 0) {
          throw new InvalidRegistryConfigError(
            `providers[${index}] must have a non-empty string id`,
          );
        }
        if (declaredProviders.has(provider.id)) {
          throw new InvalidRegistryConfigError(`duplicate provider id "${provider.id}"`);
        }
        declaredProviders.add(provider.id);
      }
    }

    // Validate every model into a staging map first (atomic load).
    const staged = new Map<string, ModelInfo>();
    for (const [index, model] of config.models.entries()) {
      validateModelConfig(model, index);
      if (staged.has(model.id)) {
        throw new InvalidRegistryConfigError(`duplicate model id "${model.id}"`);
      }
      if (declaredProviders.size > 0 && !declaredProviders.has(model.provider)) {
        throw new InvalidRegistryConfigError(
          `models[${index}] (id "${model.id}") references undeclared provider "${model.provider}"`,
        );
      }
      staged.set(model.id, toModelInfo(model));
    }

    // Commit only after the whole config validates.
    this.models.clear();
    for (const [id, info] of staged) {
      this.models.set(id, info);
    }
  }

  /**
   * Return the model registered under `modelId` (Req 2.7).
   *
   * Returns a defensive copy so callers cannot mutate the catalog in place.
   * @throws {ModelNotFoundError} when no model is registered with that id.
   */
  get(modelId: string): ModelInfo {
    const info = this.models.get(modelId);
    if (info === undefined) {
      throw new ModelNotFoundError(modelId);
    }
    return { ...info, cost: { ...info.cost } };
  }

  /**
   * Return every registered model, in load order, each carrying its modality,
   * tier, costs, and capability flags (Req 2.7). Each entry is a defensive copy.
   */
  list(): ModelInfo[] {
    return [...this.models.values()].map((info) => ({ ...info, cost: { ...info.cost } }));
  }

  /** True iff a model is registered under `modelId`. */
  has(modelId: string): boolean {
    return this.models.has(modelId);
  }

  /**
   * Mark `modelId` unavailable for routing after a failed health check (Req 2.10).
   * @throws {ModelNotFoundError} when no model is registered with that id.
   */
  markUnavailable(modelId: string): void {
    this.setAvailability(modelId, false);
  }

  /**
   * Mark `modelId` available again after a succeeding health check (Req 2.10).
   * @throws {ModelNotFoundError} when no model is registered with that id.
   */
  markAvailable(modelId: string): void {
    this.setAvailability(modelId, true);
  }

  private setAvailability(modelId: string, available: boolean): void {
    const info = this.models.get(modelId);
    if (info === undefined) {
      throw new ModelNotFoundError(modelId);
    }
    info.available = available;
  }
}
