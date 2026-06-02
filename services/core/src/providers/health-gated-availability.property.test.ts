/**
 * Property-based test for **Property 10: Provider health gates model
 * availability** (Req 2.10), the health-gating behavior of the
 * Provider_Abstraction_Layer (Req 2), implemented by {@link ProviderHealthChecker}
 * (task 5.4).
 *
 * Validates: Requirements 2.10
 *
 * Requirement 2.10: _IF a configured provider fails a health check, THEN the
 * Provider_Abstraction_Layer SHALL mark the affected models as unavailable until
 * a subsequent health check succeeds._
 *
 * Property statement (design.md): _for any_ provider with associated models and
 * _any_ sequence of health-check results, each model is marked unavailable after
 * a failing check for its provider and becomes available again only after a
 * subsequent succeeding check, so availability always reflects the most recent
 * health outcome.
 *
 * The test drives an arbitrary multi-provider catalog through an arbitrary
 * sequence of per-provider health outcomes (`healthy` / `unhealthy` / `throws`)
 * across successive {@link ProviderHealthChecker.checkAll} rounds and, after each
 * round, compares every model's `available` flag against an independent oracle —
 * the most recent outcome of its serving provider:
 *
 *   - a model's provider reported healthy most recently  → `available === true`
 *   - a model's provider failed (unhealthy or threw) most recently → `false`
 *   - a model whose provider is never checked retains its initial availability
 *     (some providers in the catalog are intentionally left unregistered with
 *     the checker, exercising the "not checked yet" branch of Req 2.10).
 *
 * A second property exercises the recovery direction explicitly (the
 * "until a subsequent health check succeeds" clause): every model first driven
 * unavailable by a failing/throwing check becomes available again once its
 * provider reports healthy in a later round.
 *
 * The checker and registry are exercised through their real public surface — no
 * mocks of the production logic, no real timers ({@link
 * ProviderHealthChecker.checkAll} is invoked directly) — so the assertions test
 * the production gating path end to end.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MODEL_MODALITIES, MODEL_TIERS, type HealthStatus } from '@auxify/types';

import {
  ConfigModelRegistry,
  ProviderHealthChecker,
  type AIProvider,
  type ModelConfig,
  type ProviderConfig,
  type RegistryConfig,
} from './index.js';

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

/** The three health outcomes a provider's `healthCheck()` can produce in a round. */
type Outcome = 'healthy' | 'unhealthy' | 'throws';

/** A failing-only outcome (used by the recovery property's failing round). */
type FailingOutcome = Extract<Outcome, 'unhealthy' | 'throws'>;

// ---------------------------------------------------------------------------
// Test double — a togglable provider whose health mode can change between rounds.
// Only `providerId` and `healthCheck()` matter to the checker; the remaining
// AIProvider members throw so an accidental call surfaces loudly.
// ---------------------------------------------------------------------------

/**
 * A minimal {@link AIProvider} whose health can be toggled between healthy,
 * unhealthy, and throwing, mirroring the `FakeProvider` pattern in
 * `health-checker.test.ts` (this file deliberately defines its own to avoid
 * cross-test coupling).
 */
class ToggleProvider implements AIProvider {
  private mode: Outcome;

  constructor(
    readonly providerId: string,
    mode: Outcome = 'healthy',
  ) {
    this.mode = mode;
  }

  /** Set the provider's health mode for the next round. */
  setMode(mode: Outcome): void {
    this.mode = mode;
  }

  async healthCheck(): Promise<HealthStatus> {
    if (this.mode === 'throws') {
      throw new Error(`${this.providerId} health probe exploded`);
    }
    return {
      providerId: this.providerId,
      healthy: this.mode === 'healthy',
      checkedAt: '2025-01-01T00:00:00.000Z',
      ...(this.mode === 'unhealthy' ? { detail: `${this.providerId} is down` } : {}),
    };
  }

  // Unused by the health checker; present to satisfy the AIProvider contract.
  chat(): AsyncIterable<never> {
    throw new Error('not implemented');
  }
  embed(): never {
    throw new Error('not implemented');
  }
  generateImage(): never {
    throw new Error('not implemented');
  }
  realtime(): never {
    throw new Error('not implemented');
  }
  listModels(): never {
    throw new Error('not implemented');
  }
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** Non-empty hex identifier for provider and model ids. */
const idArb: fc.Arbitrary<string> = fc.hexaString({ minLength: 1, maxLength: 8 });

/** A non-negative, finite per-1k token cost. */
const costArb: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** A single health outcome for a provider in a round. */
const outcomeArb: fc.Arbitrary<Outcome> = fc.constantFrom('healthy', 'unhealthy', 'throws');

/**
 * A well-formed {@link ModelConfig} whose `provider` is drawn from `providerIds`
 * and whose initial `available` is randomized (including the default-true path)
 * so the "retains its initial availability" branch is meaningfully tested.
 */
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
    cost: fc.record({ per1kInputTokens: costArb, per1kOutputTokens: costArb }),
    available: fc.option(fc.boolean(), { nil: undefined }),
  });
}

/**
 * A multi-provider scenario: a set of provider ids, a per-provider flag for
 * whether that provider is registered with the checker (at least one is), an
 * arbitrary catalog of models over those providers, and a sequence of rounds
 * where each round assigns an {@link Outcome} to every provider id.
 */
interface Scenario {
  providerIds: string[];
  /** Parallel to `providerIds`: whether each provider is polled by the checker. */
  registered: boolean[];
  models: ModelConfig[];
  /** Each round: one {@link Outcome} per provider id (parallel to `providerIds`). */
  rounds: Outcome[][];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .uniqueArray(idArb, { minLength: 1, maxLength: 4 })
  .chain((providerIds) =>
    fc
      .record({
        registered: fc.array(fc.boolean(), {
          minLength: providerIds.length,
          maxLength: providerIds.length,
        }),
        models: fc.uniqueArray(modelConfigArb(providerIds), {
          selector: (m) => m.id,
          minLength: 1,
          maxLength: 12,
        }),
        rounds: fc.array(
          fc.array(outcomeArb, {
            minLength: providerIds.length,
            maxLength: providerIds.length,
          }),
          { minLength: 1, maxLength: 6 },
        ),
      })
      .map(({ registered, models, rounds }) => {
        // Guarantee at least one registered provider so checkAll() does work.
        const flags = [...registered];
        if (!flags.some(Boolean)) {
          flags[0] = true;
        }
        return { providerIds, registered: flags, models, rounds } satisfies Scenario;
      }),
  );

/**
 * A recovery scenario: a catalog over fully-registered providers plus a
 * failing mode per provider for the initial failing round. The recovery round
 * always reports healthy.
 */
interface RecoveryScenario {
  providerIds: string[];
  models: ModelConfig[];
  /** Parallel to `providerIds`: how each provider fails in the first round. */
  failingModes: FailingOutcome[];
}

const recoveryArb: fc.Arbitrary<RecoveryScenario> = fc
  .uniqueArray(idArb, { minLength: 1, maxLength: 4 })
  .chain((providerIds) =>
    fc
      .record({
        models: fc.uniqueArray(modelConfigArb(providerIds), {
          selector: (m) => m.id,
          minLength: 1,
          maxLength: 12,
        }),
        failingModes: fc.array(fc.constantFrom<FailingOutcome>('unhealthy', 'throws'), {
          minLength: providerIds.length,
          maxLength: providerIds.length,
        }),
      })
      .map(({ models, failingModes }) => ({ providerIds, models, failingModes })),
  );

/** Build a {@link RegistryConfig} declaring `providerIds` and carrying `models`. */
function configOf(providerIds: readonly string[], models: ModelConfig[]): RegistryConfig {
  const providers: ProviderConfig[] = providerIds.map((id) => ({ id }));
  return { providers, models };
}

// ---------------------------------------------------------------------------
// Property 10.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 10: Provider health gates model availability', () => {
  it('after each round, every model availability equals the most recent health outcome of its serving provider; an unchecked provider retains its initial availability (Validates: Requirements 2.10)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ providerIds, registered, models, rounds }) => {
        const registry = new ConfigModelRegistry(configOf(providerIds, models));

        // Only the registered providers are polled; the rest are "ghosts"
        // present in the catalog but never checked.
        const providers = providerIds
          .filter((_, i) => registered[i])
          .map((id) => new ToggleProvider(id));
        const providerById = new Map(providers.map((p) => [p.providerId, p]));
        const checker = new ProviderHealthChecker(providers, registry);

        // Independent oracle: the most recent outcome observed per provider id.
        // A provider absent from this map has not been checked yet.
        const lastOutcome = new Map<string, Outcome>();

        /** Expected availability for `model` given the oracle's current state. */
        const expectedAvailable = (model: ModelConfig): boolean => {
          const outcome = lastOutcome.get(model.provider);
          return outcome === undefined ? (model.available ?? true) : outcome === 'healthy';
        };

        // Before any round, every model retains its initial availability.
        for (const model of models) {
          expect(registry.get(model.id).available).toBe(expectedAvailable(model));
        }

        for (const round of rounds) {
          // Apply this round's outcomes to the registered providers only, and
          // record them in the oracle.
          providerIds.forEach((providerId, i) => {
            if (!registered[i]) {
              return;
            }
            const outcome = round[i]!;
            providerById.get(providerId)!.setMode(outcome);
            lastOutcome.set(providerId, outcome);
          });

          await checker.checkAll();

          // After the round, every model reflects the latest outcome of its
          // serving provider; ghost-served models keep their initial state.
          for (const model of models) {
            expect(registry.get(model.id).available).toBe(expectedAvailable(model));
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a model unavailable due to a failed (unhealthy or throwing) check becomes available again after a later succeeding check (Validates: Requirements 2.10)', async () => {
    await fc.assert(
      fc.asyncProperty(recoveryArb, async ({ providerIds, models, failingModes }) => {
        const registry = new ConfigModelRegistry(configOf(providerIds, models));
        const providers = providerIds.map((id) => new ToggleProvider(id));
        const providerById = new Map(providers.map((p) => [p.providerId, p]));
        const checker = new ProviderHealthChecker(providers, registry);

        // Round 1: every provider fails (unhealthy or throwing) → every model
        // it serves is gated unavailable, regardless of its initial state.
        providerIds.forEach((providerId, i) => {
          providerById.get(providerId)!.setMode(failingModes[i]!);
        });
        await checker.checkAll();
        for (const model of models) {
          expect(registry.get(model.id).available).toBe(false);
        }

        // Round 2: every provider recovers → every model becomes available
        // again ("until a subsequent health check succeeds", Req 2.10).
        for (const provider of providers) {
          provider.setMode('healthy');
        }
        await checker.checkAll();
        for (const model of models) {
          expect(registry.get(model.id).available).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
