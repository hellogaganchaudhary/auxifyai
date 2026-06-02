/**
 * The Policy_Engine (Req 19.1, 19.2, 19.3, 19.8).
 *
 * The Policy_Engine is the first guard of the platform's fail-closed decision
 * pipeline (design "Fail-Closed Decision Pipeline"). Given an authenticated
 * {@link Principal}, a {@link ResourceRef}, and an {@link Action}, it resolves
 * whether an explicit Allow_List grants the permission, applying hierarchical
 * precedence and defaulting to deny.
 *
 * ## Precedence / merge algorithm (Req 19.3)
 *
 * Policies apply at three levels — Organization, Team, and User — and conflicts
 * resolve to the **highest-precedence scope present**:
 *
 *     Organization  >  Team  >  User
 *
 * The engine evaluates the scopes in that order. For each scope it gathers the
 * policies that apply to the principal at that level (the Organization itself,
 * any of the principal's Teams, or the User) and inspects their Allow_List
 * entries that *match* the requested `(action, resourceType)` — where an entry
 * matches when its `action`/`resourceType` equals the request or is the
 * wildcard `'*'`:
 *
 *   1. If the scope has no matching entry, it is *silent*; evaluation falls
 *      through to the next, lower-precedence scope.
 *   2. If the scope has matching entries, it *decides*: an explicit `deny`
 *      entry withholds the permission (least privilege wins within a scope),
 *      otherwise a matching `allow` grants it. The first deciding scope's
 *      result is final — a higher scope's decision overrides every lower one
 *      (Req 19.3).
 *
 * ## Fail-closed / default-deny (Req 19.2, 19.8)
 *
 * If **no** scope decides — no applicable policy resolves, or no Allow_List
 * entry matches — the result is `deny` with `decidingScope = null`. Access is
 * therefore granted only by an explicit `allow`, never inferred from the
 * absence of a policy.
 *
 * ## Freshness (Req 19.7)
 *
 * `resolve` reads policies through the {@link PolicyRepository} on every call
 * and holds no cache, so a role/policy change made between two calls is
 * reflected on the next resolution.
 */

import {
  tenantContextFromPrincipal,
  type Action,
  type Principal,
  type ResourceRef,
} from '@auxify/types';

import type { SqlClient } from '../storage/pgvector.js';
import { PolicyRepository } from './policy-repository.js';
import {
  POLICY_SCOPE_PRECEDENCE,
  type AllowListEntry,
  type Policy,
  type PolicyDecision,
  type PolicyScope,
} from './types.js';

/** Construction dependencies for the {@link PolicyEngine}. */
export interface PolicyEngineOptions {
  /** The narrow SQL port (real `pg` client or a fake in tests). */
  sql: SqlClient;
}

/**
 * Does an Allow_List entry cover the requested action and resource type?
 *
 * An entry matches when its `action` equals the requested action or is the
 * wildcard `'*'`, and likewise for `resourceType`.
 */
function entryMatches(
  entry: AllowListEntry,
  action: Action,
  resourceType: ResourceRef['type'],
): boolean {
  const actionMatches = entry.action === '*' || entry.action === action;
  const resourceMatches = entry.resourceType === '*' || entry.resourceType === resourceType;
  return actionMatches && resourceMatches;
}

/**
 * Decide a single scope's outcome from the policies that apply to the principal
 * at that level.
 *
 * @returns `'allow'`/`'deny'` when the scope has a matching entry (deny wins
 * within the scope — least privilege), or `null` when the scope is silent.
 */
function decideScope(
  policies: readonly Policy[],
  action: Action,
  resourceType: ResourceRef['type'],
): 'allow' | 'deny' | null {
  let sawAllow = false;
  for (const policy of policies) {
    for (const entry of policy.allowList) {
      if (!entryMatches(entry, action, resourceType)) continue;
      // An explicit deny at this scope withholds the permission outright.
      if ((entry.effect ?? 'allow') === 'deny') return 'deny';
      sawAllow = true;
    }
  }
  return sawAllow ? 'allow' : null;
}

/**
 * Pure, deterministic precedence resolution (Req 19.3, 19.2, 19.8).
 *
 * Given the policies grouped by scope and the requested permission, return the
 * {@link PolicyDecision}. This function performs no I/O, so it is directly unit-
 * and property-testable and is the seam {@link PolicyEngine.resolve} and
 * Access_Control (task 3.7) build on.
 *
 * @param policiesByScope Applicable policies for each precedence level.
 * @param action The action being attempted.
 * @param resourceType The kind of resource being acted on.
 */
export function decidePolicy(
  policiesByScope: Readonly<Record<PolicyScope, readonly Policy[]>>,
  action: Action,
  resourceType: ResourceRef['type'],
): PolicyDecision {
  // Highest precedence first: Organization > Team > User (Req 19.3).
  for (const scope of POLICY_SCOPE_PRECEDENCE) {
    const outcome = decideScope(policiesByScope[scope], action, resourceType);
    if (outcome === null) continue; // scope is silent — fall through
    if (outcome === 'allow') {
      return {
        allowed: true,
        reason: `${scope}-scope Allow_List grants ${action} on ${resourceType}`,
        decidingScope: scope,
      };
    }
    return {
      allowed: false,
      reason: `${scope}-scope policy explicitly denies ${action} on ${resourceType}`,
      decidingScope: scope,
    };
  }
  // No scope resolved a decision — fail closed (Req 19.2, 19.8).
  return {
    allowed: false,
    reason: `default-deny: no Allow_List grants ${action} on ${resourceType}`,
    decidingScope: null,
  };
}

/** The scope ids that apply to a principal at each precedence level. */
function scopeIdsForPrincipal(principal: Principal): Record<PolicyScope, string[]> {
  return {
    org: [principal.organizationId],
    team: [...principal.teamIds],
    user: [principal.userId],
  };
}

/**
 * The Policy_Engine. Construct once with a SQL port and call {@link resolve}
 * with the acting principal, the resource, and the action.
 */
export class PolicyEngine {
  private readonly policies: PolicyRepository;

  constructor(options: PolicyEngineOptions) {
    this.policies = new PolicyRepository(options.sql);
  }

  /**
   * Resolve whether the principal may perform `action` on `resource`, applying
   * Organization > Team > User precedence and defaulting to deny (Req 19.2,
   * 19.3, 19.8).
   *
   * Policies are loaded fresh on every call (no caching), so a policy or role
   * change is reflected on the next resolution (Req 19.7).
   *
   * @param principal The authenticated actor.
   * @param resource The resource being acted on (its `type` is the permission's resource type).
   * @param action The action being attempted.
   * @returns The {@link PolicyDecision} — fail-closed unless an explicit Allow_List grant applies.
   */
  async resolve(
    principal: Principal,
    resource: ResourceRef,
    action: Action,
  ): Promise<PolicyDecision> {
    const ctx = tenantContextFromPrincipal(principal);
    const ids = scopeIdsForPrincipal(principal);

    // Independent reads per scope — issued together; resolution is fail-closed
    // regardless of how many policies exist.
    const [org, team, user] = await Promise.all([
      this.policies.findByScope(ctx, 'org', ids.org),
      this.policies.findByScope(ctx, 'team', ids.team),
      this.policies.findByScope(ctx, 'user', ids.user),
    ]);

    return decidePolicy({ org, team, user }, action, resource.type);
  }
}
