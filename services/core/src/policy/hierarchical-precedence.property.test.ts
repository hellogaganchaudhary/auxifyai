/**
 * Property-based test for **Property 4: Hierarchical policy precedence**
 * (design "Property 4"; Req 19.3).
 *
 * Validates: Requirements 19.3
 *
 * Requirement 19.3 states that when the Policy_Engine evaluates a permission it
 * applies Organization policies over Team policies over User policies, so that
 * an Organization decision overrides a conflicting Team decision and a Team
 * decision overrides a conflicting User decision. Property 4 generalizes this:
 * for ANY set of policies that assign (possibly conflicting) decisions for the
 * same `(action, resourceType)` at the org/team/user scopes, the resolved
 * decision equals that of the HIGHEST-precedence scope that actually decides,
 * and when no scope decides the result is default-deny (`decidingScope = null`).
 *
 * The strategy is the classic reference-oracle approach: an INDEPENDENT
 * reimplementation of the per-scope deciding rule (`oracleScope`) computes the
 * expected `(allowed, decidingScope)` for the first scope in `[org, team, user]`
 * that has a matching entry (with deny-wins-within-a-scope). We then assert that
 * both the pure `decidePolicy` algorithm and `PolicyEngine.resolve` (over the
 * in-memory fake SQL client) agree with the oracle. Generators are biased to
 * frequently produce matching entries — and a dedicated outcome-driven property
 * deliberately exercises silent higher scopes (fall-through) and conflicts where
 * a higher scope overrides a lower one.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  RESOURCE_TYPES,
  type Action,
  type Principal,
  type ResourceRef,
  type ResourceType,
} from '@auxify/types';

import { InMemoryPolicySqlClient } from './fakes.js';
import { PolicyEngine, decidePolicy } from './policy-engine.js';
import { PolicyRepository } from './policy-repository.js';
import {
  POLICY_SCOPE_PRECEDENCE,
  type AllowListEntry,
  type Policy,
  type PolicyEffect,
  type PolicyScope,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

/** Fixed scope ids so generated policies apply to the principal below. */
const ORG_ID = 'org-1';
const TEAM_ID = 'team-1';
const USER_ID = 'user-1';

/** Scope id used as the `scope_id` for each precedence level. */
const SCOPE_ID: Record<PolicyScope, string> = {
  org: ORG_ID,
  team: TEAM_ID,
  user: USER_ID,
};

// ---------------------------------------------------------------------------
// Independent oracle (a reference reimplementation of the deciding rule)
// ---------------------------------------------------------------------------

/** The permission a single resolution is about. */
interface Target {
  action: Action;
  resourceType: ResourceType;
}

/** The fields of a decision Property 4 constrains. */
interface ExpectedDecision {
  allowed: boolean;
  decidingScope: PolicyScope | null;
}

/**
 * Decide a single scope's outcome independently of the implementation: scan
 * every matching entry across the scope's policies; an explicit `deny` wins
 * (least privilege), otherwise a matching `allow` grants, and a scope with no
 * matching entry is silent (`null`).
 */
function oracleScope(
  policies: readonly Policy[],
  action: Action,
  resourceType: ResourceType,
): 'allow' | 'deny' | null {
  let sawAllow = false;
  for (const policy of policies) {
    for (const entry of policy.allowList) {
      const actionMatches = entry.action === '*' || entry.action === action;
      const resourceMatches = entry.resourceType === '*' || entry.resourceType === resourceType;
      if (!actionMatches || !resourceMatches) continue;
      if ((entry.effect ?? 'allow') === 'deny') return 'deny';
      sawAllow = true;
    }
  }
  return sawAllow ? 'allow' : null;
}

/**
 * The expected decision under Property 4: the outcome of the highest-precedence
 * scope (org > team > user) that decides; default-deny when none decides.
 */
function oracle(
  byScope: Readonly<Record<PolicyScope, readonly Policy[]>>,
  action: Action,
  resourceType: ResourceType,
): ExpectedDecision {
  for (const scope of POLICY_SCOPE_PRECEDENCE) {
    const outcome = oracleScope(byScope[scope], action, resourceType);
    if (outcome === null) continue;
    return { allowed: outcome === 'allow', decidingScope: scope };
  }
  return { allowed: false, decidingScope: null };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const targetArb: fc.Arbitrary<Target> = fc.record({
  action: fc.constantFrom<Action>(...ACTIONS),
  resourceType: fc.constantFrom<ResourceType>(...RESOURCE_TYPES),
});

/**
 * An Allow_List entry biased toward the target so matches (and therefore
 * cross-scope conflicts) are common: the action/resourceType is the target,
 * the wildcard `'*'`, or some other value, with an optional explicit effect.
 */
function entryArb(target: Target): fc.Arbitrary<AllowListEntry> {
  const actionArb: fc.Arbitrary<Action | '*'> = fc.oneof(
    fc.constant<Action | '*'>(target.action),
    fc.constant<Action | '*'>('*'),
    fc.constantFrom<Action>(...ACTIONS),
  );
  const resourceArb: fc.Arbitrary<ResourceType | '*'> = fc.oneof(
    fc.constant<ResourceType | '*'>(target.resourceType),
    fc.constant<ResourceType | '*'>('*'),
    fc.constantFrom<ResourceType>(...RESOURCE_TYPES),
  );
  // 'unset' models an absent `effect` (defaults to allow); mapping it away keeps
  // the entry's `effect` typed `PolicyEffect | undefined` (never `null`).
  const effectArb = fc.constantFrom<PolicyEffect | 'unset'>('allow', 'deny', 'unset');
  return fc
    .record({ action: actionArb, resourceType: resourceArb, effect: effectArb })
    .map(({ action, resourceType, effect }) => {
      const entry: AllowListEntry = { action, resourceType };
      if (effect !== 'unset') entry.effect = effect;
      return entry;
    });
}

/** Build `Policy[]` for a scope from a list of allow-lists (one per policy). */
function toPolicies(scope: PolicyScope, allowLists: AllowListEntry[][]): Policy[] {
  return allowLists.map((allowList, i) => ({
    id: `${scope}-${SCOPE_ID[scope]}-${i}`,
    organizationId: ORG_ID,
    scope,
    scopeId: SCOPE_ID[scope],
    allowList,
  }));
}

/** Raw allow-lists per scope before they are wrapped into policies. */
interface RawScopes {
  org: AllowListEntry[][];
  team: AllowListEntry[][];
  user: AllowListEntry[][];
}

function buildByScope(raw: RawScopes): Record<PolicyScope, Policy[]> {
  return {
    org: toPolicies('org', raw.org),
    team: toPolicies('team', raw.team),
    user: toPolicies('user', raw.user),
  };
}

/**
 * Arbitrary policies for all three scopes for a given target. Each scope holds
 * 0..3 policies of 0..4 entries; empty scopes (and scopes whose entries never
 * match) exercise fall-through to lower-precedence scopes.
 */
function byScopeArb(target: Target): fc.Arbitrary<Record<PolicyScope, Policy[]>> {
  const scopeArb = fc.array(fc.array(entryArb(target), { maxLength: 4 }), { maxLength: 3 });
  return fc.record({ org: scopeArb, team: scopeArb, user: scopeArb }).map(buildByScope);
}

/** A target paired with arbitrary policies that reference it. */
const targetWithPoliciesArb: fc.Arbitrary<[Target, Record<PolicyScope, Policy[]>]> =
  targetArb.chain((target) => fc.tuple(fc.constant(target), byScopeArb(target)));

// ---------------------------------------------------------------------------
// Outcome-driven generator (deliberately exercises override + fall-through)
// ---------------------------------------------------------------------------

/** What a scope should do for the target: grant, deny, or stay silent. */
type ScopeOutcome = 'allow' | 'deny' | 'silent';

/**
 * Produce one policy for a scope realizing the chosen outcome. `silent` yields
 * a present-but-non-matching policy so fall-through is tested with real (not
 * merely absent) policies.
 */
function entriesForOutcome(target: Target, outcome: ScopeOutcome): AllowListEntry[][] {
  if (outcome === 'allow') {
    return [[{ action: target.action, resourceType: target.resourceType, effect: 'allow' }]];
  }
  if (outcome === 'deny') {
    return [[{ action: target.action, resourceType: target.resourceType, effect: 'deny' }]];
  }
  // Silent: a policy whose only entry cannot match the target (different action
  // and resource type, neither a wildcard).
  const otherAction = ACTIONS.find((a) => a !== target.action)!;
  const otherResource = RESOURCE_TYPES.find((r) => r !== target.resourceType)!;
  return [[{ action: otherAction, resourceType: otherResource }]];
}

/** The expected decision for a per-scope outcome assignment. */
function expectedForOutcomes(outcomes: Record<PolicyScope, ScopeOutcome>): ExpectedDecision {
  for (const scope of POLICY_SCOPE_PRECEDENCE) {
    if (outcomes[scope] === 'silent') continue;
    return { allowed: outcomes[scope] === 'allow', decidingScope: scope };
  }
  return { allowed: false, decidingScope: null };
}

const outcomeArb = fc.constantFrom<ScopeOutcome>('allow', 'deny', 'silent');

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

function principalForTarget(): Principal {
  return {
    userId: USER_ID,
    organizationId: ORG_ID,
    roles: ['standard_user'],
    teamIds: [TEAM_ID],
    projectIds: ['project-1'],
    allowedModels: [],
    premiumAuthorized: false,
  };
}

function resourceForTarget(target: Target): ResourceRef {
  return { type: target.resourceType, id: 'resource-1', organizationId: ORG_ID };
}

/** Persist every generated policy into a fresh fake client and build an engine. */
async function engineWith(byScope: Record<PolicyScope, Policy[]>): Promise<PolicyEngine> {
  const sql = new InMemoryPolicySqlClient();
  const repo = new PolicyRepository(sql);
  const ctx = { organizationId: ORG_ID, userId: 'admin' };
  for (const scope of POLICY_SCOPE_PRECEDENCE) {
    for (const policy of byScope[scope]) {
      await repo.create(ctx, {
        id: policy.id,
        scope: policy.scope,
        scopeId: policy.scopeId,
        allowList: policy.allowList,
      });
    }
  }
  return new PolicyEngine({ sql });
}

// ---------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 4: Hierarchical policy precedence', () => {
  it('decidePolicy resolves to the highest-precedence deciding scope for arbitrary policies (Validates: Requirements 19.3)', () => {
    fc.assert(
      fc.property(targetWithPoliciesArb, ([target, byScope]) => {
        const expected = oracle(byScope, target.action, target.resourceType);
        const decision = decidePolicy(byScope, target.action, target.resourceType);
        expect(decision.allowed).toBe(expected.allowed);
        expect(decision.decidingScope).toBe(expected.decidingScope);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('PolicyEngine.resolve agrees with the precedence oracle over stored policies (Validates: Requirements 19.3)', async () => {
    await fc.assert(
      fc.asyncProperty(targetWithPoliciesArb, async ([target, byScope]) => {
        const expected = oracle(byScope, target.action, target.resourceType);
        const engine = await engineWith(byScope);
        const decision = await engine.resolve(
          principalForTarget(),
          resourceForTarget(target),
          target.action,
        );
        expect(decision.allowed).toBe(expected.allowed);
        expect(decision.decidingScope).toBe(expected.decidingScope);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a higher scope overrides a conflicting lower scope and silent scopes fall through (Validates: Requirements 19.3)', () => {
    fc.assert(
      fc.property(
        targetArb,
        fc.record({ org: outcomeArb, team: outcomeArb, user: outcomeArb }),
        (target, outcomes) => {
          const byScope = buildByScope({
            org: entriesForOutcome(target, outcomes.org),
            team: entriesForOutcome(target, outcomes.team),
            user: entriesForOutcome(target, outcomes.user),
          });
          const expected = expectedForOutcomes(outcomes);
          const decision = decidePolicy(byScope, target.action, target.resourceType);
          expect(decision.allowed).toBe(expected.allowed);
          expect(decision.decidingScope).toBe(expected.decidingScope);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
