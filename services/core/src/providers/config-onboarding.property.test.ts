/**
 * Property-based test for **Property 9: Config-driven model onboarding and
 * listing completeness** (Req 2.2, 2.6, 2.7), the configuration boundary of the
 * Provider_Abstraction_Layer (Req 2).
 *
 * Validates: Requirements 2.2, 2.6, 2.7
 *
 * Property statement (design.md): _for any_ valid {@link RegistryConfig} — an
 * arbitrary set of well-formed models with unique ids that reference declared
 * providers — after {@link ConfigModelRegistry.load}:
 *
 *   - {@link ConfigModelRegistry.list} returns **exactly** the configured set of
 *     models: every configured model is listed (completeness) and nothing extra
 *     is listed (soundness). Onboarding a model is purely adding it to the
 *     config — never a code change (Req 2.2).
 *   - each listed {@link ModelInfo} faithfully exposes the configured modality,
 *     tier, per-1k costs, capability flags (vision/tools/reasoning), and
 *     maxTokens (Req 2.6, 2.7).
 *   - {@link ConfigModelRegistry.get} returns the same record for every
 *     configured id, and throws {@link ModelNotFoundError} for an unknown id.
 *
 * It also demonstrates config-driven onboarding directly (Req 2.2): starting
 * from a config A, loading A ∪ {newModel} makes the new model appear in
 * `list()`/`get()` with no source change — a model is present in the listing
 * iff it is present in the config. Finally it checks that the availability
 * mutators flip the `available` flag surfaced in the listing (deeper
 * health-gating is Property 10 / task 5.5).
 *
 * The registry is exercised through its real public surface — no mocks, no
 * reimplementation of its logic — so the assertions test the production
 * `load`/`get`/`list` paths end to end.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MODEL_MODALITIES, MODEL_TIERS, type ModelInfo } from '@auxify/types';

import {
  ConfigModelRegistry,
  ModelNotFoundError,
  type ModelConfig,
  type ProviderConfig,
  type RegistryConfig,
} from './index.js';

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

/** An id that the hex-string generators below can never produce. */
const ABSENT_ID = '__definitely_missing__';

// ---------------------------------------------------------------------------
// Generators — produce arbitrary VALID configs: unique non-empty model ids,
// valid modality/tier enums, positive maxTokens, non-negative finite costs, and
// provider references that are always declared.
// ---------------------------------------------------------------------------

/** Non-empty identifier (hex chars only, so {@link ABSENT_ID} is never generated). */
const idArb: fc.Arbitrary<string> = fc.hexaString({ minLength: 1, maxLength: 8 });

/** A non-negative, finite per-1k token cost (Req 2.6). */
const costArb: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A well-formed {@link ModelConfig} whose `provider` is drawn from `providerIds`. */
function modelConfigArb(providerIds: readonly string[]): fc.Arbitrary<ModelConfig> {
  return fc.record({
    id: idArb,
    provider: fc.constantFrom(...providerIds),
    providerModelId: fc.hexaString({ minLength: 1, maxLength: 10 }),
    displayName: fc.string({ maxLength: 24 }),
    modality: fc.constantFrom(...MODEL_MODALITIES),
    tier: fc.constantFrom(...MODEL_TIERS),
    maxTokens: fc.integer({ min: 1, max: 2_000_000 }),
    supportsVision: fc.boolean(),
    supportsTools: fc.boolean(),
    supportsReasoning: fc.boolean(),
    cost: fc.record({
      per1kInputTokens: costArb,
      per1kOutputTokens: costArb,
    }),
    // Optional initial availability; undefined exercises the default-true path.
    available: fc.option(fc.boolean(), { nil: undefined }),
  });
}

/** An arbitrary valid {@link RegistryConfig} (0..12 models over 1..4 providers). */
const validConfigArb: fc.Arbitrary<RegistryConfig> = fc
  .uniqueArray(idArb, { minLength: 1, maxLength: 4 })
  .chain((providerIds) =>
    fc
      .uniqueArray(modelConfigArb(providerIds), {
        selector: (m) => m.id,
        maxLength: 12,
      })
      .map((models) => {
        const providers: ProviderConfig[] = providerIds.map((id) => ({ id }));
        return { providers, models } satisfies RegistryConfig;
      }),
  );

/** Like {@link validConfigArb} but guarantees at least one model. */
const nonEmptyConfigArb: fc.Arbitrary<RegistryConfig> = fc
  .uniqueArray(idArb, { minLength: 1, maxLength: 4 })
  .chain((providerIds) =>
    fc
      .uniqueArray(modelConfigArb(providerIds), {
        selector: (m) => m.id,
        minLength: 1,
        maxLength: 12,
      })
      .map((models) => {
        const providers: ProviderConfig[] = providerIds.map((id) => ({ id }));
        return { providers, models } satisfies RegistryConfig;
      }),
  );

/**
 * An onboarding scenario: a declared provider set, a `base` catalog, and one
 * `newModel` whose id is guaranteed absent from `base` and whose provider is
 * declared. Built by holding out the last entry of a globally-unique model set.
 */
interface OnboardingScenario {
  providers: ProviderConfig[];
  base: ModelConfig[];
  newModel: ModelConfig;
}

const onboardingArb: fc.Arbitrary<OnboardingScenario> = fc
  .uniqueArray(idArb, { minLength: 1, maxLength: 4 })
  .chain((providerIds) =>
    fc
      .uniqueArray(modelConfigArb(providerIds), {
        selector: (m) => m.id,
        minLength: 1,
        maxLength: 12,
      })
      .map((models) => {
        const providers: ProviderConfig[] = providerIds.map((id) => ({ id }));
        const newModel = models[models.length - 1]!;
        const base = models.slice(0, -1);
        return { providers, base, newModel };
      }),
  );

// ---------------------------------------------------------------------------
// Oracle — the runtime record a model config must project to (Req 2.6, 2.7).
// ---------------------------------------------------------------------------

/** The {@link ModelInfo} the registry must expose for a given {@link ModelConfig}. */
function expectedInfo(model: ModelConfig): ModelInfo {
  return {
    id: model.id,
    provider: model.provider,
    providerModelId: model.providerModelId,
    displayName: model.displayName,
    modality: model.modality,
    tier: model.tier,
    maxTokens: model.maxTokens,
    supportsVision: model.supportsVision,
    supportsTools: model.supportsTools,
    supportsReasoning: model.supportsReasoning,
    cost: {
      per1kInputTokens: model.cost.per1kInputTokens,
      per1kOutputTokens: model.cost.per1kOutputTokens,
    },
    // Availability is health state, defaulting to available on load (Req 2.10).
    available: model.available ?? true,
  };
}

// ---------------------------------------------------------------------------
// Property 9.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 9: Config-driven model onboarding and listing completeness', () => {
  it('lists exactly the configured models with faithful metadata, and get() round-trips every id (Validates: Requirements 2.2, 2.6, 2.7)', () => {
    fc.assert(
      fc.property(validConfigArb, (config) => {
        const registry = new ConfigModelRegistry();
        registry.load(config);

        const expected = config.models.map(expectedInfo);

        // Completeness + soundness + insertion order + faithful metadata, all
        // at once: the listing equals exactly the projected configured set.
        expect(registry.list()).toEqual(expected);

        // Soundness (explicit): nothing in the listing is absent from the config.
        const configuredIds = new Set(config.models.map((m) => m.id));
        for (const info of registry.list()) {
          expect(configuredIds.has(info.id)).toBe(true);
        }

        // Completeness (explicit): every configured model is listed exactly once.
        const listedIds = registry.list().map((m) => m.id);
        expect([...listedIds].sort()).toEqual([...configuredIds].sort());
        expect(listedIds.length).toBe(config.models.length);

        // get(id) returns the same faithful record for every configured id
        // (modality, tier, costs, capability flags, maxTokens — Req 2.6, 2.7).
        for (const model of config.models) {
          expect(registry.get(model.id)).toEqual(expectedInfo(model));
        }

        // get(unknown) throws ModelNotFoundError (Req 2.7).
        expect(() => registry.get(ABSENT_ID)).toThrow(ModelNotFoundError);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('onboards a model purely by adding it to the config — no code change (Validates: Requirements 2.2)', () => {
    fc.assert(
      fc.property(onboardingArb, ({ providers, base, newModel }) => {
        const registry = new ConfigModelRegistry();

        // Config A: the new model is neither listed nor retrievable.
        registry.load({ providers, models: base });
        expect(registry.list().some((m) => m.id === newModel.id)).toBe(false);
        expect(() => registry.get(newModel.id)).toThrow(ModelNotFoundError);

        // Config A ∪ {newModel}: a config-only change makes it appear.
        const onboarded: RegistryConfig = { providers, models: [...base, newModel] };
        registry.load(onboarded);

        // Present-in-config iff present-in-listing, for the whole catalog.
        const listedIds = new Set(registry.list().map((m) => m.id));
        const configuredIds = new Set(onboarded.models.map((m) => m.id));
        expect(listedIds).toEqual(configuredIds);

        // The newly onboarded model is now listed and retrievable, faithfully.
        expect(listedIds.has(newModel.id)).toBe(true);
        expect(registry.get(newModel.id)).toEqual(expectedInfo(newModel));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('availability mutators flip the available flag surfaced in the listing (Validates: Requirements 2.6, 2.7)', () => {
    fc.assert(
      fc.property(nonEmptyConfigArb, (config) => {
        const registry = new ConfigModelRegistry(config);

        const targetId = config.models[0]!.id;
        const otherIds = config.models.slice(1).map((m) => m.id);

        registry.markUnavailable(targetId);
        expect(registry.get(targetId).available).toBe(false);
        expect(registry.list().find((m) => m.id === targetId)?.available).toBe(false);

        registry.markAvailable(targetId);
        expect(registry.get(targetId).available).toBe(true);
        expect(registry.list().find((m) => m.id === targetId)?.available).toBe(true);

        // Toggling one model never changes the listed set of ids (Req 2.6, 2.7).
        const listedIds = new Set(registry.list().map((m) => m.id));
        for (const id of [targetId, ...otherIds]) {
          expect(listedIds.has(id)).toBe(true);
        }
        expect(listedIds.size).toBe(config.models.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
