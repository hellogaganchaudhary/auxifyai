/**
 * The Fallback Chain and request-outcome recording — the final stage of the
 * Model_Router (Req 3.7, 3.8, 3.9).
 *
 * Permission resolution (task 6.1) decided *which* models a user may use, and
 * the Hybrid_Routing_Layer (task 6.3) selected *one* to start from. This module
 * adds the two behaviors that make routing reliable and observable:
 *
 *   - **Fallback (Req 3.7, 3.8).** A provider error or a timeout on the current
 *     model is not fatal: the router advances to the next model in an ordered
 *     {@link buildFallbackChain Fallback Chain} and retries. Only when *every*
 *     model in the chain fails does it raise a single
 *     {@link ProviderExhaustedError} that identifies each attempted model and
 *     its individual failure reason (Req 3.8).
 *   - **Outcome recording (Req 3.9).** When a request finally succeeds, the
 *     router records the {@link RequestOutcome} — selected model, end-to-end
 *     latency in milliseconds, input/output token counts, and computed cost —
 *     through an injectable {@link OutcomeRecorder} so Analytics and Budget
 *     (later tasks) can attribute usage and spend.
 *
 * {@link ModelRouter.route} unifies the whole decision: it dispatches between
 * **explicit** routing (the request names a permitted model, Req 3.1/3.2) and
 * **Auto Mode** selection (Req 3.3-3.6), builds the chain from the resulting
 * model plus the principal's routable permitted set, executes it with retry,
 * records the outcome, and returns a {@link RoutedChatResult} the Chat_Service /
 * Streaming_Engine (tasks 8.x) can relay to the client.
 *
 * ## Testability
 *
 * Every effectful dependency is an injectable port so the layer is deterministic
 * under test with no real waiting:
 *   - {@link ProviderCallPort} models the provider chat call; a fake can fail,
 *     time out (by throwing {@link ProviderTimeoutError}), or succeed per model.
 *   - {@link Clock} supplies the timestamps latency is measured from; a fake
 *     clock advances by exact amounts.
 *   - {@link OutcomeRecorder} captures the recorded outcome for assertions.
 *
 * ## Collected (not yet re-streamed) responses
 *
 * Fallback and streaming are in tension: once a chunk has been handed to the
 * client it cannot be unsent, so a model whose stream fails part-way could not
 * be transparently retried. The router therefore *collects* each attempt's
 * chunks and only treats an attempt as successful once its stream completes; a
 * stream that throws before completing is a failed attempt that falls back. The
 * collected {@link RoutedChatResult.chunks} (plus the terminal usage/finish
 * reason) are returned so tasks 8.x can re-stream them to the client; making the
 * relay incremental is left to the Streaming_Engine.
 */

import type {
  ChatChunk,
  ChatFinishReason,
  ChatRequest,
  ModelInfo,
  ModelTier,
  Principal,
  TokenUsage,
} from '@auxify/types';

import { requestHasImageInput } from '../providers/index.js';

import { ProviderExhaustedError } from './errors.js';
import { HybridRoutingLayer } from './hybrid-routing-layer.js';
import { ModelPermissionResolver } from './model-permission-resolver.js';
import type {
  AttemptFailureKind,
  FallbackAttempt,
  RequestOutcome,
  RouteDecision,
  RoutedChatResult,
} from './types.js';

/**
 * The reserved {@link ChatRequest.modelId} that asks the router to choose a
 * model via Auto Mode rather than naming one explicitly (Req 3.3). Any other id
 * is treated as an explicit model request (Req 3.1).
 */
export const AUTO_MODEL_ID = 'auto' as const;

/**
 * A monotonic-enough wall clock, injectable so latency measurement is
 * deterministic in tests (Req 3.9).
 *
 * The router reads {@link Clock.now} immediately before the first attempt and
 * again on success; the difference is the request's end-to-end latency in
 * milliseconds (including any time spent on failed fallback attempts).
 */
export interface Clock {
  /** The current time in milliseconds (epoch or any consistent origin). */
  now(): number;
}

/** The default {@link Clock}, backed by the global `Date.now`. */
export const systemClock: Clock = { now: () => Date.now() };

/**
 * Thrown by a {@link ProviderCallPort} (or a timeout wrapper around it) when a
 * provider call exceeds its deadline (Req 3.7).
 *
 * The router classifies this — and any error named `TimeoutError`/`AbortError`
 * — as a {@link AttemptFailureKind} of `timeout` (as opposed to a generic
 * `provider_error`), so an exhaustion error can distinguish the two per model
 * (Req 3.8). Production wires a timeout-aware port (e.g. one that races the
 * provider stream against an `AbortSignal.timeout`); tests use a fake that
 * throws this directly, keeping timeout behavior testable without real waiting.
 */
export class ProviderTimeoutError extends Error {
  constructor(message = 'the provider call timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

/**
 * The injectable port that performs one provider chat attempt (Req 3.7).
 *
 * It abstracts the Provider_Abstraction_Layer's `AIProvider.chat` behind a
 * narrow surface the router can drive per model: given a {@link ChatRequest}
 * whose `modelId` is the model to try, it yields the provider's
 * {@link ChatChunk} stream. It MUST reject/throw on a provider error and MUST
 * throw a {@link ProviderTimeoutError} (or an `AbortError`/`TimeoutError`) on a
 * timeout — those are the two conditions the router treats as a retriable
 * failure that advances to the next model in the chain.
 */
export interface ProviderCallPort {
  /**
   * Stream a chat completion for `req.modelId`.
   *
   * @param req The chat request, with `modelId` set to the model to attempt.
   * @returns The provider's incremental chunk stream; the terminal chunk
   *   carries {@link TokenUsage} and a finish reason (Req 4.3).
   * @throws {ProviderTimeoutError} on a timeout (Req 3.7).
   * @throws {Error} on any other provider failure (Req 3.7).
   */
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
}

/**
 * The injectable sink for completed-request outcomes — the design's
 * `Model_Router.recordOutcome` (Req 3.9).
 *
 * The router calls {@link OutcomeRecorder.record} exactly once per successful
 * request with the fully-populated {@link RequestOutcome}. Analytics
 * (Req 31.1) and Budget (Req 22.x, 44.6) subscribe by implementing this port,
 * so usage attribution and spend accounting stay out of the routing core.
 */
export interface OutcomeRecorder {
  /**
   * Record the outcome of a completed model request (Req 3.9).
   *
   * @param outcome The selected model, latency, token counts, and computed cost.
   */
  record(outcome: RequestOutcome): void | Promise<void>;
}

/** Construction dependencies for a {@link ModelRouter}. */
export interface ModelRouterOptions {
  /** Resolves permitted models and routes explicitly-named ones (task 6.1). */
  resolver: ModelPermissionResolver;
  /** Selects a model in Auto Mode (task 6.3). */
  routingLayer: HybridRoutingLayer;
  /** Performs each provider chat attempt (Req 3.7). */
  providerCall: ProviderCallPort;
  /** Receives the recorded outcome of each successful request (Req 3.9). */
  recorder: OutcomeRecorder;
  /** Clock for latency measurement; defaults to {@link systemClock} (Req 3.9). */
  clock?: Clock;
  /**
   * Optional cap on the total number of models attempted (the selected model
   * plus fallbacks). Defaults to unbounded — the whole chain is tried. Must be
   * a positive integer when supplied.
   */
  maxAttempts?: number;
}

/**
 * Per-1k-token cost computation for a model and its reported usage (Req 3.9).
 *
 * `cost = inputTokens/1000 * per1kInputTokens + outputTokens/1000 * per1kOutputTokens`.
 *
 * @param model The model that served the request (carries its per-1k costs).
 * @param usage The input/output token counts reported by the provider.
 * @returns The computed cost in the platform's accounting currency.
 */
export function computeCost(model: ModelInfo, usage: TokenUsage): number {
  return (
    (usage.inputTokens / 1000) * model.cost.per1kInputTokens +
    (usage.outputTokens / 1000) * model.cost.per1kOutputTokens
  );
}

/**
 * Tier ordering for the documented nearest-tier fallback: Economy (cheapest) is
 * lowest, Premium highest; "distance" is the absolute difference of these ranks.
 * Restated locally so the chain ordering does not depend on the routing layer's
 * private helper.
 */
const TIER_RANK: Readonly<Record<ModelTier, number>> = {
  economy: 0,
  standard: 1,
  premium: 2,
};

/**
 * Build the ordered Fallback Chain for a request (Req 3.7).
 *
 * The chain *always starts with the selected model* (explicit or auto), so the
 * routing decision is honored first. The remaining candidates follow in a
 * deterministic "same-tier then nearest-tier" order:
 *
 *   1. the selected `model` first;
 *   2. then every other candidate, sorted by tier-rank distance from the
 *      selected model's tier (same tier first, then nearest), breaking ties
 *      toward the lower (cheaper) tier and then original listing order.
 *
 * Candidates are drawn from `routable` (the principal's permitted *and
 * currently available* set, Req 2.10) so fallback never tries a known-unhealthy
 * or non-permitted model. The selected model is always included first even if
 * it is absent from `routable` (an explicitly-named model is honored once
 * regardless of availability). When the request carries image input, candidates
 * are restricted to vision-capable models so fallback never downgrades image
 * input to a non-vision model (Req 3.6). Duplicate ids are removed, preserving
 * first occurrence.
 *
 * @param model The selected model to try first.
 * @param routable The principal's routable permitted set to draw fallbacks from.
 * @param req The chat request (its image-input flag gates vision-only fallback).
 * @returns The ordered, de-duplicated list of models to attempt.
 */
export function buildFallbackChain(
  model: ModelInfo,
  routable: ModelInfo[],
  req: ChatRequest,
): ModelInfo[] {
  const visionOnly = requestHasImageInput(req);
  const selectedRank = TIER_RANK[model.tier];

  // Candidates other than the selected model, drawn from the routable set and
  // (for image input) restricted to vision-capable models.
  const others = routable.filter(
    (candidate) =>
      candidate.id !== model.id && (!visionOnly || candidate.supportsVision),
  );

  // Stable sort by tier distance, then lower tier, then original listing order.
  const ordered = others
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const distanceA = Math.abs(TIER_RANK[a.candidate.tier] - selectedRank);
      const distanceB = Math.abs(TIER_RANK[b.candidate.tier] - selectedRank);
      if (distanceA !== distanceB) {
        return distanceA - distanceB;
      }
      const rankA = TIER_RANK[a.candidate.tier];
      const rankB = TIER_RANK[b.candidate.tier];
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.candidate);

  // Selected model first; de-duplicate by id (the selected model may also be in
  // `others` is impossible since it was filtered out, but other dupes are not).
  const chain: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const candidate of [model, ...ordered]) {
    if (!seen.has(candidate.id)) {
      seen.add(candidate.id);
      chain.push(candidate);
    }
  }
  return chain;
}

/**
 * The unified Model_Router (Req 3.1-3.9).
 *
 * Composes permission resolution (task 6.1), Auto Mode selection (task 6.3),
 * the Fallback Chain, and outcome recording into one {@link ModelRouter.route}
 * entry point. Stateless beyond its injected ports, so administrator changes to
 * a principal's permissions and health-driven availability changes both take
 * effect on the next call.
 */
export class ModelRouter {
  private readonly resolver: ModelPermissionResolver;
  private readonly routingLayer: HybridRoutingLayer;
  private readonly providerCall: ProviderCallPort;
  private readonly recorder: OutcomeRecorder;
  private readonly clock: Clock;
  private readonly maxAttempts: number | undefined;

  /**
   * @param options Injected collaborators and configuration.
   * @throws {RangeError} when `maxAttempts` is supplied but not a positive integer.
   */
  constructor(options: ModelRouterOptions) {
    if (
      options.maxAttempts !== undefined &&
      (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0)
    ) {
      throw new RangeError(
        `maxAttempts must be a positive integer, got ${options.maxAttempts}`,
      );
    }
    this.resolver = options.resolver;
    this.routingLayer = options.routingLayer;
    this.providerCall = options.providerCall;
    this.recorder = options.recorder;
    this.clock = options.clock ?? systemClock;
    this.maxAttempts = options.maxAttempts;
  }

  /**
   * Route and execute a chat request end to end (Req 3.1-3.9).
   *
   * Dispatches between explicit routing (when `req.modelId` names a model) and
   * Auto Mode (when it is {@link AUTO_MODEL_ID}); builds the Fallback Chain from
   * the chosen model and the principal's routable permitted set; tries each
   * model in turn, advancing on a provider error or timeout (Req 3.7); records
   * the outcome of the first success (Req 3.9); and returns the collected
   * result. If every model fails, throws {@link ProviderExhaustedError} naming
   * each attempt (Req 3.8).
   *
   * @param req The chat request to route.
   * @param principal The authenticated actor making the request.
   * @returns The successful routed result (decision, outcome, chunks, usage).
   * @throws {import('./errors.js').ModelNotAuthorizedError} explicit + not permitted (Req 3.2).
   * @throws {import('./errors.js').NoEligibleModelError} Auto Mode with no eligible model (Req 3.5, 3.6).
   * @throws {ProviderExhaustedError} every model in the chain failed (Req 3.8).
   * @throws {import('../providers/index.js').ModelNotFoundError} explicit + unknown model id.
   */
  async route(req: ChatRequest, principal: Principal): Promise<RoutedChatResult> {
    const { routable } = this.resolver.permittedModels(principal);
    const decision = await this.decide(req, principal, routable);

    const chain = this.applyAttemptCap(buildFallbackChain(decision.model, routable, req));

    const failedAttempts: FallbackAttempt[] = [];
    const startedAt = this.clock.now();

    for (const model of chain) {
      const attemptReq: ChatRequest = { ...req, modelId: model.id };
      try {
        const { chunks, usage, finishReason } = await this.runAttempt(attemptReq);
        const latencyMs = Math.max(0, this.clock.now() - startedAt);
        const outcome: RequestOutcome = {
          modelId: model.id,
          mode: decision.mode,
          latencyMs,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: computeCost(model, usage),
          failedAttempts: failedAttempts.map((attempt) => ({ ...attempt })),
        };
        await this.recorder.record(outcome);

        return {
          decision: finalDecision(decision, model, failedAttempts.length),
          outcome,
          usage,
          finishReason,
          chunks,
        };
      } catch (error) {
        const { kind, reason } = classifyFailure(error);
        failedAttempts.push({ modelId: model.id, kind, reason });
      }
    }

    // Req 3.8: the whole chain failed — surface every attempt and its reason.
    throw new ProviderExhaustedError(failedAttempts);
  }

  /**
   * Record an outcome out of band (the design's `Model_Router.recordOutcome`).
   *
   * `route` records automatically on success; this exposes the same sink for
   * callers that compute an outcome elsewhere (e.g. a streaming relay that
   * finalizes usage after re-emitting chunks).
   *
   * @param outcome The outcome to record (Req 3.9).
   */
  async recordOutcome(outcome: RequestOutcome): Promise<void> {
    await this.recorder.record(outcome);
  }

  /**
   * Produce the initial {@link RouteDecision}: explicit routing when `req`
   * names a model, otherwise Auto Mode selection over the routable set.
   */
  private async decide(
    req: ChatRequest,
    principal: Principal,
    routable: ModelInfo[],
  ): Promise<RouteDecision> {
    if (req.modelId !== AUTO_MODEL_ID) {
      // Req 3.1/3.2: permission-checked explicit routing (may throw).
      return this.resolver.routeExplicit(principal, req.modelId);
    }
    // Req 3.3-3.6: Auto Mode over the principal's routable permitted set (may throw).
    return this.routingLayer.autoSelect(req, routable);
  }

  /**
   * Run one provider attempt to completion: collect its chunk stream and
   * extract the terminal token usage and finish reason. Propagates any provider
   * error or timeout to the caller (which classifies it and falls back).
   */
  private async runAttempt(req: ChatRequest): Promise<{
    chunks: ChatChunk[];
    usage: TokenUsage;
    finishReason: ChatFinishReason | undefined;
  }> {
    const chunks: ChatChunk[] = [];
    let usage: TokenUsage | undefined;
    let finishReason: ChatFinishReason | undefined;

    for await (const chunk of this.providerCall.chat(req)) {
      chunks.push(chunk);
      if (chunk.usage !== undefined) {
        usage = chunk.usage;
      }
      if (chunk.finishReason !== undefined) {
        finishReason = chunk.finishReason;
      }
    }

    return {
      chunks,
      usage: usage ?? { inputTokens: 0, outputTokens: 0 },
      finishReason,
    };
  }

  /** Truncate the chain to {@link maxAttempts} when a cap is configured. */
  private applyAttemptCap(chain: ModelInfo[]): ModelInfo[] {
    return this.maxAttempts === undefined ? chain : chain.slice(0, this.maxAttempts);
  }
}

/**
 * Classify a thrown attempt failure into a {@link AttemptFailureKind} and a
 * human-readable reason (Req 3.7, 3.8). A {@link ProviderTimeoutError} (or an
 * error named `TimeoutError`/`AbortError`) is a `timeout`; anything else is a
 * generic `provider_error`.
 */
function classifyFailure(error: unknown): { kind: AttemptFailureKind; reason: string } {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderTimeoutError) {
    return { kind: 'timeout', reason };
  }
  const name = error instanceof Error ? error.name : undefined;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'timeout', reason };
  }
  return { kind: 'provider_error', reason };
}

/**
 * Build the {@link RouteDecision} describing the model that ultimately served
 * the request. When the originally-selected model succeeded, the original
 * decision is returned unchanged; when the router fell back, a decision for the
 * succeeding model is returned with the same `mode` and a reason noting the
 * fallback so the relayed result reflects what actually ran.
 */
function finalDecision(
  original: RouteDecision,
  servedBy: ModelInfo,
  failureCount: number,
): RouteDecision {
  if (servedBy.id === original.model.id) {
    return original;
  }
  return {
    model: servedBy,
    mode: original.mode,
    reason: `Fell back to "${servedBy.id}" after ${failureCount} failed attempt(s) (originally selected "${original.model.id}")`,
  };
}
