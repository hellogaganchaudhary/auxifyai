/**
 * Feature: auxify-ai-platform, Property 12: Auto Mode selection respects
 * classification, permissions, and modality.
 *
 * Validates: Requirements 3.4, 3.5, 3.6
 *
 * _For any_ Auto Mode request and _any_ permitted (routable) model set, the
 * model the {@link HybridRoutingLayer} selects must obey three invariants at
 * once:
 *
 *   - **Permission (Req 3.5).** The chosen model is ALWAYS an element of the
 *     supplied permitted `allowed` set — selection never escapes to a
 *     non-permitted model. An empty permitted set yields no decision at all: a
 *     {@link NoEligibleModelError} with cause `no_routable_model`.
 *   - **Modality (Req 3.6).** When the request carries image input, the chosen
 *     model is vision-capable; if no permitted model is vision-capable, a
 *     {@link NoEligibleModelError} with cause `no_vision_capable_model` is
 *     thrown instead — image input is NEVER downgraded to a non-vision model.
 *   - **Classification → tier (Req 3.4).** For a non-vision class the chosen
 *     model's tier is the class's mapped tier (`simple` → Economy,
 *     `complex_reasoning` → Premium, `code` → Standard) WHEN a permitted model
 *     of that tier exists; otherwise it is the nearest-tier permitted model
 *     (minimal tier-rank distance, ties broken toward the cheaper tier, then
 *     listing order).
 *
 * The properties below are checked against INDEPENDENT oracles that restate the
 * nearest-tier and first-vision rules from scratch (they do not call the
 * layer's private selection helper), over arbitrary permitted sets (arbitrary
 * tiers and vision capability) and arbitrary query classes. Classification is
 * driven deterministically — either by curated requests carrying an unambiguous
 * signal (image part, code fence, reasoning keyword, plain text) or by an
 * injected {@link FakeQueryClassifier} — so the selection invariants are
 * exercised under a known class.
 *
 * The fakes ({@link makeModel}, {@link FakeQueryClassifier}) are the same
 * doubles the layer's unit suite was tested against, so the property is checked
 * against the real production selection logic, not a re-implementation.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MODEL_TIERS,
  type ChatMessage,
  type ChatRequest,
  type ModelInfo,
  type ModelTier,
} from '@auxify/types';

import { NoEligibleModelError } from './errors.js';
import { FakeQueryClassifier, makeModel } from './fakes.js';
import { HybridRoutingLayer } from './hybrid-routing-layer.js';
import { QUERY_CLASSES, TIER_FOR_QUERY_CLASS, type QueryClass } from './types.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

/**
 * Tier ordering used by the documented nearest-tier fallback, restated here
 * independently of the implementation under test.
 */
const TIER_RANK: Readonly<Record<ModelTier, number>> = {
  economy: 0,
  standard: 1,
  premium: 2,
};

/** The non-vision query classes (those that map to a tier via Req 3.4). */
const NON_VISION_CLASSES = ['simple', 'complex_reasoning', 'code'] as const;

// ---------------------------------------------------------------------------
// Request builders (mirrors the unit suite's helpers).
// ---------------------------------------------------------------------------

/** Build a text-only ChatRequest from one or more user message strings. */
function textRequest(...texts: string[]): ChatRequest {
  const messages: ChatMessage[] = texts.map((text) => ({ role: 'user', content: text }));
  return { modelId: 'auto', messages };
}

/** Build a ChatRequest carrying an image input part (vision input, Req 3.6). */
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

// ---------------------------------------------------------------------------
// Independent oracles: from-scratch restatements of the selection rules.
//
// These deliberately do NOT call the layer's private selectNearestTier — they
// re-derive the expected choice straight from the spec so the test can detect
// drift in the production selection logic.
// ---------------------------------------------------------------------------

/**
 * The permitted model the nearest-tier rule should choose for `desired`:
 * minimize tier-rank distance, break ties toward the cheaper (lower-rank) tier,
 * then by listing order. `allowed` is assumed non-empty.
 */
function nearestTierOracle(desired: ModelTier, allowed: ModelInfo[]): ModelInfo {
  const desiredRank = TIER_RANK[desired];
  const ranked = allowed
    .map((model, index) => ({
      model,
      index,
      distance: Math.abs(TIER_RANK[model.tier] - desiredRank),
      rank: TIER_RANK[model.tier],
    }))
    .sort((a, b) => a.distance - b.distance || a.rank - b.rank || a.index - b.index);
  // ranked is non-empty because allowed is non-empty.
  return (ranked[0] as (typeof ranked)[number]).model;
}

/** The first vision-capable permitted model in listing order, if any (Req 3.6). */
function firstVisionOracle(allowed: ModelInfo[]): ModelInfo | undefined {
  return allowed.find((model) => model.supportsVision);
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/**
 * An arbitrary permitted (routable) model set: 1-8 distinctly-identified models
 * spanning arbitrary tiers and arbitrary vision capability.
 */
const allowedArb: fc.Arbitrary<ModelInfo[]> = fc
  .array(
    fc.record({
      tier: fc.constantFrom(...MODEL_TIERS),
      supportsVision: fc.boolean(),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((specs) =>
    specs.map((spec, index) =>
      makeModel(spec.tier, { id: `m-${index}`, supportsVision: spec.supportsVision }),
    ),
  );

/**
 * Curated, deterministic classification cases. Each carries one unambiguous
 * signal and the class the layer (with no injected classifier) must produce:
 *   - image input part  → `vision` (Req 3.6, highest precedence),
 *   - fenced code block  → `code`,
 *   - a reasoning keyword → `complex_reasoning`,
 *   - plain short text    → `simple`.
 * The plain/reasoning strings are chosen to avoid accidentally tripping the
 * other heuristics.
 */
const PLAIN_TEXTS = [
  'what time is it in tokyo right now',
  'tell me a fun fact about otters',
  'good morning, hope you are well',
  'what is the capital of france',
] as const;

const REASONING_TEXTS = [
  'compare these two marketing approaches',
  'evaluate the tradeoffs between the options',
  'why does the tide rise and fall',
  'assess the long term consequences here',
] as const;

const CODE_FENCE_TEXTS = [
  'here is my snippet:\n```\nx = 1\n```',
  'look at this:\n```\nhello world\n```\nthanks',
] as const;

const classifyCaseArb: fc.Arbitrary<{ req: ChatRequest; expected: QueryClass }> = fc.oneof(
  fc
    .constantFrom(...PLAIN_TEXTS)
    .map((t) => ({ req: textRequest(t), expected: 'simple' as const })),
  fc
    .constantFrom(...REASONING_TEXTS)
    .map((t) => ({ req: textRequest(t), expected: 'complex_reasoning' as const })),
  fc
    .constantFrom(...CODE_FENCE_TEXTS)
    .map((t) => ({ req: textRequest(t), expected: 'code' as const })),
  // Image input forces vision regardless of the accompanying text.
  fc
    .constantFrom(...PLAIN_TEXTS)
    .map((t) => ({ req: imageRequest(t), expected: 'vision' as const })),
);

// ---------------------------------------------------------------------------
// Property 12.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 12: Auto Mode selection respects classification, permissions, and modality', () => {
  it('selectModel always returns a permitted model of the exact-or-nearest tier, vision-capable for vision (Validates: Requirements 3.4, 3.5, 3.6)', () => {
    const layer = new HybridRoutingLayer();

    fc.assert(
      fc.property(allowedArb, fc.constantFrom(...QUERY_CLASSES), (allowed, klass) => {
        const allowedIds = new Set(allowed.map((m) => m.id));

        if (klass === 'vision') {
          const expected = firstVisionOracle(allowed);
          if (expected === undefined) {
            // Req 3.6: image input with no vision-capable permitted model → error,
            // never a non-vision model.
            let thrown: unknown;
            try {
              layer.selectModel('vision', allowed);
            } catch (error) {
              thrown = error;
            }
            expect(thrown).toBeInstanceOf(NoEligibleModelError);
            expect((thrown as NoEligibleModelError).cause).toBe('no_vision_capable_model');
            return;
          }
          const selected = layer.selectModel('vision', allowed);
          // Permission (Req 3.5): the choice is within the permitted set.
          expect(allowedIds.has(selected.id)).toBe(true);
          // Modality (Req 3.6): the choice is vision-capable, and is the first such.
          expect(selected.supportsVision).toBe(true);
          expect(selected.id).toBe(expected.id);
          return;
        }

        // Non-vision class: tier mapping with the nearest-tier fallback (Req 3.4).
        const desired = TIER_FOR_QUERY_CLASS[klass];
        const selected = layer.selectModel(klass, allowed);

        // Permission (Req 3.5): always within the permitted set.
        expect(allowedIds.has(selected.id)).toBe(true);

        // Exact-tier rule: if a permitted model of the mapped tier exists, one is chosen.
        const hasExactTier = allowed.some((m) => m.tier === desired);
        if (hasExactTier) {
          expect(selected.tier).toBe(desired);
        }

        // Nearest-tier property: no permitted model is STRICTLY closer in tier rank.
        const selectedDistance = Math.abs(TIER_RANK[selected.tier] - TIER_RANK[desired]);
        for (const model of allowed) {
          const distance = Math.abs(TIER_RANK[model.tier] - TIER_RANK[desired]);
          expect(distance).toBeGreaterThanOrEqual(selectedDistance);
        }
        // Full rule incl. tie-breaks (cheaper tier, then listing order): exact oracle match.
        expect(selected.id).toBe(nearestTierOracle(desired, allowed).id);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('selectModel throws no_routable_model for an empty permitted set, for every class (Validates: Requirements 3.5)', () => {
    const layer = new HybridRoutingLayer();

    fc.assert(
      fc.property(fc.constantFrom(...QUERY_CLASSES), (klass) => {
        let thrown: unknown;
        try {
          layer.selectModel(klass, []);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(NoEligibleModelError);
        expect((thrown as NoEligibleModelError).cause).toBe('no_routable_model');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('classify maps the authoritative signal to its class (image→vision, fence→code, reasoning→complex, plain→simple) (Validates: Requirements 3.4, 3.6)', async () => {
    const layer = new HybridRoutingLayer();

    await fc.assert(
      fc.asyncProperty(classifyCaseArb, async ({ req, expected }) => {
        expect(await layer.classify(req)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('autoSelect routes a non-vision class to the exact-or-nearest permitted tier, mode:auto (Validates: Requirements 3.4, 3.5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        allowedArb,
        fc.constantFrom(...NON_VISION_CLASSES),
        async (allowed, decided) => {
          const allowedIds = new Set(allowed.map((m) => m.id));
          // Plain text → heuristic default `simple` → the injected classifier
          // deterministically refines the class to `decided`.
          const layer = new HybridRoutingLayer({ classifier: new FakeQueryClassifier(decided) });
          const decision = await layer.autoSelect(textRequest('hello there friend'), allowed);

          const desired = TIER_FOR_QUERY_CLASS[decided];
          expect(decision.mode).toBe('auto');
          // Permission (Req 3.5): within the permitted set.
          expect(allowedIds.has(decision.model.id)).toBe(true);
          // Classification → tier with nearest-tier fallback (Req 3.4): oracle match.
          expect(decision.model.id).toBe(nearestTierOracle(desired, allowed).id);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('autoSelect routes image input to a vision-capable permitted model, or errors when none exists (Validates: Requirements 3.5, 3.6)', async () => {
    const layer = new HybridRoutingLayer();

    await fc.assert(
      fc.asyncProperty(allowedArb, async (allowed) => {
        const allowedIds = new Set(allowed.map((m) => m.id));
        const expected = firstVisionOracle(allowed);

        if (expected === undefined) {
          // Req 3.6: never downgrade image input to a non-vision model.
          let thrown: unknown;
          try {
            await layer.autoSelect(imageRequest(), allowed);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(NoEligibleModelError);
          expect((thrown as NoEligibleModelError).cause).toBe('no_vision_capable_model');
          return;
        }

        const decision = await layer.autoSelect(imageRequest(), allowed);
        expect(decision.mode).toBe('auto');
        // Permission (Req 3.5) + modality (Req 3.6).
        expect(allowedIds.has(decision.model.id)).toBe(true);
        expect(decision.model.supportsVision).toBe(true);
        expect(decision.model.id).toBe(expected.id);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
