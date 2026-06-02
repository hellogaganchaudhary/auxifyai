/**
 * Domain types for Access_Control (Req 1.3, 1.7, 19.4, 19.5, 19.6).
 *
 * Access_Control is the request-path authorization gate that composes the
 * Policy_Engine (the fail-closed Allow_List guard) with the tenancy membership
 * checks and the model-tier gates the requirements call for. These types
 * describe the inputs and outputs of {@link AccessControl.authorize}:
 *
 *   - {@link AuthorizeOptions} carries the extra facts a decision may need —
 *     the {@link ModelInfo} being used (for Premium/viewer tier gating,
 *     Req 19.5, 19.6), whether the target resource is shared (for the viewer
 *     shared-resource restriction, Req 19.6), and the request IP/user-agent for
 *     the audit trail.
 *   - {@link AuthzDenialCode} enumerates the fail-closed stages a denial can
 *     come from, so callers and the audit record can distinguish a cross-tenant
 *     reference from a policy denial from a model-tier denial.
 *   - {@link AuthzDecision} is the returned verdict — a structured allow/deny
 *     that callers can inspect, mirroring the Policy_Engine's
 *     {@link import('../policy/index.js').PolicyDecision}.
 */

import type { ModelInfo } from '@auxify/types';

import type { PolicyDecision } from '../policy/index.js';

/**
 * Extra, optional facts an authorization decision may depend on.
 *
 * `authorize` works for plain resource access with no options; the fields here
 * are only consulted when the relevant requirement applies:
 *   - `model` — the {@link ModelInfo} the request will use. Supplying it engages
 *     the model-tier gates: Premium models require explicit authorization
 *     (Req 19.5) and a viewer is restricted to Economy models (Req 19.6), and
 *     the model must be on the principal's allowed-model Allow_List (Req 20.6).
 *   - `shared` — whether the target resource is shared with the principal. A
 *     viewer may access shared conversations and shared prompts only (Req 19.6).
 *   - `ip` / `userAgent` — request metadata copied into the audit record on a
 *     denial (Req 1.7, 19.4, 37.1).
 */
export interface AuthorizeOptions {
  /** The model the request will use, engaging the Premium/viewer tier gates (Req 19.5, 19.6, 20.6). */
  model?: ModelInfo;
  /** Whether the target resource is shared with the principal (viewer access, Req 19.6). */
  shared?: boolean;
  /** Originating IP address, recorded on a denial (Req 37.1). */
  ip?: string;
  /** Originating user agent, recorded on a denial (Req 37.1). */
  userAgent?: string;
}

/**
 * The fail-closed stage that produced a denial.
 *
 * Each value maps to a requirement so a caller (and the audit record) can tell
 * the denials apart:
 *   - `cross_tenant` — the resource references an Organization/Team/Project the
 *     principal does not belong to (Req 1.3, 1.7).
 *   - `policy_denied` — no Allow_List grant resolved through the Policy_Engine,
 *     including the default-deny path (Req 19.2, 19.4, 19.8).
 *   - `viewer_resource_restricted` — a viewer attempted a non-read-only action,
 *     or accessed a non-shared conversation/prompt (Req 19.6).
 *   - `viewer_model_restricted` — a viewer attempted to use a non-Economy model
 *     (Req 19.6).
 *   - `premium_unauthorized` — a Premium-tier model was used without explicit
 *     Premium authorization (Req 19.5).
 *   - `model_not_allowed` — the model is not on the principal's allowed-model
 *     Allow_List (Req 20.6).
 */
export type AuthzDenialCode =
  | 'cross_tenant'
  | 'policy_denied'
  | 'viewer_resource_restricted'
  | 'viewer_model_restricted'
  | 'premium_unauthorized'
  | 'model_not_allowed';

/**
 * The verdict returned by {@link AccessControl.authorize}.
 *
 * `allowed` is `true` only when every fail-closed stage passed; in every other
 * case it is `false` and `denialCode` names the stage that denied. `reason` is
 * a human-readable explanation suitable for logs and audit metadata.
 * `policyDecision` is attached when the Policy_Engine stage ran, so callers can
 * see the deciding scope.
 */
export interface AuthzDecision {
  /** Whether the action is authorized. Fail-closed: `false` unless every stage passes. */
  allowed: boolean;
  /** A human-readable explanation of the verdict. */
  reason: string;
  /** The stage that denied, present only when `allowed` is `false`. */
  denialCode?: AuthzDenialCode;
  /** The underlying Policy_Engine decision, present when the policy stage ran. */
  policyDecision?: PolicyDecision;
}
