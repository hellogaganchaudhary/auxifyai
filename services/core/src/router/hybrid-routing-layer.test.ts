/**
 * Unit tests for the Hybrid_Routing_Layer (Req 3.3, 3.4, 3.5, 3.6).
 *
 * These exercise {@link HybridRoutingLayer} against deterministic fakes
 * ({@link FakeQueryClassifier} and {@link makeModel} builders), covering:
 *   - classification of simple / complex / code / image queries by the combined
 *     rules + heuristics + model-based classifier (Req 3.3),
 *   - the precedence rules (image > code fence > heuristics > classifier),
 *   - tier mapping simple → Economy, complex → Premium, code → Standard (Req 3.4),
 *   - selection restricted to the permitted set and the nearest-tier fallback
 *     within it (Req 3.5),
 *   - vision routing forced by image input and the no-vision-model failure
 *     (Req 3.6),
 *   - the end-to-end `autoSelect` producing a `mode: 'auto'` RouteDecision.
 */

import type { ChatMessage, ChatRequest, ModelInfo } from '@auxify/types';
import { describe, expect, it } from 'vitest';

import { NoEligibleModelError } from './errors.js';
import { FakeQueryClassifier, makeModel } from './fakes.js';
import { HybridRoutingLayer } from './hybrid-routing-layer.js';

/** Build a text-only ChatRequest from one or more user message strings. */
function textRequest(...texts: string[]): ChatRequest {
  const messages: ChatMessage[] = texts.map((text) => ({ role: 'user', content: text }));
  return { modelId: 'auto', messages };
}

/** Build a ChatRequest carrying an image input part (vision input). */
function imageRequest(text = 'What is in this picture?'): ChatRequest {
  return {
    modelId: 'auto',
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

/** A permitted set spanning all three tiers, all vision-incapable by default. */
function tierSet(): ModelInfo[] {
  return [
    makeModel('economy', { id: 'economy-1' }),
    makeModel('standard', { id: 'standard-1' }),
    makeModel('premium', { id: 'premium-1' }),
  ];
}

describe('HybridRoutingLayer.classify', () => {
  it('classifies image input as vision regardless of text (Req 3.6)', async () => {
    // Classifier would say "code", but the image rule wins and is never consulted.
    const layer = new HybridRoutingLayer({ classifier: new FakeQueryClassifier('code') });
    expect(await layer.classify(imageRequest('write a function'))).toBe('vision');
  });

  it('classifies a fenced code block as code (authoritative rule)', async () => {
    const layer = new HybridRoutingLayer();
    const req = textRequest('Here is my snippet:\n```\nconsole.log(1)\n```');
    expect(await layer.classify(req)).toBe('code');
  });

  it('classifies an explicit code phrase as code via heuristics', async () => {
    const layer = new HybridRoutingLayer();
    expect(await layer.classify(textRequest('Write a function that reverses a string'))).toBe(
      'code',
    );
    expect(await layer.classify(textRequest('Please fix this bug in my code'))).toBe('code');
  });

  it('classifies multi-indicator code text as code via heuristics', async () => {
    const layer = new HybridRoutingLayer();
    const req = textRequest('import os\nclass Foo: return await bar()');
    expect(await layer.classify(req)).toBe('code');
  });

  it('classifies reasoning-heavy prompts as complex_reasoning via heuristics', async () => {
    const layer = new HybridRoutingLayer();
    expect(
      await layer.classify(textRequest('Analyze the trade-offs of microservices vs monolith')),
    ).toBe('complex_reasoning');
    expect(await layer.classify(textRequest('Compare and contrast these two strategies'))).toBe(
      'complex_reasoning',
    );
  });

  it('classifies a very long prompt as complex_reasoning by length', async () => {
    const layer = new HybridRoutingLayer();
    const long = 'please respond to this. '.repeat(80); // > 1500 chars
    expect(await layer.classify(textRequest(long))).toBe('complex_reasoning');
  });

  it('falls back to simple for short, plain queries with no classifier', async () => {
    const layer = new HybridRoutingLayer();
    expect(await layer.classify(textRequest('What time is it in Tokyo?'))).toBe('simple');
  });

  it('consults the classifier only for the otherwise-simple default (Req 3.3)', async () => {
    const classifier = new FakeQueryClassifier('complex_reasoning');
    const layer = new HybridRoutingLayer({ classifier });

    // Plain query → heuristic default is simple → classifier is consulted and refines it.
    expect(await layer.classify(textRequest('hello there'))).toBe('complex_reasoning');
    expect(classifier.calls).toHaveLength(1);
  });

  it('lets a positive heuristic override the classifier (Req 3.3)', async () => {
    const classifier = new FakeQueryClassifier('simple');
    const layer = new HybridRoutingLayer({ classifier });

    // Heuristic says code; classifier (simple) must NOT override it, nor be consulted.
    expect(await layer.classify(textRequest('Write a function to sort an array'))).toBe('code');
    expect(classifier.calls).toHaveLength(0);
  });

  it('coerces a classifier vision result to simple (vision is decided from image input)', async () => {
    const classifier = new FakeQueryClassifier('vision');
    const layer = new HybridRoutingLayer({ classifier });
    expect(await layer.classify(textRequest('just a plain text question'))).toBe('simple');
  });
});

describe('HybridRoutingLayer.selectModel — tier mapping (Req 3.4)', () => {
  it('maps simple → Economy', () => {
    const layer = new HybridRoutingLayer();
    expect(layer.selectModel('simple', tierSet()).tier).toBe('economy');
  });

  it('maps complex_reasoning → Premium', () => {
    const layer = new HybridRoutingLayer();
    expect(layer.selectModel('complex_reasoning', tierSet()).tier).toBe('premium');
  });

  it('maps code → Standard', () => {
    const layer = new HybridRoutingLayer();
    expect(layer.selectModel('code', tierSet()).tier).toBe('standard');
  });
});

describe('HybridRoutingLayer.selectModel — permission restriction (Req 3.5)', () => {
  it('only ever returns a model from the permitted set', () => {
    const layer = new HybridRoutingLayer();
    // Permitted set has only Economy; a complex query must still stay within it.
    const allowed = [makeModel('economy', { id: 'only-economy' })];
    const selected = layer.selectModel('complex_reasoning', allowed);
    expect(selected.id).toBe('only-economy');
  });

  it('applies the nearest-tier fallback when the exact tier is absent', () => {
    const layer = new HybridRoutingLayer();
    // Desired Premium (rank 2); permitted has Economy (0) and Standard (1).
    // Standard is nearer → chosen.
    const allowed = [
      makeModel('economy', { id: 'e' }),
      makeModel('standard', { id: 's' }),
    ];
    expect(layer.selectModel('complex_reasoning', allowed).id).toBe('s');
  });

  it('breaks nearest-tier ties toward the lower (cheaper) tier', () => {
    const layer = new HybridRoutingLayer();
    // Desired Standard (rank 1); permitted has Economy (0) and Premium (2),
    // both at distance 1 → prefer the lower (economy).
    const allowed = [
      makeModel('premium', { id: 'p' }),
      makeModel('economy', { id: 'e' }),
    ];
    expect(layer.selectModel('code', allowed).id).toBe('e');
  });

  it('throws NoEligibleModelError when the permitted set is empty', () => {
    const layer = new HybridRoutingLayer();
    try {
      layer.selectModel('simple', []);
      expect.unreachable('expected NoEligibleModelError');
    } catch (error) {
      expect(error).toBeInstanceOf(NoEligibleModelError);
      expect((error as NoEligibleModelError).cause).toBe('no_routable_model');
    }
  });
});

describe('HybridRoutingLayer.selectModel — vision routing (Req 3.6)', () => {
  it('selects a vision-capable model for the vision class', () => {
    const layer = new HybridRoutingLayer();
    const allowed = [
      makeModel('economy', { id: 'text-only' }),
      makeModel('standard', { id: 'vision-std', supportsVision: true }),
    ];
    const selected = layer.selectModel('vision', allowed);
    expect(selected.id).toBe('vision-std');
    expect(selected.supportsVision).toBe(true);
  });

  it('throws NoEligibleModelError when no permitted model is vision-capable', () => {
    const layer = new HybridRoutingLayer();
    try {
      layer.selectModel('vision', tierSet()); // none support vision
      expect.unreachable('expected NoEligibleModelError');
    } catch (error) {
      expect(error).toBeInstanceOf(NoEligibleModelError);
      const e = error as NoEligibleModelError;
      expect(e.cause).toBe('no_vision_capable_model');
      expect(e.requiresVision).toBe(true);
    }
  });
});

describe('HybridRoutingLayer.autoSelect', () => {
  it('produces a mode:auto RouteDecision for a simple query', async () => {
    const layer = new HybridRoutingLayer();
    const decision = await layer.autoSelect(textRequest('hi'), tierSet());
    expect(decision.mode).toBe('auto');
    expect(decision.model.tier).toBe('economy');
    expect(decision.reason).toContain('simple');
  });

  it('routes image input to a vision-capable permitted model (Req 3.6)', async () => {
    const layer = new HybridRoutingLayer();
    const allowed = [
      makeModel('economy', { id: 'text-only' }),
      makeModel('premium', { id: 'vision-prem', supportsVision: true }),
    ];
    const decision = await layer.autoSelect(imageRequest(), allowed);
    expect(decision.mode).toBe('auto');
    expect(decision.model.id).toBe('vision-prem');
    expect(decision.reason).toContain('vision');
  });

  it('routes a classified code query to a Standard permitted model (Req 3.4)', async () => {
    const layer = new HybridRoutingLayer();
    const decision = await layer.autoSelect(
      textRequest('Write a function that sums an array'),
      tierSet(),
    );
    expect(decision.model.tier).toBe('standard');
  });

  it('surfaces NoEligibleModelError when image input has no vision model (Req 3.6)', async () => {
    const layer = new HybridRoutingLayer();
    await expect(layer.autoSelect(imageRequest(), tierSet())).rejects.toBeInstanceOf(
      NoEligibleModelError,
    );
  });
});

describe('NoEligibleModelError.toPlatformError', () => {
  it('projects an unmet vision requirement to an authorization PlatformError', () => {
    const error = new NoEligibleModelError('no_vision_capable_model', 'no vision model');
    const platformError = error.toPlatformError('corr-1');
    expect(platformError.category).toBe('authorization');
    expect(platformError.code).toBe('NO_ELIGIBLE_MODEL');
    expect(platformError.retriable).toBe(false);
    expect(platformError.details).toEqual({
      cause: 'no_vision_capable_model',
      requiresVision: true,
    });
  });

  it('projects an empty routable set to a retriable provider_unavailable PlatformError', () => {
    const error = new NoEligibleModelError('no_routable_model', 'no routable model');
    const platformError = error.toPlatformError('corr-2');
    expect(platformError.category).toBe('provider_unavailable');
    expect(platformError.retriable).toBe(true);
  });
});
