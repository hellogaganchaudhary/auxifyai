/**
 * Domain types for the Model_Router's permission-resolution stage (Req 3.1,
 * 3.2, 19.5, 19.6, 20.6).
 *
 * The Model_Router begins here: before any model can be selected (Auto Mode,
 * task 6.3) or tried in a Fallback Chain (task 6.5), it must first be decided
 * *which models a user is allowed to use at all*. That decision is what these
 * types describe:
 *
 *   - {@link PermittedModelSet} is a user's effective permitted catalog —
 *     every registry model that passes the tier/role/allow-list gates
 *     (Req 19.5, 19.6, 20.6) — split into the full `permitted` set and the
 *     `routable` subset that is also currently available for routing (Req 2.10).
 *     The Hybrid_Routing_Layer (task 6.3) selects from `routable`; the fallback
 *     chain (task 6.5) is built from it.
 *   - {@link RouteDecision} is the outcome of routing a single request to a
 *     concrete model. Task 6.1 produces it for an explicitly-requested,
 *     permitted model (`mode: 'explicit'`, Req 3.1); task 6.3 will produce it
 *     for an auto-selected model (`mode: 'auto'`).
 */

import type { ChatChunk, ChatFinishReason, ModelInfo, ModelTier } from '@auxify/types';

/**
 * How the Hybrid_Routing_Layer classifies an Auto Mode query (Req 3.3, 3.4,
 * 3.6).
 *
 * The class drives model selection: `simple` → Economy, `complex_reasoning` →
 * Premium, and `code` → Standard tier (Req 3.4); `vision` instead demands a
 * vision-capable model regardless of tier and is forced whenever the request
 * carries image input (Req 3.6).
 */
export type QueryClass =
  /** A short, factual, low-effort query — routed to the Economy tier (Req 3.4). */
  | 'simple'
  /** A query needing deep/multi-step reasoning — routed to the Premium tier (Req 3.4). */
  | 'complex_reasoning'
  /** A programming/code task — routed to the Standard tier (Req 3.4). */
  | 'code'
  /** A query carrying image input — routed to a vision-capable model (Req 3.6). */
  | 'vision';

/** All {@link QueryClass} values, for iteration and test generators. */
export const QUERY_CLASSES: readonly QueryClass[] = [
  'simple',
  'complex_reasoning',
  'code',
  'vision',
] as const;

/**
 * The model {@link ModelTier} each non-vision {@link QueryClass} maps to in Auto
 * Mode (Req 3.4): `simple` → `economy`, `complex_reasoning` → `premium`,
 * `code` → `standard`.
 *
 * `vision` is intentionally absent: a vision query is selected by capability
 * ({@link ModelInfo.supportsVision}), not by tier (Req 3.6).
 */
export const TIER_FOR_QUERY_CLASS: Readonly<Record<Exclude<QueryClass, 'vision'>, ModelTier>> = {
  simple: 'economy',
  complex_reasoning: 'premium',
  code: 'standard',
};

/**
 * A user's effective permitted model catalog (Req 3.1, 19.5, 19.6, 20.6).
 *
 * `permitted` is every model the principal *may* use under the tier, viewer,
 * and per-user allowed-model gates, independent of current health — permission
 * is about authorization, not availability. `routable` is the subset that is
 * also currently available for routing (Req 2.10), and is what selection
 * (task 6.3) and the fallback chain (task 6.5) draw from. `routable` is always
 * a subset of `permitted`, preserving the registry's listing order.
 */
export interface PermittedModelSet {
  /** Every registry model the principal may use under tier/role/allow-list gating. */
  permitted: ModelInfo[];
  /** The subset of {@link permitted} that is currently available for routing (Req 2.10). */
  routable: ModelInfo[];
}

/** How a {@link RouteDecision}'s model was chosen. */
export type RouteMode =
  /** The caller explicitly named the model and is permitted to use it (Req 3.1). */
  | 'explicit'
  /** Auto Mode selected the model from the permitted set (Req 3.3-3.6, task 6.3). */
  | 'auto';

/**
 * The outcome of routing a single request to a concrete model.
 *
 * Task 6.1 returns this for an explicitly-requested, permitted model
 * (`mode: 'explicit'`, Req 3.1). The Hybrid_Routing_Layer (task 6.3) returns it
 * for an auto-selected model (`mode: 'auto'`), and the fallback layer (task 6.5)
 * carries the same shape across attempts. A rejected request never yields a
 * decision — it raises a {@link import('./errors.js').ModelNotAuthorizedError}
 * naming the disallowed model (Req 3.2).
 */
export interface RouteDecision {
  /** The model the request is routed to. */
  model: ModelInfo;
  /** How the model was chosen. */
  mode: RouteMode;
  /** A human-readable explanation of the routing decision. */
  reason: string;
}

/**
 * Why a single Fallback Chain attempt failed (Req 3.7).
 *
 * The Model_Router treats two — and only two — conditions as a retriable
 * provider failure that advances to the next model in the chain:
 *
 *   - `provider_error` — the provider call rejected/threw for any reason other
 *     than a timeout (an upstream 5xx, a malformed response, a transport error,
 *     etc.).
 *   - `timeout` — the provider call did not produce a result within the request
 *     deadline and was abandoned.
 *
 * Both are recorded per attempt so an exhaustion error can name each tried model
 * alongside the precise reason it failed (Req 3.8).
 */
export type AttemptFailureKind = 'provider_error' | 'timeout';

/**
 * A single failed Fallback Chain attempt: the model that was tried and why it
 * failed (Req 3.7, 3.8).
 *
 * One {@link FallbackAttempt} is produced for every model the router tries and
 * which fails; the ordered list of them is what a
 * {@link import('./errors.js').ProviderExhaustedError} reports when the whole
 * chain is exhausted (Req 3.8), in attempt order.
 */
export interface FallbackAttempt {
  /** The id of the model that was tried (Req 3.8). */
  modelId: string;
  /** Whether the attempt failed with a provider error or a timeout (Req 3.7). */
  kind: AttemptFailureKind;
  /** A human-readable explanation of the individual failure (Req 3.8). */
  reason: string;
}

/**
 * The fully-recorded outcome of a completed model request (Req 3.9).
 *
 * When a request finally succeeds (on the first model or after falling back),
 * the Model_Router records exactly the facts Req 3.9 enumerates — the selected
 * model, end-to-end latency in milliseconds, the input/output token counts the
 * provider reported, and the computed cost — and hands them to the injected
 * {@link import('./fallback.js').OutcomeRecorder} so Analytics and Budget
 * (later tasks) can attribute usage and spend. `cost` is derived from the
 * model's per-1k token costs:
 * `inputTokens/1000 * per1kInputTokens + outputTokens/1000 * per1kOutputTokens`.
 */
export interface RequestOutcome {
  /** The id of the model that ultimately served the request (Req 3.9). */
  modelId: string;
  /** How that model was chosen (`explicit` or `auto`). */
  mode: RouteMode;
  /** End-to-end latency of the successful attempt, in milliseconds (Req 3.9). */
  latencyMs: number;
  /** Input (prompt) token count the provider reported (Req 3.9). */
  inputTokens: number;
  /** Output (completion) token count the provider reported (Req 3.9). */
  outputTokens: number;
  /** Computed cost of the request in the platform accounting currency (Req 3.9). */
  cost: number;
  /**
   * The models tried and failed before this success, in attempt order — empty
   * when the first model succeeded. Lets recorders observe fallback activity.
   */
  failedAttempts: FallbackAttempt[];
}

/**
 * The successful result of routing and executing a request through the unified
 * {@link import('./fallback.js').ModelRouter.route} (Req 3.7, 3.9).
 *
 * It pairs the {@link RouteDecision} for the model that ultimately succeeded
 * with the request {@link RequestOutcome} that was recorded, and exposes the
 * provider's streamed {@link ChatChunk}s so the Chat_Service / Streaming_Engine
 * (tasks 8.x) can relay tokens to the client. The terminal usage and finish
 * reason from the final chunk are surfaced directly for convenience.
 */
export interface RoutedChatResult {
  /** The routing decision for the model that ultimately served the request. */
  decision: RouteDecision;
  /** The recorded outcome (selected model, latency, tokens, cost) (Req 3.9). */
  outcome: RequestOutcome;
  /** The terminal token usage reported by the provider. */
  usage: { inputTokens: number; outputTokens: number };
  /** Why generation stopped, from the provider's terminal chunk, when reported. */
  finishReason: ChatFinishReason | undefined;
  /** The ordered chunks streamed by the successful provider call (Req 4.2). */
  chunks: ChatChunk[];
}
