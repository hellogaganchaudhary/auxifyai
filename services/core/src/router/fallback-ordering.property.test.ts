/**
 * Feature: auxify-ai-platform, Property 13: Fallback chain is tried in order
 * and exhaustion reports every attempt.
 *
 * Validates: Requirements 3.7, 3.8
 *
 * _For any_ configured Fallback Chain and _any_ pattern of provider
 * errors/timeouts, the {@link ModelRouter} attempts models strictly in
 * {@link buildFallbackChain} order, stopping at the FIRST success; and when
 * every model fails it raises a {@link ProviderExhaustedError} that lists each
 * attempted model together with its individual failure reason, in attempt
 * order. This pins down the two halves of Req 3.7 (retry the NEXT model on a
 * provider error or timeout, stop at the first success) and Req 3.8 (the
 * exhaustion error enumerates every attempt).
 *
 * The property is checked over an arbitrary routable permitted model set
 * (arbitrary tiers) and an arbitrary assignment of per-model outcomes
 * (fail-with-error / fail-with-timeout / succeed). An explicit request names a
 * permitted model so the selected model — and therefore the head of the chain —
 * is deterministic; the principal is granted Premium authorization with no
 * allow-list and a non-viewer role so EVERY generated model is permitted, and
 * every model is available so the full set is routable. The expected chain
 * order is computed with the REAL {@link buildFallbackChain} (imported here, not
 * re-implemented), and the observed provider calls are asserted to be exactly
 * its success-prefix.
 *
 * The fakes ({@link FakeProviderCall}, {@link FakeClock},
 * {@link CapturingOutcomeRecorder}, {@link FakeModelCatalog}, {@link makeModel},
 * {@link makePrincipal}) are the same doubles the router's unit suite was tested
 * against, so the property exercises the real production routing logic.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MODEL_TIERS, type ChatRequest, type ModelInfo } from '@auxify/types';

import { ProviderExhaustedError } from './errors.js';
import { ModelRouter, buildFallbackChain, type ModelRouterOptions } from './fallback.js';
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
import type { FallbackAttempt } from './types.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 300;

/** The three per-model behaviors a generated scenario assigns. */
type Outcome = 'error' | 'timeout' | 'ok';

// ---------------------------------------------------------------------------
// Per-model behavior / expected-attempt derivation (kept deterministic so the
// recorded reason can be asserted exactly).
// ---------------------------------------------------------------------------

/** The {@link FakeProviderBehavior} for a model id given its generated outcome. */
function behaviorFor(id: string, outcome: Outcome): FakeProviderBehavior {
  switch (outcome) {
    case 'ok':
      return { ok: { inputTokens: 1, outputTokens: 1 } };
    case 'timeout':
      return { timeout: `timeout-${id}` };
    case 'error':
      return { error: `provider-error-${id}` };
  }
}

/**
 * The {@link FallbackAttempt} the router must record for a FAILING model: a
 * timeout maps to kind `timeout`, any other error to `provider_error`, and the
 * reason is the exact thrown message (Req 3.7, 3.8).
 */
function expectedAttemptFor(id: string, outcome: Exclude<Outcome, 'ok'>): FallbackAttempt {
  return outcome === 'timeout'
    ? { modelId: id, kind: 'timeout', reason: `timeout-${id}` }
    : { modelId: id, kind: 'provider_error', reason: `provider-error-${id}` };
}

/** Build an explicit text request naming `modelId` (no image input). */
function explicitRequest(modelId: string): ChatRequest {
  return { modelId, messages: [{ role: 'user', content: 'hello there' }] };
}

interface Harness {
  router: ModelRouter;
  providerCall: FakeProviderCall;
  recorder: CapturingOutcomeRecorder;
  routable: ModelInfo[];
}

/** Assemble a router over the given catalog + behaviors with fresh fakes. */
function makeHarness(
  models: ModelInfo[],
  behaviors: Record<string, FakeProviderBehavior>,
  principal: ReturnType<typeof makePrincipal>,
): Harness {
  const resolver = new ModelPermissionResolver(new FakeModelCatalog(models));
  const routingLayer = new HybridRoutingLayer();
  const providerCall = new FakeProviderCall(behaviors);
  const recorder = new CapturingOutcomeRecorder();
  const options: ModelRouterOptions = {
    resolver,
    routingLayer,
    providerCall,
    recorder,
    clock: new FakeClock([0, 1]),
  };
  return {
    router: new ModelRouter(options),
    providerCall,
    recorder,
    routable: resolver.permittedModels(principal).routable,
  };
}

// ---------------------------------------------------------------------------
// Generator: an arbitrary routable model set + per-model outcome assignment +
// the index of the explicitly-selected (chain head) model.
// ---------------------------------------------------------------------------

const scenarioArb = fc
  .array(
    fc.record({
      tier: fc.constantFrom(...MODEL_TIERS),
      outcome: fc.constantFrom<Outcome>('error', 'timeout', 'ok'),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .chain((specs) =>
    fc.record({
      specs: fc.constant(specs),
      // The explicitly-named model that heads the chain (Req 3.1 selection).
      selectedIndex: fc.nat({ max: specs.length - 1 }),
    }),
  );

// ---------------------------------------------------------------------------
// Property 13.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 13: Fallback chain is tried in order and exhaustion reports every attempt', () => {
  it('tries the chain in order, stops at the first success, and on exhaustion reports every attempt in order (Validates: Requirements 3.7, 3.8)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ specs, selectedIndex }) => {
        // Distinctly-identified, available models spanning arbitrary tiers, so
        // the whole permitted set is routable.
        const models: ModelInfo[] = specs.map((spec, index) =>
          makeModel(spec.tier, { id: `m-${index}`, available: true }),
        );
        const outcomeById = new Map<string, Outcome>(
          specs.map((spec, index) => [`m-${index}`, spec.outcome]),
        );
        const behaviors: Record<string, FakeProviderBehavior> = {};
        for (const model of models) {
          behaviors[model.id] = behaviorFor(model.id, outcomeById.get(model.id) as Outcome);
        }

        // Premium-authorized, non-viewer, no allow-list → every model permitted.
        const principal = makePrincipal({ premiumAuthorized: true });
        const { router, providerCall, recorder, routable } = makeHarness(
          models,
          behaviors,
          principal,
        );

        const selectedId = `m-${selectedIndex}`;
        const req = explicitRequest(selectedId);
        const selected = routable.find((m) => m.id === selectedId) as ModelInfo;

        // The expected attempt order is the REAL fallback chain (imported), not
        // a re-implementation — selected first, then nearest-tier order.
        const expectedChainIds = buildFallbackChain(selected, routable, req).map((m) => m.id);
        const firstOkPos = expectedChainIds.findIndex((id) => outcomeById.get(id) === 'ok');

        if (firstOkPos >= 0) {
          // --- Some model in the chain succeeds (Req 3.7) ------------------
          const result = await router.route(req, principal);

          // Tried strictly the chain prefix up to and including the first
          // success; NO later model was tried.
          const expectedCalls = expectedChainIds.slice(0, firstOkPos + 1);
          expect(providerCall.calls).toEqual(expectedCalls);

          // The first succeeding model served the request and was recorded once.
          const winnerId = expectedChainIds[firstOkPos] as string;
          expect(result.outcome.modelId).toBe(winnerId);
          expect(recorder.outcomes).toHaveLength(1);
          expect(recorder.last?.modelId).toBe(winnerId);

          // The failed attempts before the success are exactly the failing
          // prefix, in order, each with the correct kind and reason.
          const expectedFailed = expectedChainIds
            .slice(0, firstOkPos)
            .map((id) => expectedAttemptFor(id, outcomeById.get(id) as Exclude<Outcome, 'ok'>));
          expect(result.outcome.failedAttempts).toEqual(expectedFailed);

          // One-to-one, in-order correspondence between recorded failed
          // attempts and the failing provider calls.
          expect(result.outcome.failedAttempts.map((a) => a.modelId)).toEqual(
            providerCall.calls.slice(0, firstOkPos),
          );
        } else {
          // --- Every model in the chain fails → exhaustion (Req 3.8) ------
          let thrown: unknown;
          try {
            await router.route(req, principal);
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeInstanceOf(ProviderExhaustedError);
          const exhausted = thrown as ProviderExhaustedError;

          // The whole chain was tried, in order.
          expect(providerCall.calls).toEqual(expectedChainIds);

          // The error enumerates EVERY attempted model, in attempt order, each
          // with the correct kind (provider_error vs timeout) and reason.
          const expectedAttempts = expectedChainIds.map((id) =>
            expectedAttemptFor(id, outcomeById.get(id) as Exclude<Outcome, 'ok'>),
          );
          expect(exhausted.attempts).toEqual(expectedAttempts);

          // The attempts correspond one-to-one and in-order with the calls.
          expect(exhausted.attempts.map((a) => a.modelId)).toEqual(providerCall.calls);

          // Nothing is recorded when the chain is exhausted.
          expect(recorder.outcomes).toHaveLength(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
