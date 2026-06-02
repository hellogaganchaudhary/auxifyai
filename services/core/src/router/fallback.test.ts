/**
 * Unit tests for the Fallback Chain and outcome recording (Req 3.7, 3.8, 3.9).
 *
 * These exercise {@link ModelRouter} and the pure helpers
 * {@link buildFallbackChain} / {@link computeCost} against deterministic fakes
 * ({@link FakeProviderCall}, {@link FakeClock}, {@link CapturingOutcomeRecorder},
 * {@link FakeModelCatalog}, {@link makeModel}, {@link makePrincipal}), covering:
 *   - the chain starting at the selected model, then same-tier/nearest-tier,
 *     restricted to routable (and vision-capable for image input) models,
 *   - retry to the NEXT model on a provider error or a timeout (Req 3.7),
 *     stopping at the first success,
 *   - the exhaustion error enumerating EACH attempted model and its reason in
 *     attempt order, and its `provider_exhausted` projection (Req 3.8),
 *   - outcome recording of selected model, latency, token counts, and computed
 *     cost on success (Req 3.9),
 *   - the unified route dispatching explicit (Req 3.1/3.2) vs Auto Mode
 *     (Req 3.3-3.6) selection.
 */

import type { ChatMessage, ChatRequest, ModelInfo } from '@auxify/types';
import { describe, expect, it } from 'vitest';

import { ModelNotFoundError } from '../providers/index.js';

import {
  ModelNotAuthorizedError,
  NoEligibleModelError,
  ProviderExhaustedError,
} from './errors.js';
import {
  AUTO_MODEL_ID,
  ModelRouter,
  buildFallbackChain,
  computeCost,
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

// ---------------------------------------------------------------------------
// Request builders.
// ---------------------------------------------------------------------------

/** Build an Auto Mode text request (modelId === 'auto'). */
function autoRequest(text = 'hello there'): ChatRequest {
  const messages: ChatMessage[] = [{ role: 'user', content: text }];
  return { modelId: AUTO_MODEL_ID, messages };
}

/** Build an explicit request naming `modelId`. */
function explicitRequest(modelId: string, text = 'hello there'): ChatRequest {
  return { modelId, messages: [{ role: 'user', content: text }] };
}

/** Build an Auto Mode request carrying image input (forces vision, Req 3.6). */
function imageRequest(text = 'what is this?'): ChatRequest {
  return {
    modelId: AUTO_MODEL_ID,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image', image: { mimeType: 'image/png', base64: 'AAAA' } },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Router builder.
// ---------------------------------------------------------------------------

interface RouterHarness {
  router: ModelRouter;
  providerCall: FakeProviderCall;
  recorder: CapturingOutcomeRecorder;
  clock: FakeClock;
}

/**
 * Assemble a {@link ModelRouter} over the given catalog and provider behaviors,
 * returning the router and its observable fakes.
 */
function makeRouter(
  models: ModelInfo[],
  behaviors: Record<string, FakeProviderBehavior>,
  options: { times?: number[]; maxAttempts?: number } = {},
): RouterHarness {
  const resolver = new ModelPermissionResolver(new FakeModelCatalog(models));
  const routingLayer = new HybridRoutingLayer();
  const providerCall = new FakeProviderCall(behaviors);
  const recorder = new CapturingOutcomeRecorder();
  const clock = new FakeClock(options.times ?? [1000, 1000]);
  const routerOptions: ModelRouterOptions = {
    resolver,
    routingLayer,
    providerCall,
    recorder,
    clock,
  };
  if (options.maxAttempts !== undefined) {
    routerOptions.maxAttempts = options.maxAttempts;
  }
  return { router: new ModelRouter(routerOptions), providerCall, recorder, clock };
}

// ---------------------------------------------------------------------------
// computeCost (Req 3.9).
// ---------------------------------------------------------------------------

describe('computeCost (Req 3.9)', () => {
  it('computes cost from per-1k token costs', () => {
    const model = makeModel('standard', {
      cost: { per1kInputTokens: 2, per1kOutputTokens: 6 },
    });
    // 1500/1000*2 + 500/1000*6 = 3 + 3 = 6
    expect(computeCost(model, { inputTokens: 1500, outputTokens: 500 })).toBeCloseTo(6, 10);
  });

  it('is zero for zero usage', () => {
    const model = makeModel('economy');
    expect(computeCost(model, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildFallbackChain ordering (Req 3.7).
// ---------------------------------------------------------------------------

describe('buildFallbackChain (Req 3.7)', () => {
  it('starts at the selected model, then orders by nearest tier', () => {
    const economy = makeModel('economy', { id: 'e' });
    const standard = makeModel('standard', { id: 's' });
    const premium = makeModel('premium', { id: 'p' });
    const routable = [economy, standard, premium];

    // Selected = standard → standard first, then nearest tiers (economy &
    // premium are both distance 1; tie broken toward the lower tier → economy).
    const chain = buildFallbackChain(standard, routable, autoRequest());
    expect(chain.map((m) => m.id)).toEqual(['s', 'e', 'p']);
  });

  it('places same-tier fallbacks before nearer different-tier ones', () => {
    const selected = makeModel('premium', { id: 'p1' });
    const otherPremium = makeModel('premium', { id: 'p2' });
    const standard = makeModel('standard', { id: 's' });
    const chain = buildFallbackChain(selected, [otherPremium, standard], autoRequest());
    // p1 first, then same-tier p2 (distance 0), then standard (distance 1).
    expect(chain.map((m) => m.id)).toEqual(['p1', 'p2', 's']);
  });

  it('always includes the selected model first even when not in routable', () => {
    const selected = makeModel('premium', { id: 'explicit-prem' });
    const routable = [makeModel('economy', { id: 'e' })];
    const chain = buildFallbackChain(selected, routable, autoRequest());
    expect(chain.map((m) => m.id)).toEqual(['explicit-prem', 'e']);
  });

  it('restricts fallbacks to vision-capable models for image input (Req 3.6)', () => {
    const visionSelected = makeModel('premium', { id: 'v1', supportsVision: true });
    const visionOther = makeModel('standard', { id: 'v2', supportsVision: true });
    const textOnly = makeModel('economy', { id: 'text' });
    const chain = buildFallbackChain(
      visionSelected,
      [visionOther, textOnly],
      imageRequest(),
    );
    // The non-vision model must never appear in a vision chain.
    expect(chain.map((m) => m.id)).toEqual(['v1', 'v2']);
  });

  it('de-duplicates by model id', () => {
    const selected = makeModel('standard', { id: 's' });
    const chain = buildFallbackChain(selected, [selected, makeModel('economy', { id: 'e' })], autoRequest());
    expect(chain.map((m) => m.id)).toEqual(['s', 'e']);
  });
});

// ---------------------------------------------------------------------------
// Retry on provider error / timeout (Req 3.7).
// ---------------------------------------------------------------------------

describe('ModelRouter.route — fallback on failure (Req 3.7)', () => {
  it('retries the next model on a provider error and succeeds', async () => {
    const models = [
      makeModel('economy', { id: 'a' }),
      makeModel('standard', { id: 'b' }),
    ];
    const { router, providerCall, recorder } = makeRouter(models, {
      a: { error: 'boom' },
      b: { ok: { inputTokens: 10, outputTokens: 20 } },
    });

    const result = await router.route(explicitRequest('a'), makePrincipal());

    // Tried a (failed) then b (succeeded), in order.
    expect(providerCall.calls).toEqual(['a', 'b']);
    expect(result.outcome.modelId).toBe('b');
    expect(result.outcome.failedAttempts).toEqual([
      { modelId: 'a', kind: 'provider_error', reason: 'boom' },
    ]);
    expect(recorder.last?.modelId).toBe('b');
  });

  it('retries the next model on a timeout and succeeds', async () => {
    const models = [
      makeModel('economy', { id: 'a' }),
      makeModel('standard', { id: 'b' }),
    ];
    const { router, providerCall, recorder } = makeRouter(models, {
      a: { timeout: 'deadline exceeded' },
      b: { ok: { inputTokens: 1, outputTokens: 1 } },
    });

    const result = await router.route(explicitRequest('a'), makePrincipal());

    expect(providerCall.calls).toEqual(['a', 'b']);
    expect(result.outcome.failedAttempts[0]).toEqual({
      modelId: 'a',
      kind: 'timeout',
      reason: 'deadline exceeded',
    });
    expect(recorder.outcomes).toHaveLength(1);
  });

  it('stops at the first success and does not try later models', async () => {
    const models = [
      makeModel('economy', { id: 'a' }),
      makeModel('standard', { id: 'b' }),
      makeModel('premium', { id: 'c' }),
    ];
    const { router, providerCall } = makeRouter(models, {
      a: { ok: { inputTokens: 5, outputTokens: 5 } },
      b: { ok: { inputTokens: 5, outputTokens: 5 } },
      c: { ok: { inputTokens: 5, outputTokens: 5 } },
    });

    await router.route(explicitRequest('a'), makePrincipal());
    expect(providerCall.calls).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// Exhaustion error (Req 3.8).
// ---------------------------------------------------------------------------

describe('ModelRouter.route — exhaustion (Req 3.8)', () => {
  it('throws ProviderExhaustedError listing every attempted model and reason', async () => {
    const models = [
      makeModel('economy', { id: 'a' }),
      makeModel('standard', { id: 'b' }),
      makeModel('premium', { id: 'c' }),
    ];
    const { router, providerCall, recorder } = makeRouter(models, {
      a: { error: 'a failed' },
      b: { timeout: 'b timed out' },
      c: { error: 'c failed' },
    });

    let thrown: unknown;
    try {
      await router.route(explicitRequest('a'), makePrincipal({ premiumAuthorized: true }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderExhaustedError);
    const e = thrown as ProviderExhaustedError;
    // Every attempted model is named in order, each with its reason (Req 3.8).
    expect(e.attempts).toEqual([
      { modelId: 'a', kind: 'provider_error', reason: 'a failed' },
      { modelId: 'b', kind: 'timeout', reason: 'b timed out' },
      { modelId: 'c', kind: 'provider_error', reason: 'c failed' },
    ]);
    expect(e.message).toContain('a');
    expect(e.message).toContain('b');
    expect(e.message).toContain('c');
    // Every chain model was tried; nothing was recorded.
    expect(providerCall.calls).toEqual(['a', 'b', 'c']);
    expect(recorder.outcomes).toHaveLength(0);
  });

  it('projects to a provider_exhausted PlatformError carrying the attempts (Req 3.8, 46.8)', () => {
    const error = new ProviderExhaustedError([
      { modelId: 'a', kind: 'provider_error', reason: 'boom' },
      { modelId: 'b', kind: 'timeout', reason: 'slow' },
    ]);
    const platformError = error.toPlatformError('corr-1');
    expect(platformError.category).toBe('provider_exhausted');
    expect(platformError.code).toBe('PROVIDER_EXHAUSTED');
    expect(platformError.correlationId).toBe('corr-1');
    expect(platformError.details).toEqual({
      attempts: [
        { modelId: 'a', kind: 'provider_error', reason: 'boom' },
        { modelId: 'b', kind: 'timeout', reason: 'slow' },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Outcome recording (Req 3.9).
// ---------------------------------------------------------------------------

describe('ModelRouter.route — outcome recording (Req 3.9)', () => {
  it('records selected model, latency, token counts, and computed cost', async () => {
    const models = [
      makeModel('standard', {
        id: 'm',
        cost: { per1kInputTokens: 2, per1kOutputTokens: 4 },
      }),
    ];
    // Clock: start at 1000, success read at 1350 → latency 350ms.
    const { router, recorder } = makeRouter(
      models,
      { m: { ok: { inputTokens: 1000, outputTokens: 500 } } },
      { times: [1000, 1350] },
    );

    const result = await router.route(explicitRequest('m'), makePrincipal());

    const outcome = recorder.last;
    expect(outcome).toBeDefined();
    expect(outcome?.modelId).toBe('m');
    expect(outcome?.mode).toBe('explicit');
    expect(outcome?.latencyMs).toBe(350);
    expect(outcome?.inputTokens).toBe(1000);
    expect(outcome?.outputTokens).toBe(500);
    // 1000/1000*2 + 500/1000*4 = 2 + 2 = 4
    expect(outcome?.cost).toBeCloseTo(4, 10);
    // The returned result mirrors the recorded outcome and surfaces usage.
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect(result.finishReason).toBe('stop');
    expect(result.outcome).toEqual(outcome);
  });

  it('records the succeeding model after fallback, including the failed attempts', async () => {
    const models = [
      makeModel('economy', { id: 'a' }),
      makeModel('standard', {
        id: 'b',
        cost: { per1kInputTokens: 1, per1kOutputTokens: 1 },
      }),
    ];
    const { router, recorder } = makeRouter(
      models,
      {
        a: { error: 'nope' },
        b: { ok: { inputTokens: 2000, outputTokens: 0 } },
      },
      { times: [0, 100] },
    );

    await router.route(explicitRequest('a'), makePrincipal());

    const outcome = recorder.last;
    expect(outcome?.modelId).toBe('b');
    expect(outcome?.cost).toBeCloseTo(2, 10);
    expect(outcome?.latencyMs).toBe(100);
    expect(outcome?.failedAttempts).toEqual([
      { modelId: 'a', kind: 'provider_error', reason: 'nope' },
    ]);
  });

  it('recordOutcome forwards directly to the recorder', async () => {
    const { router, recorder } = makeRouter([makeModel('economy', { id: 'a' })], {
      a: { ok: { inputTokens: 1, outputTokens: 1 } },
    });
    await router.recordOutcome({
      modelId: 'x',
      mode: 'auto',
      latencyMs: 12,
      inputTokens: 3,
      outputTokens: 4,
      cost: 0.5,
      failedAttempts: [],
    });
    expect(recorder.last?.modelId).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// Unified explicit vs Auto Mode routing (Req 3.1-3.6).
// ---------------------------------------------------------------------------

describe('ModelRouter.route — unified explicit vs auto (Req 3.1-3.6)', () => {
  it('routes an explicitly named permitted model (Req 3.1)', async () => {
    const models = [
      makeModel('economy', { id: 'a' }),
      makeModel('standard', { id: 'b' }),
    ];
    const { router, providerCall } = makeRouter(models, {
      b: { ok: { inputTokens: 1, outputTokens: 1 } },
    });
    const result = await router.route(explicitRequest('b'), makePrincipal());
    expect(result.decision.mode).toBe('explicit');
    expect(result.decision.model.id).toBe('b');
    expect(providerCall.calls[0]).toBe('b');
  });

  it('rejects an explicitly named non-permitted model (Req 3.2)', async () => {
    // Premium model + non-premium-authorized principal → not permitted.
    const models = [makeModel('premium', { id: 'prem' })];
    const { router } = makeRouter(models, {});
    await expect(
      router.route(explicitRequest('prem'), makePrincipal({ premiumAuthorized: false })),
    ).rejects.toBeInstanceOf(ModelNotAuthorizedError);
  });

  it('propagates ModelNotFoundError for an unknown explicit model id', async () => {
    const { router } = makeRouter([makeModel('economy', { id: 'a' })], {});
    await expect(
      router.route(explicitRequest('ghost'), makePrincipal()),
    ).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it('selects via Auto Mode when the request asks for "auto" (Req 3.3-3.4)', async () => {
    const models = [
      makeModel('economy', { id: 'eco' }),
      makeModel('standard', { id: 'std' }),
      makeModel('premium', { id: 'prem' }),
    ];
    // A plain query classifies as simple → economy tier selected.
    const { router } = makeRouter(models, {
      eco: { ok: { inputTokens: 1, outputTokens: 1 } },
      std: { ok: { inputTokens: 1, outputTokens: 1 } },
      prem: { ok: { inputTokens: 1, outputTokens: 1 } },
    });
    const principal = makePrincipal({ premiumAuthorized: true });
    const result = await router.route(autoRequest('what time is it?'), principal);
    expect(result.decision.mode).toBe('auto');
    expect(result.decision.model.tier).toBe('economy');
  });

  it('surfaces NoEligibleModelError for Auto Mode with no routable model (Req 3.5)', async () => {
    // The only model is unavailable → routable set is empty.
    const models = [makeModel('economy', { id: 'a', available: false })];
    const { router } = makeRouter(models, {});
    await expect(router.route(autoRequest(), makePrincipal())).rejects.toBeInstanceOf(
      NoEligibleModelError,
    );
  });

  it('honors a maxAttempts cap, exhausting after that many tries', async () => {
    const models = [
      makeModel('economy', { id: 'a' }),
      makeModel('standard', { id: 'b' }),
      makeModel('premium', { id: 'c' }),
    ];
    const { router, providerCall } = makeRouter(
      models,
      {
        a: { error: 'x' },
        b: { error: 'y' },
        c: { ok: { inputTokens: 1, outputTokens: 1 } },
      },
      { maxAttempts: 2 },
    );
    let thrown: unknown;
    try {
      await router.route(explicitRequest('a'), makePrincipal());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderExhaustedError);
    // Only the first two models were tried; the cap stopped fallback before c.
    expect(providerCall.calls).toEqual(['a', 'b']);
  });
});
