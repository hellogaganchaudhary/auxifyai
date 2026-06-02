/**
 * The Hybrid_Routing_Layer — Auto Mode model selection (Req 3.3, 3.4, 3.5, 3.6).
 *
 * When a chat request does not name a model, the Model_Router routes in **Auto
 * Mode**: it (1) classifies the query and (2) selects a model whose tier (or
 * vision capability) matches that class, *restricted to the models the user is
 * permitted to use*. This module owns both halves of that decision behind the
 * design's `HybridRoutingLayer` contract:
 *
 *   - {@link HybridRoutingLayer.classify} maps a {@link ChatRequest} to a
 *     {@link QueryClass} by **combining** authoritative rules, deterministic
 *     query heuristics, and an optional model-based classifier (Req 3.3).
 *   - {@link HybridRoutingLayer.selectModel} maps a class to a concrete
 *     {@link ModelInfo} drawn *only* from the permitted set the caller passes:
 *     `simple` → Economy, `complex_reasoning` → Premium, `code` → Standard
 *     (Req 3.4), and `vision` → a vision-capable model (Req 3.6).
 *   - {@link HybridRoutingLayer.autoSelect} ties the two together into a
 *     `mode: 'auto'` {@link RouteDecision} (Req 3.5).
 *
 * ## Restriction to permitted models (Req 3.5)
 *
 * Selection is *always* made from the `allowed` list the caller supplies, never
 * from the full catalog. Callers MUST pass the requesting principal's
 * **routable permitted set** —
 * {@link import('./model-permission-resolver.js').ModelPermissionResolver.permittedModels}(principal).routable
 * — so a non-permitted (or unavailable) model can never be selected by
 * construction. The layer enforces this contract literally: it only ever
 * returns an element of `allowed`.
 *
 * ## Classification: how the signals combine (Req 3.3)
 *
 * Auto Mode classification is *hybrid*: it fuses authoritative rules,
 * deterministic heuristics, and an optional model-based classifier, applied in
 * a fixed precedence so the outcome is explainable and (with a fake classifier)
 * fully deterministic in tests:
 *
 *   1. **Image rule (highest precedence, Req 3.6).** If the request carries any
 *      image input part, the class is `vision` — full stop. Image input *forces*
 *      a vision-capable model and is never downgraded, so neither heuristics nor
 *      the classifier are consulted.
 *   2. **Code-fence rule.** A fenced code block (```` ``` ````) is an
 *      unambiguous code signal → `code`.
 *   3. **Deterministic heuristics.** Otherwise the text is scored for code
 *      indicators and reasoning-complexity indicators. A positive heuristic
 *      match (`code` or `complex_reasoning`) is authoritative and **overrides**
 *      the model-based classifier.
 *   4. **Model-based classifier (informs the default).** Only when rules and
 *      heuristics are inconclusive (the heuristic default `simple`) is the
 *      injected {@link QueryClassifier}, if any, consulted to refine the
 *      decision. Its result is honored except for `vision`, which is reserved
 *      for the image rule and coerced to `simple` here.
 *
 * The model-based classifier is an **injectable, optional port** so the layer
 * is testable without a live model and deterministic in tests (a fake), and so
 * the (necessarily async) classification call is isolated behind one interface.
 */

import type { ChatRequest, ModelInfo, ModelTier } from '@auxify/types';

import { NoEligibleModelError } from './errors.js';
import { TIER_FOR_QUERY_CLASS, type QueryClass, type RouteDecision } from './types.js';

/**
 * The optional, injectable model-based query classifier (Req 3.3).
 *
 * This is the "model-based classification" signal of the hybrid layer, isolated
 * behind a port so it stays optional and the layer is deterministic under test
 * (supply a fake). It is consulted *only* to refine the otherwise-`simple`
 * default — authoritative rules (image input, code fence) and positive
 * heuristics take precedence over it (see the module overview).
 *
 * Implementations classify by the conversation text alone; the image/vision
 * decision is made by the layer from actual image input (Req 3.6), so a
 * `vision` result here carries no image and is treated as `simple`.
 */
export interface QueryClassifier {
  /**
   * Classify the conversation text into a {@link QueryClass}.
   *
   * @param text The concatenated textual content of the request's messages.
   * @returns The inferred class. A `vision` result is ignored by the layer
   *   (vision is decided from image input, not text).
   */
  classifyText(text: string): Promise<QueryClass>;
}

/** Construction dependencies for {@link HybridRoutingLayer}. */
export interface HybridRoutingLayerOptions {
  /**
   * The optional model-based classifier (Req 3.3). When omitted, classification
   * relies on rules and deterministic heuristics alone.
   */
  classifier?: QueryClassifier;
}

/**
 * Tier ordering used by the documented nearest-tier fallback. Economy is the
 * lowest (cheapest) tier and Premium the highest; "distance" between tiers is
 * the absolute difference of these ranks.
 */
const TIER_RANK: Readonly<Record<ModelTier, number>> = {
  economy: 0,
  standard: 1,
  premium: 2,
};

/**
 * Fenced code block detector (three or more backticks). A fenced block is an
 * unambiguous code signal and is treated as an authoritative rule.
 */
const CODE_FENCE = /```/;

/**
 * Deterministic code indicators. Two or more distinct matches (or a single
 * fenced block, handled separately) classify the query as `code`. Kept
 * intentionally simple and explainable rather than exhaustive.
 */
const CODE_INDICATORS: readonly RegExp[] = [
  /\b(function|def|class|interface|struct|enum)\s+\w/i,
  /\b(import|from|#include|using|require)\b/i,
  /\b(const|let|var|public|private|static|async|await|return)\b/,
  /\b(SELECT|INSERT|UPDATE|DELETE)\b\s+/i,
  /\bconsole\.log\b|\bprint\s*\(|\bSystem\.out\b/,
  /=>|::|->|;\s*$|\{\s*\}|\(\)\s*=>/m,
  /\b(stack\s?trace|compile|syntax\s+error|null\s?pointer|segfault|exception)\b/i,
  /\b(refactor|debug|unit\s+test|regex|api\s+endpoint|npm|pip|docker)\b/i,
];

/**
 * Phrases that, by themselves, signal a code task even without syntax
 * indicators (e.g. "write a function that ...", "fix this bug").
 */
const CODE_PHRASES: readonly RegExp[] = [
  /\bwrite\s+(?:a\s+|the\s+|some\s+)?(?:code|function|method|class|script|program|query|sql|regex)\b/i,
  /\b(fix|debug|refactor|optimi[sz]e|implement|review)\s+(?:this|the|my)?\s*(?:code|bug|function|method|script)\b/i,
];

/**
 * Reasoning-complexity indicators. A match classifies the query as
 * `complex_reasoning` (mapped to the Premium tier) when no stronger code signal
 * is present.
 */
const COMPLEXITY_INDICATORS: readonly RegExp[] = [
  /\b(analy[sz]e|evaluate|assess|critique|justify|prove|derive|reason)\b/i,
  /\b(compare|contrast|trade[- ]?offs?|pros\s+and\s+cons)\b/i,
  /\b(design|architect|strategy|plan|roadmap|optimi[sz]e)\b/i,
  /\b(why|how\s+come|implications?|consequences?|root\s+cause)\b/i,
  /\bstep[- ]by[- ]step\b|\bthink\s+through\b|\bin\s+depth\b|\bcomprehensive\b/i,
];

/**
 * Length thresholds (in characters) above which a query is treated as complex
 * by virtue of its size alone. A long, detailed prompt generally warrants the
 * stronger reasoning tier.
 */
const COMPLEXITY_LENGTH_CHARS = 1500;

/**
 * The Auto Mode decision layer of the Model_Router (Req 3.3-3.6).
 *
 * Stateless beyond its optional injected {@link QueryClassifier}: every call
 * reads only its arguments, so changes to a principal's permitted set (carried
 * in the `allowed` list the caller computes per request) always take effect on
 * the next call.
 */
export class HybridRoutingLayer {
  private readonly classifier: QueryClassifier | undefined;

  /**
   * @param options Construction dependencies; pass a {@link QueryClassifier} to
   *   enable the model-based signal, or omit it for rules+heuristics only.
   */
  constructor(options: HybridRoutingLayerOptions = {}) {
    this.classifier = options.classifier;
  }

  /**
   * Classify a request into a {@link QueryClass} by combining the image rule,
   * the code-fence rule, deterministic heuristics, and (only as a tie-breaker
   * for the `simple` default) the optional model-based classifier (Req 3.3,
   * 3.6).
   *
   * Precedence (highest first): image input → `vision`; code fence → `code`;
   * positive heuristic (`code` / `complex_reasoning`); model-based classifier;
   * `simple`. See the module overview for the full rationale.
   *
   * @param req The chat request to classify.
   * @returns The query class driving model selection.
   */
  async classify(req: ChatRequest): Promise<QueryClass> {
    // 1. Image rule (Req 3.6): image input forces vision and is never downgraded.
    if (hasImageInput(req)) {
      return 'vision';
    }

    const text = extractText(req);

    // 2. Code-fence rule: an unambiguous, authoritative code signal.
    if (CODE_FENCE.test(text)) {
      return 'code';
    }

    // 3. Deterministic heuristics. A positive (non-`simple`) match overrides
    //    the model-based classifier.
    const heuristic = heuristicClass(text);
    if (heuristic !== 'simple') {
      return heuristic;
    }

    // 4. Model-based classifier informs the otherwise-`simple` default (Req 3.3).
    //    A `vision` result is reserved for the image rule and coerced away.
    if (this.classifier !== undefined) {
      const inferred = await this.classifier.classifyText(text);
      return inferred === 'vision' ? 'simple' : inferred;
    }

    return 'simple';
  }

  /**
   * Select a concrete model for a class from the permitted `allowed` set
   * (Req 3.4, 3.5, 3.6).
   *
   * - `vision` → the first vision-capable model in `allowed` (listing order
   *   reflects registry preference) (Req 3.6).
   * - otherwise → a model of the class's mapped tier (`simple` → Economy,
   *   `complex_reasoning` → Premium, `code` → Standard, Req 3.4). When no
   *   permitted model has the exact tier, the **nearest-tier fallback** applies:
   *   the permitted model whose tier is closest by {@link TIER_RANK} distance is
   *   chosen, breaking ties toward the lower (cheaper) tier and then listing
   *   order. The selection never leaves `allowed`, so a non-permitted model is
   *   never chosen (Req 3.5).
   *
   * @param klass The query class to satisfy.
   * @param allowed The principal's permitted (routable) model set to select from.
   * @returns A model drawn from `allowed`.
   * @throws {NoEligibleModelError} when `allowed` is empty (`no_routable_model`),
   *   or when `klass` is `vision` but no model in `allowed` is vision-capable
   *   (`no_vision_capable_model`, Req 3.6).
   */
  selectModel(klass: QueryClass, allowed: ModelInfo[]): ModelInfo {
    if (allowed.length === 0) {
      throw new NoEligibleModelError(
        'no_routable_model',
        'the principal has no routable permitted model',
      );
    }

    if (klass === 'vision') {
      const visionModel = allowed.find((model) => model.supportsVision);
      if (visionModel === undefined) {
        // Req 3.6: image input requires a vision-capable model; never downgrade.
        throw new NoEligibleModelError(
          'no_vision_capable_model',
          'the request contains image input but no permitted model is vision-capable',
        );
      }
      return visionModel;
    }

    return selectNearestTier(TIER_FOR_QUERY_CLASS[klass], allowed);
  }

  /**
   * Run the full Auto Mode decision: classify `req`, select a model from the
   * permitted `allowed` set, and return a `mode: 'auto'` {@link RouteDecision}
   * (Req 3.3-3.6).
   *
   * This is the Model_Router's Auto Mode entry. The `allowed` argument MUST be
   * the requesting principal's routable permitted set so the decision is
   * restricted to permitted models (Req 3.5); the unified `route()` that
   * dispatches between explicit and Auto Mode is assembled in task 6.5.
   *
   * @param req The chat request to route.
   * @param allowed The principal's permitted (routable) model set.
   * @returns The auto-mode routing decision.
   * @throws {NoEligibleModelError} per {@link selectModel}.
   */
  async autoSelect(req: ChatRequest, allowed: ModelInfo[]): Promise<RouteDecision> {
    const klass = await this.classify(req);
    const model = this.selectModel(klass, allowed);
    return {
      model,
      mode: 'auto',
      reason: routeReason(klass, model),
    };
  }
}

/**
 * Whether `req` carries any image input part anywhere in its messages (Req 3.6).
 * The presence of even one image part means a vision-capable model is required.
 */
function hasImageInput(req: ChatRequest): boolean {
  return req.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  );
}

/**
 * Concatenate the textual content of every message (and the system prompt) into
 * a single string for heuristic and model-based classification. Image parts
 * contribute no text.
 */
function extractText(req: ChatRequest): string {
  const parts: string[] = [];
  if (req.systemPrompt !== undefined) {
    parts.push(req.systemPrompt);
  }
  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      parts.push(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.join('\n');
}

/**
 * The deterministic, classifier-free heuristic verdict for `text`: `code` when
 * code indicators/phrases dominate, `complex_reasoning` when reasoning-
 * complexity indicators (or sheer length) are present, otherwise `simple`.
 * Code takes precedence over complexity when both are present.
 */
function heuristicClass(text: string): QueryClass {
  const codeIndicatorHits = CODE_INDICATORS.filter((re) => re.test(text)).length;
  const codePhraseHit = CODE_PHRASES.some((re) => re.test(text));
  // Two corroborating syntax indicators, or an explicit code phrase, → code.
  if (codePhraseHit || codeIndicatorHits >= 2) {
    return 'code';
  }

  const complexityHit = COMPLEXITY_INDICATORS.some((re) => re.test(text));
  if (complexityHit || text.length >= COMPLEXITY_LENGTH_CHARS) {
    return 'complex_reasoning';
  }

  return 'simple';
}

/**
 * Select the permitted model whose tier best matches `desired`, applying the
 * documented nearest-tier fallback: minimize {@link TIER_RANK} distance, then
 * prefer the lower (cheaper) tier, then listing order. `allowed` is assumed
 * non-empty (checked by the caller).
 */
function selectNearestTier(desired: ModelTier, allowed: ModelInfo[]): ModelInfo {
  const desiredRank = TIER_RANK[desired];
  // `allowed` is non-empty, so a best candidate always exists.
  let best = allowed[0] as ModelInfo;
  let bestDistance = Math.abs(TIER_RANK[best.tier] - desiredRank);
  let bestRank = TIER_RANK[best.tier];

  for (let i = 1; i < allowed.length; i += 1) {
    const candidate = allowed[i] as ModelInfo;
    const candidateRank = TIER_RANK[candidate.tier];
    const distance = Math.abs(candidateRank - desiredRank);
    // Strictly-closer wins; on a tie prefer the lower tier. Listing order is
    // preserved because only a strict improvement replaces the incumbent.
    if (distance < bestDistance || (distance === bestDistance && candidateRank < bestRank)) {
      best = candidate;
      bestDistance = distance;
      bestRank = candidateRank;
    }
  }

  return best;
}

/** Build the human-readable reason for an Auto Mode {@link RouteDecision}. */
function routeReason(klass: QueryClass, model: ModelInfo): string {
  if (klass === 'vision') {
    return `Auto Mode detected image input and selected vision-capable model "${model.id}"`;
  }
  const desiredTier = TIER_FOR_QUERY_CLASS[klass];
  const tierNote =
    model.tier === desiredTier
      ? `${model.tier} tier`
      : `${model.tier} tier (nearest permitted to ${desiredTier})`;
  return `Auto Mode classified the query as "${klass}" and selected "${model.id}" (${tierNote})`;
}
