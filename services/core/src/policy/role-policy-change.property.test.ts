/**
 * Property-based test — Property 5: Role and policy changes apply to subsequent
 * requests (Req 19.7).
 *
 * Validates: Requirements 19.7
 *
 * Req 19.7: "WHEN an administrator changes a user's role or policy, THE
 * Access_Control SHALL apply the updated permissions to the user's subsequent
 * requests." The mechanism behind this in the Policy_Engine is *freshness*:
 * `PolicyEngine.resolve` reads policies through the {@link PolicyRepository} on
 * every call and holds no cache, so any change made between two calls is
 * reflected on the next resolution.
 *
 * ## What this property asserts
 *
 * For an ARBITRARY sequence of mutations (policy additions and role changes)
 * interleaved with resolution checkpoints, EACH `resolve()` must return the
 * decision implied by the policy/role state **at that moment** — never a stale
 * or cached earlier decision. We verify this two ways at every checkpoint:
 *
 *   1. *Semantic freshness* — an independent oracle (re-implementing the
 *      documented Organization > Team > User precedence + default-deny over the
 *      policy set and principal as they exist right now) computes the expected
 *      decision, and `engine.resolve` must match it exactly (`allowed` and
 *      `decidingScope`).
 *   2. *Mechanical freshness* — the in-memory SQL client captures every issued
 *      statement; we assert each `resolve()` issues fresh SELECTs (the read
 *      count strictly increases) and that the total number of reads equals the
 *      sum of the per-resolve fresh reads, so no caching can mask a change.
 *
 * ## Modeling "a role/policy change" without update/delete APIs
 *
 * {@link PolicyRepository} only exposes `create` (no update/delete), so changes
 * are modeled with the two levers an administrator actually has, both of which
 * genuinely exercise "the change applies on the next request":
 *
 *   - **Policy change** — `create` a new policy. Because resolution is by
 *     precedence, a later higher-precedence `deny` overrides an earlier
 *     lower-scope `allow` (grant-then-revoke), and a later grant flips an
 *     earlier default-deny (revoke-then-grant). The next resolve must reflect
 *     the latest policy set.
 *   - **Role change** — change the principal's team membership (`teamIds`)
 *     between resolves. Team membership is the resolution-affecting facet of a
 *     role change: it changes which team-scope policies apply, so a team-scope
 *     grant/deny "appears" or "disappears" for the user. Dropping a team is how
 *     an effective revocation is modeled when there is no delete API.
 *
 * The test talks to the {@link InMemoryPolicySqlClient}, so it inspects exactly
 * the reads that would hit PostgreSQL without a live database. It does NOT
 * import `decidePolicy`; the oracle is an independent re-implementation, so the
 * test validates the engine + repository wiring (and freshness), not a function
 * compared against itself.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Action, Principal, ResourceRef, ResourceType, TenantContext } from '@auxify/types';

import { InMemoryPolicySqlClient } from './fakes.js';
import { PolicyEngine } from './policy-engine.js';
import { PolicyRepository } from './policy-repository.js';
import {
  POLICY_SCOPE_PRECEDENCE,
  type AllowListEntry,
  type Policy,
  type PolicyScope,
} from './types.js';

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Fixed tenant space — small pools so mutations and role changes interact.
// ---------------------------------------------------------------------------

const ORG = 'org-1';
const USER = 'user-1';
const TEAM_POOL = ['team-A', 'team-B', 'team-C'] as const;

/** Actions/resource types drawn from small pools so matches occur frequently. */
const ACTION_POOL: readonly Action[] = ['read', 'update', 'delete'] as const;
const RESOURCE_POOL: readonly ResourceType[] = ['conversation', 'document', 'message'] as const;

/** The administrative context used to persist policies. */
const ADMIN_CTX: TenantContext = { organizationId: ORG, userId: 'admin-1' };

function basePrincipal(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    roles: ['standard_user'],
    teamIds: [],
    projectIds: [],
    allowedModels: [],
    premiumAuthorized: false,
  };
}

function resourceOf(type: ResourceType): ResourceRef {
  return { type, id: 'res-1', organizationId: ORG };
}

// ---------------------------------------------------------------------------
// Independent oracle: documented precedence + default-deny over the CURRENT
// policy set and principal. (Deliberately not importing decidePolicy.)
// ---------------------------------------------------------------------------

function entryMatches(entry: AllowListEntry, action: Action, resourceType: ResourceType): boolean {
  const actionMatches = entry.action === '*' || entry.action === action;
  const resourceMatches = entry.resourceType === '*' || entry.resourceType === resourceType;
  return actionMatches && resourceMatches;
}

/** A scope decides `allow`/`deny` (deny wins within a scope) or is silent (`null`). */
function scopeOutcome(
  policies: readonly Policy[],
  action: Action,
  resourceType: ResourceType,
): 'allow' | 'deny' | null {
  let sawAllow = false;
  for (const policy of policies) {
    for (const entry of policy.allowList) {
      if (!entryMatches(entry, action, resourceType)) continue;
      if ((entry.effect ?? 'allow') === 'deny') return 'deny';
      sawAllow = true;
    }
  }
  return sawAllow ? 'allow' : null;
}

interface ExpectedDecision {
  allowed: boolean;
  decidingScope: PolicyScope | null;
}

/** Expected decision for the policy set + principal exactly as they are now. */
function expectedDecision(
  model: readonly Policy[],
  principal: Principal,
  action: Action,
  resourceType: ResourceType,
): ExpectedDecision {
  const idsByScope: Record<PolicyScope, readonly string[]> = {
    org: [principal.organizationId],
    team: principal.teamIds,
    user: [principal.userId],
  };
  for (const scope of POLICY_SCOPE_PRECEDENCE) {
    const applicable = model.filter(
      (p) =>
        p.organizationId === principal.organizationId &&
        p.scope === scope &&
        idsByScope[scope].includes(p.scopeId),
    );
    const outcome = scopeOutcome(applicable, action, resourceType);
    if (outcome === null) continue;
    return { allowed: outcome === 'allow', decidingScope: scope };
  }
  return { allowed: false, decidingScope: null };
}

/** Number of SELECT statements the engine has issued so far. */
function selectCount(sql: InMemoryPolicySqlClient): number {
  return sql.queries.filter((q) => q.text.replace(/\s+/g, ' ').trim().startsWith('SELECT')).length;
}

/** Fresh reads a single resolve issues: org + user always, team only when a member. */
function expectedReadsForResolve(principal: Principal): number {
  return 2 + (principal.teamIds.length > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const allowListEntryArb: fc.Arbitrary<AllowListEntry> = fc
  .record({
    action: fc.constantFrom<Action | '*'>('read', 'update', 'delete', '*'),
    resourceType: fc.constantFrom<ResourceType | '*'>('conversation', 'document', 'message', '*'),
    effect: fc.constantFrom<'allow' | 'deny' | 'unset'>('allow', 'deny', 'unset'),
  })
  .map(({ action, resourceType, effect }) => {
    const entry: AllowListEntry = { action, resourceType };
    if (effect !== 'unset') entry.effect = effect;
    return entry;
  });

interface AddPolicyMutation {
  kind: 'addPolicy';
  scope: PolicyScope;
  scopeId: string;
  allowList: AllowListEntry[];
}

interface ChangeRoleMutation {
  kind: 'changeRole';
  teamIds: string[];
}

type Mutation = AddPolicyMutation | ChangeRoleMutation;

const addPolicyArb: fc.Arbitrary<AddPolicyMutation> = fc
  .record({
    scope: fc.constantFrom<PolicyScope>('org', 'team', 'user'),
    team: fc.constantFrom(...TEAM_POOL),
    allowList: fc.array(allowListEntryArb, { minLength: 1, maxLength: 3 }),
  })
  .map(({ scope, team, allowList }) => ({
    kind: 'addPolicy' as const,
    scope,
    scopeId: scope === 'org' ? ORG : scope === 'team' ? team : USER,
    allowList,
  }));

const changeRoleArb: fc.Arbitrary<ChangeRoleMutation> = fc
  .subarray([...TEAM_POOL])
  .map((teamIds) => ({ kind: 'changeRole' as const, teamIds }));

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(addPolicyArb, changeRoleArb);

interface Checkpoint {
  action: Action;
  resourceType: ResourceType;
}

const checkpointArb: fc.Arbitrary<Checkpoint> = fc.record({
  action: fc.constantFrom(...ACTION_POOL),
  resourceType: fc.constantFrom(...RESOURCE_POOL),
});

interface Step {
  mutation: Mutation;
  checkpoints: Checkpoint[];
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  mutation: mutationArb,
  checkpoints: fc.array(checkpointArb, { minLength: 1, maxLength: 3 }),
});

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 5: Role and policy changes apply to subsequent requests', () => {
  it('reflects every interleaved policy/role change on the next resolution, reading fresh each time (Validates: Requirements 19.7)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 8 }), async (steps) => {
        const sql = new InMemoryPolicySqlClient();
        const engine = new PolicyEngine({ sql });
        const repo = new PolicyRepository(sql);

        // The model state the oracle tracks: policies created so far and the
        // principal as the simulated administrator has most recently set it.
        const model: Policy[] = [];
        let principal = basePrincipal();
        let policyCounter = 0;
        let expectedTotalReads = 0;

        for (const step of steps) {
          // 1) Apply the administrator's change.
          if (step.mutation.kind === 'addPolicy') {
            const id = `p-${policyCounter++}`;
            await repo.create(ADMIN_CTX, {
              id,
              scope: step.mutation.scope,
              scopeId: step.mutation.scopeId,
              allowList: step.mutation.allowList,
            });
            model.push({
              id,
              organizationId: ORG,
              scope: step.mutation.scope,
              scopeId: step.mutation.scopeId,
              allowList: step.mutation.allowList,
            });
          } else {
            // A role change: update which teams the user belongs to.
            principal = { ...principal, teamIds: step.mutation.teamIds };
          }

          // 2) Every subsequent request must reflect the change immediately.
          for (const cp of step.checkpoints) {
            const readsBefore = selectCount(sql);

            const decision = await engine.resolve(
              principal,
              resourceOf(cp.resourceType),
              cp.action,
            );
            const expected = expectedDecision(model, principal, cp.action, cp.resourceType);

            // Semantic freshness: matches the state at this exact moment.
            expect(decision.allowed).toBe(expected.allowed);
            expect(decision.decidingScope).toBe(expected.decidingScope);

            // Mechanical freshness: this resolve issued fresh reads (no cache).
            const readsAfter = selectCount(sql);
            expect(readsAfter).toBeGreaterThan(readsBefore);
            expect(readsAfter - readsBefore).toBe(expectedReadsForResolve(principal));
            expectedTotalReads += expectedReadsForResolve(principal);
          }
        }

        // Across the whole sequence the engine re-read exactly per resolve —
        // nothing was served from a cache that could mask a change.
        expect(selectCount(sql)).toBe(expectedTotalReads);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
