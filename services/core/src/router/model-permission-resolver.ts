/**
 * Model permission resolution — the first stage of the Model_Router (Req 3.1,
 * 3.2, 19.5, 19.6, 20.6).
 *
 * Before Auto Mode can select a model (task 6.3) or the Fallback Chain can try
 * one (task 6.5), the router must answer a prior question: *which models is this
 * user allowed to use at all?* {@link ModelPermissionResolver} answers it,
 * reusing the single, shared model-access gate
 * ({@link import('../access/index.js').checkModelAccess}) so the rule "what may
 * this user run on which model" stays defined in exactly one place and never
 * drifts between Access_Control's request-path check and the router.
 *
 * It offers two operations:
 *
 *   - {@link ModelPermissionResolver.permittedModels} computes a principal's
 *     {@link PermittedModelSet} from the registry catalog: every model that
 *     passes the viewer (Req 19.6), Premium (Req 19.5), and per-user
 *     allowed-model (Req 20.6) gates is `permitted`; the subset that is also
 *     currently available (Req 2.10) is `routable`, the catalog selection and
 *     fallback draw from.
 *   - {@link ModelPermissionResolver.routeExplicit} routes an explicitly named
 *     model: a permitted model yields a {@link RouteDecision} (Req 3.1); a
 *     non-permitted model is rejected with a
 *     {@link ModelNotAuthorizedError} that names it (Req 3.2).
 */

import type { ModelInfo, Principal } from '@auxify/types';

import { checkModelAccess } from '../access/index.js';

import { ModelNotAuthorizedError } from './errors.js';
import type { PermittedModelSet, RouteDecision } from './types.js';

/**
 * The narrow, read-only catalog port the resolver needs (Req 2.7).
 *
 * It is the read surface of the Provider_Abstraction_Layer's
 * {@link import('../providers/index.js').ModelRegistry} —
 * {@link import('../providers/index.js').ConfigModelRegistry} satisfies it
 * directly — so the resolver depends only on listing and lookup, never on the
 * availability mutators owned by the health checker (task 5.4). Tests can
 * supply a tiny in-memory fake.
 */
export interface ModelCatalog {
  /** Every registered model, each carrying its tier, availability, and capability flags (Req 2.7). */
  list(): ModelInfo[];
  /**
   * The model registered under `modelId`.
   * @throws {import('../providers/index.js').ModelNotFoundError} when no model has that id.
   */
  get(modelId: string): ModelInfo;
}

/**
 * Resolves a principal's permitted model set and routes explicitly-requested
 * models, composing the shared {@link checkModelAccess} gate (Req 3.1, 3.2,
 * 19.5, 19.6, 20.6).
 *
 * The resolver is stateless beyond its injected {@link ModelCatalog}: each call
 * reads the current catalog, so administrator changes to a user's role, Premium
 * authorization, or allowed-model list (carried on the {@link Principal}) and
 * health-driven availability changes both take effect on the next call
 * (Req 19.7, 2.10).
 */
export class ModelPermissionResolver {
  /**
   * @param catalog The model catalog to resolve against (typically the
   *   Provider_Abstraction_Layer's `ConfigModelRegistry`).
   */
  constructor(private readonly catalog: ModelCatalog) {}

  /**
   * Compute `principal`'s effective {@link PermittedModelSet} (Req 19.5, 19.6,
   * 20.6).
   *
   * Every catalog model that passes {@link checkModelAccess} is included in
   * `permitted`, in catalog (listing) order; the subset that is also currently
   * available for routing (Req 2.10) is `routable`. Permission is about
   * authorization, not health: an unavailable-but-permitted model stays in
   * `permitted` and is simply omitted from `routable`.
   *
   * @param principal The authenticated actor whose permitted models to compute.
   * @returns The principal's permitted and routable model sets.
   */
  permittedModels(principal: Principal): PermittedModelSet {
    const permitted = this.catalog
      .list()
      .filter((model) => checkModelAccess(principal, model).allowed);
    const routable = permitted.filter((model) => model.available);
    return { permitted, routable };
  }

  /**
   * Whether `principal` may use `model` under the tier/role/allow-list gates
   * (Req 19.5, 19.6, 20.6). A thin, allocation-free convenience over
   * {@link checkModelAccess} for callers that only need the boolean verdict.
   *
   * @param principal The authenticated actor.
   * @param model The model to test.
   * @returns `true` iff every model-access gate permits the model.
   */
  isPermitted(principal: Principal, model: ModelInfo): boolean {
    return checkModelAccess(principal, model).allowed;
  }

  /**
   * Route an explicitly-requested model (Req 3.1, 3.2).
   *
   * When `principal` is permitted to use `modelId`, returns a
   * {@link RouteDecision} for that model (Req 3.1). When the model exists but
   * the principal is not permitted to use it, rejects with a
   * {@link ModelNotAuthorizedError} that names the disallowed model and carries
   * the deciding gate's `denialCode` (Req 3.2). An unknown `modelId` propagates
   * the catalog's {@link import('../providers/index.js').ModelNotFoundError}.
   *
   * @param principal The authenticated actor making the request.
   * @param modelId The id of the model the request explicitly specifies.
   * @returns The routing decision for the permitted model.
   * @throws {ModelNotAuthorizedError} when the principal is not permitted to use the model (Req 3.2).
   * @throws {import('../providers/index.js').ModelNotFoundError} when `modelId` is not registered.
   */
  routeExplicit(principal: Principal, modelId: string): RouteDecision {
    // Throws ModelNotFoundError for an unknown id (distinct from "not permitted").
    const model = this.catalog.get(modelId);

    const result = checkModelAccess(principal, model);
    if (!result.allowed) {
      // Req 3.2: reject with an authorization error that NAMES the model.
      throw new ModelNotAuthorizedError(modelId, result.reason, result.denialCode);
    }

    return {
      model,
      mode: 'explicit',
      reason: result.reason,
    };
  }
}
