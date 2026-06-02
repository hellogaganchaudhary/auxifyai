/**
 * Feature: auxify-ai-platform, Property 14: Request outcome is fully recorded.
 *
 * Validates: Requirements 3.9, 31.1, 44.6
 *
 * _For any_ completed (successful) model request, the {@link ModelRouter}
 * records — exactly once — a {@link RequestOutcome} that fully and correctly
 * captures the model that actually served the request, the end-to-end latency
 * in milliseconds, the input/output token counts the provider reported, and the
 * computed cost (Req 3.9). The same facts feed Analytics usage attribution
 * (Req 31.1) and Budget spend accounting (Req 44.6), so "fully recorded" must
 * hold across arbitrary token usage, arbitrary per-1k model costs, arbitrary
 * latencies, and arbitrary fallback patterns — and *nothing* may be recorded
 * when the whole chain fails.
 *
 * The property is checked over an arbitrary routable permitted model set
 * (arbitrary tiers and arbitrary non-negative per-1k costs), an arbitrary
 * per-model outcome assignment (succeed / provider-error / timeout) with
 * arbitrary non-negative token usage on the succeeding model, an arbitrary
 * routing mode (explicit vs Auto Mode), and an arbitrary injected clock
 * start/end pair (end >= start). Every generated model is granted (Premium
 * authorization, non-viewer, no allow-list) and available, so the full set is
 * routable and the head of the chain is deterministic:
 *   - explicit mode names a permitted model, so it heads the chain (Req 3.1);
 *   - Auto Mode classifies a plain query as `simple` and selects by tier, which
 *     is computed here with the SAME real {@link HybridRoutingLayer} the router
 *     uses, so the selected head is known exactly (Req 3.3-3.5).
 *
 * The model that actually serves is the FIRST success in the real
 * {@link buildFallbackChain} order (imported, not re-implemented), possibly
 * after fallbacks. The expected cost is recomputed by an INDEPENDENT oracle
 * (the per-1k formula re-derived inline — {@link computeCost} is deliberately
 * NOT called in the assertion), and the expected latency is exactly the
 * injected clock's `end - start`.
 *
 * The fakes ({@link FakeProviderCall}, {@link FakeClock},
 * {@link CapturingOutcomeRecorder}, {@link FakeModelCatalog}, {@link makeModel},
 * {@link makePrincipal}) are the same doubles the router's unit suite was tested
 * against, so the property exercises the real production recording logic.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MODEL_TIERS, type ChatRequest, type ModelInfo } from '@auxify/types';

import { ProviderExhaustedError } from './errors.js';
import {
  AUTO_MODEL_ID,
  ModelRouter,
  buildFallbackChain,
  type ModelRouterOptions,
} from './fallback.js';
import {
  CapturingOutcomeRecorder,
  FakeClock,
  FakeModelCatalog,
  FakeProviderCall,
  type FakeProviderBehavior,
  makeModel,
  makePrincipal,
} from './fakes.js';
import { HybridRoutingLayer } from './hybrid-routing-layer.js';
import { ModelPermissionResolver } from './model-permission-resolver.js';
import type { AttemptFailureKind, RouteMode } from './types.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 300;

/** The three per-model behaviors a generated scenario assigns. */
type Outcome = 'ok' | 'error' | 'timeout';

/**
 * A generated per-model spec: its tier and per-1k costs (so the serving model
 * carries arbitrary cost), the outcome its provider call produces, and the
 * token usage it reports when it succeeds.
 */
interface ModelSpec {
  tier: (typeof MODEL_TIERS)[number];
  per1kInputTokens: number;
  per1kOutputTokens: number;
  outcome: Outcome;
  inputTokens: number;
  outputTokens: number;
}

/** A complete generated scenario for one property run. */
interface Scenario {
  specs: ModelSpec[];
  mode: RouteMode;
  /** Index (pre-modulo) of the explicitly-named chain head; used in `explicit` mode. */
  selectedIndex: number;
  /** Injected clock start timestamp. */
  start: number;
  /** Non-negative latency delta; the clock's end timestamp is `start + delta`. */
  delta: number;
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** A non-negative, finite per-1k token cost. */
const costArb = fc.double({ min: 0, max: 100, noNaN: true });

/** A non-negative integer token count. */
const tokenArb = fc.nat({ max: 1_000_000 });

const modelSpecArb: fc.Arbitrary<ModelSpec> = fc.record({
  tier: fc.constantFrom(...MODEL_TIERS),
  per1kInputTokens: costArb,
  per1kOutputTokens: costArb,
  outcome: fc.constantFrom<Outcome>('ok', 'error', 'timeout'),
  inputTokens: tokenArb,
  outputTokens: tokenArb,
});

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  specs: fc.array(modelSpecArb, { minLength: 1, maxLength: 6 }),
  mode: fc.constantFrom<RouteMode>('explicit', 'auto'),
  selectedIndex: fc.nat({ max: 100 }),
  start: fc.nat({ max: 10_000_000 }),
  delta: fc.nat({ max: 10_000_000 }),
});

// ---------------------------------------------------------------------------
// Scenario materialization.
// ---------------------------------------------------------------------------

/** The id assigned to the model generated from spec index `i` (distinct ids). */
function modelId(i: number): string {
  return `m-${i}`;
}

/** The {@link FakeProviderBehavior} a spec maps to for its model attempt. */
function behaviorFor(i: number, spec: ModelSpec): FakeProviderBehavior {
  switch (spec.outcome) {
    case 'ok':
      return { ok: { inputTokens: spec.inputTokens, outputTokens: spec.outputTokens } };
    case 'timeout':
      return { timeout: `timeout-${i}` };
    case 'error':
      return { error: `provider-error-${i}` };
  }
}

/** The failure kind + reason the router must record for a FAILING spec (Req 3.7, 3.8). */
function expectedFailure(i: number, spec: ModelSpec): { kind: AttemptFailureKind; reason: string } {
  return spec.outcome === 'timeout'
    ? { kind: 'timeout', reason: `timeout-${i}` }
    : { kind: 'provider_error', reason: `provider-error-${i}` };
}

/** A plain query that the Hybrid_Routing_Layer classifies as `simple` (no code/vision). */
function plainRequest(modelIdValue: string): ChatRequest {
  return { modelId: modelIdValue, messages: [{ role: 'user', content: 'hello there' }] };
}

// ---------------------------------------------------------------------------
// Property 14.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 14: Request outcome is fully recorded', () => {
  it('records exactly one outcome capturing the served model, latency, tokens, and computed cost on success — and nothing on exhaustion (Validates: Requirements 3.9, 31.1, 44.6)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ specs, mode, selectedIndex, start, delta }) => {
        // --- Materialize distinctly-identified, available, granted models ----
        const models: ModelInfo[] = specs.map((spec, i) =>
          makeModel(spec.tier, {
            id: modelId(i),
            available: true,
            cost: {
              per1kInputTokens: spec.per1kInputTokens,
              per1kOutputTokens: spec.per1kOutputTokens,
            },
          }),
        );
        const specById = new Map<string, { index: number; spec: ModelSpec }>(
          specs.map((spec, i) => [modelId(i), { index: i, spec }]),
        );
        const behaviors: Record<string, FakeProviderBehavior> = {};
        for (let i = 0; i < specs.length; i += 1) {
          behaviors[modelId(i)] = behaviorFor(i, specs[i] as ModelSpec);
        }

        // Premium-authorized, non-viewer, no allow-list → every model permitted;
        // all available → the whole permitted set is routable.
        const principal = makePrincipal({ premiumAuthorized: true });
        const resolver = new ModelPermissionResolver(new FakeModelCatalog(models));
        const routingLayer = new HybridRoutingLayer();
        const routable = resolver.permittedModels(principal).routable;

        // --- The request + the deterministic chain head per mode -------------
        const end = start + delta;
        let req: ChatRequest;
        let head: ModelInfo;
        if (mode === 'explicit') {
          // An explicitly-named permitted model heads the chain (Req 3.1).
          head = routable[selectedIndex % routable.length] as ModelInfo;
          req = plainRequest(head.id);
        } else {
          // Auto Mode: the SAME real routing layer selects the head (Req 3.3-3.5).
          req = plainRequest(AUTO_MODEL_ID);
          head = (await routingLayer.autoSelect(req, routable)).model;
        }

        // The attempt order is the REAL fallback chain (imported), not a copy.
        const chainIds = buildFallbackChain(head, routable, req).map((m) => m.id);
        const firstOkPos = chainIds.findIndex(
          (id) => (specById.get(id)?.spec.outcome ?? 'error') === 'ok',
        );

        // --- Fresh router with an arbitrary, deterministic clock -------------
        const providerCall = new FakeProviderCall(behaviors);
        const recorder = new CapturingOutcomeRecorder();
        const options: ModelRouterOptions = {
          resolver,
          routingLayer,
          providerCall,
          recorder,
          clock: new FakeClock([start, end]),
        };
        const router = new ModelRouter(options);

        if (firstOkPos >= 0) {
          // ===== A model in the chain succeeds → exactly one full outcome =====
          const result = await router.route(req, principal);

          const servingId = chainIds[firstOkPos] as string;
          const serving = specById.get(servingId) as { index: number; spec: ModelSpec };

          // Exactly ONE outcome recorded, and it is the one returned.
          expect(recorder.outcomes).toHaveLength(1);
          const outcome = recorder.last;
          expect(outcome).toBeDefined();
          if (outcome === undefined) {
            return;
          }
          expect(result.outcome).toEqual(outcome);

          // The model that actually served (first success in the chain).
          expect(outcome.modelId).toBe(servingId);

          // The provider-reported usage of the succeeding attempt.
          expect(outcome.inputTokens).toBe(serving.spec.inputTokens);
          expect(outcome.outputTokens).toBe(serving.spec.outputTokens);

          // Cost recomputed by an INDEPENDENT oracle (computeCost NOT called).
          const expectedCost =
            (serving.spec.inputTokens / 1000) * serving.spec.per1kInputTokens +
            (serving.spec.outputTokens / 1000) * serving.spec.per1kOutputTokens;
          expect(outcome.cost).toBeCloseTo(expectedCost, 6);

          // Latency is exactly end - start from the injected clock, and >= 0.
          expect(outcome.latencyMs).toBe(end - start);
          expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);

          // Mode matches how the model was chosen.
          expect(outcome.mode).toBe(mode);

          // Fallback bookkeeping: the failed models, in order, are exactly the
          // failing prefix of the chain; the succeeding model is the head's
          // first success (already asserted above).
          const failingPrefix = chainIds.slice(0, firstOkPos);
          const expectedFailed = failingPrefix.map((id) => {
            const entry = specById.get(id) as { index: number; spec: ModelSpec };
            return { modelId: id, ...expectedFailure(entry.index, entry.spec) };
          });
          expect(outcome.failedAttempts).toEqual(expectedFailed);
          // None of the failed attempts is the model that served.
          expect(outcome.failedAttempts.map((a) => a.modelId)).not.toContain(servingId);
        } else {
          // ===== Every model in the chain fails → NOTHING recorded ============
          let thrown: unknown;
          try {
            await router.route(req, principal);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(ProviderExhaustedError);
          // Zero outcomes recorded on whole-chain failure.
          expect(recorder.outcomes).toHaveLength(0);
        }
      }),
      {
        numRuns: NUM_RUNS,
        // Guarantee the documented edge cases are always exercised, regardless
        // of random sampling: an all-fail chain (zero outcomes), an immediate
        // success, and a fallback-then-success (the served model is not the head).
        examples: [
          [
            {
              specs: [
                {
                  tier: 'economy',
                  per1kInputTokens: 2,
                  per1kOutputTokens: 4,
                  outcome: 'error',
                  inputTokens: 100,
                  outputTokens: 50,
                },
              ],
              mode: 'explicit',
              selectedIndex: 0,
              start: 5,
              delta: 10,
            },
          ],
          [
            {
              specs: [
                {
                  tier: 'standard',
                  per1kInputTokens: 3,
                  per1kOutputTokens: 6,
                  outcome: 'ok',
                  inputTokens: 1000,
                  outputTokens: 500,
                },
              ],
              mode: 'explicit',
              selectedIndex: 0,
              start: 1000,
              delta: 350,
            },
          ],
          [
            {
              specs: [
                {
                  tier: 'economy',
                  per1kInputTokens: 1,
                  per1kOutputTokens: 1,
                  outcome: 'error',
                  inputTokens: 0,
                  outputTokens: 0,
                },
                {
                  tier: 'standard',
                  per1kInputTokens: 1,
                  per1kOutputTokens: 1,
                  outcome: 'ok',
                  inputTokens: 2000,
                  outputTokens: 0,
                },
              ],
              mode: 'explicit',
              selectedIndex: 0,
              start: 0,
              delta: 100,
            },
          ],
        ],
      },
    );
  });
});
