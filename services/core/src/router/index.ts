/**
 * Model_Router (Req 3).
 *
 * The Model_Router decides which model serves each request. It begins, in this
 * task (6.1), with **model permission resolution** — the prior question every
 * later routing stage depends on: *which models may this user use at all?* The
 * Hybrid_Routing_Layer (task 6.3) selects from that permitted set, and the
 * Fallback Chain (task 6.5) is built from it.
 *
 * Permission resolution reuses the single, shared model-access gate
 * ({@link import('../access/index.js').checkModelAccess}) so the tier (Req
 * 19.5), viewer (Req 19.6), and per-user allowed-model (Req 20.6) rules stay
 * defined in exactly one place across Access_Control and the router.
 *
 * Surface:
 *   - {@link ModelPermissionResolver} — computes a principal's
 *     {@link PermittedModelSet} and routes explicitly-requested models
 *     (`routeExplicit`): permitted → {@link RouteDecision} (Req 3.1),
 *     not permitted → {@link ModelNotAuthorizedError} naming the model (Req 3.2).
 *   - {@link ModelCatalog} — the narrow read-only catalog port the resolver
 *     needs (satisfied by `ConfigModelRegistry`).
 *   - {@link HybridRoutingLayer} — Auto Mode classification + selection
 *     (`classify`, `selectModel`, `autoSelect`), restricted to the permitted
 *     set (Req 3.3-3.6), with an injectable {@link QueryClassifier} port.
 *   - {@link PermittedModelSet} / {@link RouteDecision} / {@link RouteMode} /
 *     {@link QueryClass} — the permission and routing result types.
 *   - {@link ModelNotAuthorizedError} / {@link MODEL_NOT_AUTHORIZED_CODE} — the
 *     typed authorization rejection (Req 3.2), projectable to a
 *     {@link import('@auxify/types').PlatformError} (Req 46.8).
 *   - {@link NoEligibleModelError} / {@link NO_ELIGIBLE_MODEL_CODE} — the typed
 *     Auto Mode no-decision failure (empty routable set, or no vision-capable
 *     permitted model for image input) (Req 3.5, 3.6).
 *   - {@link ModelRouter} — the unified entry that dispatches explicit vs Auto
 *     Mode routing, builds and executes the Fallback Chain with retry on
 *     provider error/timeout (Req 3.7), and records each successful request's
 *     outcome (Req 3.9), via injectable {@link ProviderCallPort},
 *     {@link OutcomeRecorder}, and {@link Clock} ports.
 *   - {@link buildFallbackChain} / {@link computeCost} — the pure Fallback Chain
 *     ordering (Req 3.7) and per-1k-token cost computation (Req 3.9).
 *   - {@link ProviderExhaustedError} / {@link PROVIDER_EXHAUSTED_CODE} — the
 *     typed whole-chain-failed error enumerating every attempted model and
 *     reason (Req 3.8), and {@link ProviderTimeoutError} — the timeout signal a
 *     provider call raises to trigger fallback (Req 3.7).
 *   - {@link RequestOutcome} / {@link RoutedChatResult} / {@link FallbackAttempt}
 *     — the recorded-outcome and routed-result shapes (Req 3.7, 3.9).
 */

export {
  ModelPermissionResolver,
  type ModelCatalog,
} from './model-permission-resolver.js';

export {
  HybridRoutingLayer,
  type HybridRoutingLayerOptions,
  type QueryClassifier,
} from './hybrid-routing-layer.js';

export {
  ModelRouter,
  buildFallbackChain,
  computeCost,
  systemClock,
  AUTO_MODEL_ID,
  ProviderTimeoutError,
  type ModelRouterOptions,
  type ProviderCallPort,
  type OutcomeRecorder,
  type Clock,
} from './fallback.js';

export {
  ModelNotAuthorizedError,
  MODEL_NOT_AUTHORIZED_CODE,
  NoEligibleModelError,
  NO_ELIGIBLE_MODEL_CODE,
  ProviderExhaustedError,
  PROVIDER_EXHAUSTED_CODE,
  type NoEligibleModelCause,
} from './errors.js';

export {
  QUERY_CLASSES,
  TIER_FOR_QUERY_CLASS,
  type PermittedModelSet,
  type QueryClass,
  type RouteDecision,
  type RouteMode,
  type AttemptFailureKind,
  type FallbackAttempt,
  type RequestOutcome,
  type RoutedChatResult,
} from './types.js';
