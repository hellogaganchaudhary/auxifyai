/**
 * Test fakes and builders for the Model_Router (tasks 6.1, 6.3).
 *
 * {@link ModelPermissionResolver} depends on one injected port — a
 * {@link ModelCatalog} (the read surface of the Provider_Abstraction_Layer's
 * registry). {@link FakeModelCatalog} is a tiny in-memory catalog that lets unit
 * and property tests drive permission resolution deterministically without
 * loading the real `ConfigModelRegistry`, while still matching its observable
 * contract — preserved listing order and a {@link ModelNotFoundError} for an
 * unknown id.
 *
 * {@link HybridRoutingLayer} (task 6.3) depends on one optional injected port —
 * a {@link QueryClassifier} (the model-based classification signal).
 * {@link FakeQueryClassifier} returns a fixed or computed class deterministically
 * so tests can prove rules/heuristics override it and observe whether it was
 * consulted.
 *
 * The principal and model builders are re-exported from the Access_Control
 * fakes so the router is tested against the *same* doubles the shared
 * {@link import('../access/index.js').checkModelAccess} gate was unit-tested
 * with — there is exactly one definition of "a standard user" or "a Premium
 * model" across the suites.
 */

import type { ChatChunk, ChatRequest, ModelInfo, TokenUsage } from '@auxify/types';

import { ModelNotFoundError } from '../providers/index.js';

import type { Clock, OutcomeRecorder, ProviderCallPort } from './fallback.js';
import { ProviderTimeoutError } from './fallback.js';
import type { QueryClassifier } from './hybrid-routing-layer.js';
import type { ModelCatalog } from './model-permission-resolver.js';
import type { QueryClass, RequestOutcome } from './types.js';

export { makeModel, makePrincipal } from '../access/fakes.js';

/**
 * An in-memory {@link ModelCatalog} over a fixed list of models.
 *
 * Listing returns defensive copies in insertion order (mirroring
 * {@link import('../providers/index.js').ConfigModelRegistry}), and `get`
 * throws {@link ModelNotFoundError} for an unknown id so the resolver's
 * unknown-id path is exercised against the real error type.
 */
export class FakeModelCatalog implements ModelCatalog {
  private readonly models: ModelInfo[];

  constructor(models: ModelInfo[]) {
    this.models = models.map((m) => ({ ...m, cost: { ...m.cost } }));
  }

  list(): ModelInfo[] {
    return this.models.map((m) => ({ ...m, cost: { ...m.cost } }));
  }

  get(modelId: string): ModelInfo {
    const found = this.models.find((m) => m.id === modelId);
    if (found === undefined) {
      throw new ModelNotFoundError(modelId);
    }
    return { ...found, cost: { ...found.cost } };
  }
}

/**
 * A deterministic {@link QueryClassifier} for testing the Hybrid_Routing_Layer.
 *
 * It returns a fixed {@link QueryClass} (or one computed from the text) so a
 * test can drive the model-based classification signal exactly — proving, for
 * instance, that authoritative rules and positive heuristics override it, and
 * that it only refines the otherwise-`simple` default. Every `classifyText`
 * call is recorded in {@link calls} so a test can assert whether the classifier
 * was consulted at all.
 */
export class FakeQueryClassifier implements QueryClassifier {
  /** The text of every `classifyText` invocation, in order. */
  readonly calls: string[] = [];

  constructor(
    private readonly decide: QueryClass | ((text: string) => QueryClass) = 'simple',
  ) {}

  async classifyText(text: string): Promise<QueryClass> {
    this.calls.push(text);
    return typeof this.decide === 'function' ? this.decide(text) : this.decide;
  }
}

/**
 * How a {@link FakeProviderCall} should behave for a single model attempt.
 *
 * - `{ ok: usage }` — succeed, streaming a deterministic response and a terminal
 *   chunk carrying the given {@link TokenUsage} and a `stop` finish reason.
 * - `{ error: message }` — fail with a generic provider {@link Error} (Req 3.7).
 * - `{ timeout: message }` — fail with a {@link ProviderTimeoutError} (Req 3.7).
 */
export type FakeProviderBehavior =
  | { ok: TokenUsage }
  | { error: string }
  | { timeout: string };

/**
 * A deterministic {@link ProviderCallPort} keyed by model id (Req 3.7).
 *
 * Each `chat` call looks up the behavior configured for `req.modelId` and either
 * streams a successful response or throws a provider error / timeout — letting a
 * test drive the exact failure pattern across a Fallback Chain with no real
 * waiting. Every attempted model id is recorded in {@link calls}, in order, so a
 * test can assert the chain was tried in order and stopped at the first success.
 * An unconfigured model id defaults to a generic provider error.
 */
export class FakeProviderCall implements ProviderCallPort {
  /** The model ids `chat` was invoked with, in attempt order. */
  readonly calls: string[] = [];

  constructor(private readonly behaviors: Readonly<Record<string, FakeProviderBehavior>>) {}

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.calls.push(req.modelId);
    const behavior = this.behaviors[req.modelId] ?? {
      error: `no behavior configured for "${req.modelId}"`,
    };

    if ('timeout' in behavior) {
      throw new ProviderTimeoutError(behavior.timeout);
    }
    if ('error' in behavior) {
      throw new Error(behavior.error);
    }

    // Success: stream a couple of token chunks, then a terminal usage chunk.
    yield { delta: 'ok' };
    yield {
      delta: '',
      done: true,
      model: req.modelId,
      finishReason: 'stop',
      usage: behavior.ok,
    };
  }
}

/**
 * A deterministic {@link Clock} that returns preset timestamps (Req 3.9).
 *
 * Construct it with an ordered list of values it returns on successive `now`
 * calls (the last value repeats once exhausted), so a test can make end-to-end
 * latency an exact, asserted number regardless of real elapsed time.
 */
export class FakeClock implements Clock {
  private index = 0;

  constructor(private readonly times: number[] = [0]) {}

  now(): number {
    const value = this.times[Math.min(this.index, this.times.length - 1)] ?? 0;
    this.index += 1;
    return value;
  }
}

/**
 * A capturing {@link OutcomeRecorder} that stores every recorded
 * {@link RequestOutcome} so a test can assert the selected model, latency,
 * token counts, and computed cost were recorded (Req 3.9, Property 14).
 */
export class CapturingOutcomeRecorder implements OutcomeRecorder {
  /** Every recorded outcome, in order. */
  readonly outcomes: RequestOutcome[] = [];

  record(outcome: RequestOutcome): void {
    // Defensive copy so later mutation by the router cannot rewrite history.
    this.outcomes.push({
      ...outcome,
      failedAttempts: outcome.failedAttempts.map((attempt) => ({ ...attempt })),
    });
  }

  /** The most recently recorded outcome, or `undefined` when none. */
  get last(): RequestOutcome | undefined {
    return this.outcomes[this.outcomes.length - 1];
  }
}
