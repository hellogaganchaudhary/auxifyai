/**
 * Reusable model-access checks for Access_Control (Req 19.5, 19.6, 20.6).
 *
 * These pure helpers decide whether a {@link Principal} may use a given
 * {@link ModelInfo}, independent of any I/O, so they can be composed by
 * {@link import('./access-control.js').AccessControl.authorize} on the request
 * path and reused by the Model_Router's permission resolution (task 6.1) and by
 * the tier-gated-access property test (Property 11). Keeping the model gates in
 * one pure module means the rule "what may this user run on which model" is
 * defined exactly once.
 *
 * The gates, applied in fail-closed order:
 *
 *   1. **Viewer tier restriction (Req 19.6).** A `viewer` is restricted to
 *      Economy models; any non-Economy model is denied.
 *   2. **Premium authorization (Req 19.5).** A Premium-tier model is permitted
 *      only to a principal granted explicit Premium authorization
 *      (`premiumAuthorized`).
 *   3. **Per-user allowed-model Allow_List (Req 20.6).** When an administrator
 *      has assigned the principal an allowed-model list, the model must be on
 *      it. An empty list means no per-user model Allow_List has been assigned,
 *      so this gate does not restrict (the policy and tier gates still apply);
 *      a non-empty list restricts access to exactly its members.
 *
 * A model is permitted only when every gate passes (default-deny composes
 * naturally: any failing gate denies).
 */

import type { ModelInfo, Principal } from '@auxify/types';

import type { AuthzDenialCode } from './types.js';

/** The denial codes the model gates can produce (a subset of {@link AuthzDenialCode}). */
export type ModelDenialCode = Extract<
  AuthzDenialCode,
  'viewer_model_restricted' | 'premium_unauthorized' | 'model_not_allowed'
>;

/**
 * The outcome of a model-access check.
 *
 * `allowed` is `true` only when every model gate passes; otherwise
 * `denialCode` names the gate that denied and `reason` explains why.
 */
export interface ModelAccessResult {
  /** Whether the principal may use the model. */
  allowed: boolean;
  /** A human-readable explanation of the outcome. */
  reason: string;
  /** The gate that denied, present only when `allowed` is `false`. */
  denialCode?: ModelDenialCode;
}

/** The single, shared allow result (no per-call allocation of a reason needed). */
function allow(reason: string): ModelAccessResult {
  return { allowed: true, reason };
}

function deny(denialCode: ModelDenialCode, reason: string): ModelAccessResult {
  return { allowed: false, reason, denialCode };
}

/** Does the principal hold the most-restricted `viewer` role (Req 19.1, 19.6)? */
export function isViewer(principal: Principal): boolean {
  return principal.roles.includes('viewer');
}

/**
 * Decide whether `principal` may use `model`, applying the viewer, Premium, and
 * allowed-model gates in fail-closed order (Req 19.5, 19.6, 20.6).
 *
 * This is pure and side-effect free; the auditing of a denial is the caller's
 * responsibility (Access_Control records it through the AuditRecorder port).
 *
 * @param principal The authenticated actor.
 * @param model The model the request intends to use.
 * @returns A {@link ModelAccessResult} — allowed only when every gate passes.
 */
export function checkModelAccess(principal: Principal, model: ModelInfo): ModelAccessResult {
  // 1. Viewer tier restriction: viewers may use Economy models only (Req 19.6).
  if (isViewer(principal) && model.tier !== 'economy') {
    return deny(
      'viewer_model_restricted',
      `viewer role is restricted to Economy models; "${model.id}" is ${model.tier}`,
    );
  }

  // 2. Premium authorization: Premium models require explicit grant (Req 19.5).
  if (model.tier === 'premium' && !principal.premiumAuthorized) {
    return deny(
      'premium_unauthorized',
      `Premium model "${model.id}" requires explicit Premium authorization`,
    );
  }

  // 3. Per-user allowed-model Allow_List, when assigned (Req 20.6). An empty
  //    list means "no per-user model Allow_List assigned" and does not restrict.
  if (principal.allowedModels.length > 0 && !principal.allowedModels.includes(model.id)) {
    return deny(
      'model_not_allowed',
      `model "${model.id}" is not in the user's allowed-model Allow_List`,
    );
  }

  return allow(`model "${model.id}" is permitted for the principal`);
}
