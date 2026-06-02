/**
 * Domain types for the Policy_Engine (Req 19).
 *
 * The Policy_Engine is the first guard of the fail-closed decision pipeline
 * (design "Fail-Closed Decision Pipeline"). It resolves hierarchical policies
 * with **Organization > Team > User** precedence (Req 19.3) and is
 * **default-deny**: a permission is granted only by an explicit Allow_List
 * entry, never inferred from the absence of a policy (Req 19.2, 19.8).
 *
 * These types mirror the `policies` table (migration 0002): a {@link Policy} is
 * Organization-scoped and holds an {@link AllowListEntry} list keyed to a
 * {@link PolicyScope} (`org`/`team`/`user`) and a `scopeId` (the Organization,
 * Team, or User the policy applies to).
 */

import type { Action, ResourceType } from '@auxify/types';

/**
 * The level a policy applies at. Precedence runs Organization > Team > User
 * (Req 19.3): a higher-precedence scope's decision overrides a lower one's for
 * the same permission.
 */
export type PolicyScope = 'org' | 'team' | 'user';

/**
 * The scopes in descending precedence order (Organization first), used to
 * resolve conflicting decisions to the highest-precedence scope present
 * (Req 19.3).
 */
export const POLICY_SCOPE_PRECEDENCE: readonly PolicyScope[] = ['org', 'team', 'user'] as const;

/**
 * The effect of an {@link AllowListEntry} on a matched permission.
 *
 * `allow` grants the permission; `deny` explicitly withholds it. Because the
 * engine is default-deny (Req 19.2), the meaningful, access-granting effect is
 * `allow`; an explicit `deny` lets a scope withhold a permission that a
 * lower-precedence scope might otherwise have granted, and within a single
 * scope it overrides a co-located `allow` (least privilege).
 */
export type PolicyEffect = 'allow' | 'deny';

/**
 * A single Allow_List grant (or explicit denial) for an `action` on a
 * `resourceType` (Req 19.2). The wildcard `'*'` matches every action and/or
 * every resource type, so a broad grant need not enumerate the full matrix.
 *
 * `effect` defaults to `allow` (the common, access-granting case); set it to
 * `deny` to explicitly withhold the matched permission.
 */
export interface AllowListEntry {
  /** The action this entry covers, or `'*'` for every action. */
  action: Action | '*';
  /** The resource type this entry covers, or `'*'` for every resource type. */
  resourceType: ResourceType | '*';
  /** Whether the entry grants (`allow`, default) or withholds (`deny`) the permission. */
  effect?: PolicyEffect;
}

/**
 * An Organization-scoped policy holding the Allow_List evaluated by the
 * Policy_Engine (Req 19.3). The `scope`/`scopeId` pair identifies whom the
 * policy applies to: the Organization itself (`org`), a Team (`team`), or a
 * User (`user`).
 */
export interface Policy {
  /** The policy's stable id. */
  id: string;
  /** The owning Organization (the tenant key). */
  organizationId: string;
  /** The precedence level the policy applies at. */
  scope: PolicyScope;
  /**
   * The id of the Organization, Team, or User the policy applies to, matched
   * against the requesting principal.
   */
  scopeId: string;
  /** The Allow_List grants/denials evaluated for a permission. */
  allowList: AllowListEntry[];
}

/**
 * The outcome of a Policy_Engine resolution (the design's `PolicyDecision`).
 *
 * `allowed` is `true` only when an explicit Allow_List entry grants the
 * permission at the resolved scope; in every other case — an explicit deny, or
 * no applicable policy at all — it is `false` (Req 19.2, 19.8). `decidingScope`
 * names the precedence level that produced the decision, or `null` when nothing
 * resolved (the default-deny path).
 */
export interface PolicyDecision {
  /** Whether the permission is granted. Fail-closed: `false` unless explicitly allowed. */
  allowed: boolean;
  /** A human-readable explanation of why the decision was reached. */
  reason: string;
  /** The scope that decided the outcome, or `null` for the default-deny path. */
  decidingScope: PolicyScope | null;
}
