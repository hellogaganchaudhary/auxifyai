/**
 * Feature: auxify-ai-platform, Property 2: Fail-closed default-deny authorization.
 *
 * Validates: Requirements 1.3, 19.2, 19.4, 19.8, 34.2, 34.8, 45.2, 45.4
 *
 * The platform authorizes fail-closed: `AccessControl.authorize` returns
 * _allow_ **if and only if** an explicit Allow_List entry (resolved through the
 * Policy_Engine, Req 19.2/19.4/19.8) grants the permission **and** the resource
 * belongs to an Organization/Team/Project the principal is a member of
 * (Req 1.3), **and** the viewer/model-tier preconditions hold (Req 19.5/19.6).
 * In every other case — no resolving policy, a cross-tenant reference, or any
 * unmet precondition — the decision is _deny_, and every denial is audited
 * exactly once (Req 19.4).
 *
 * This property pins down that biconditional over arbitrary
 * (principal, resource, action, options, policy-grant) inputs:
 *
 *   - **Default-deny (Req 19.2/19.8).** Under an empty/deny Policy_Engine (no
 *     grants), `authorize` denies for *every* generated input — authorization
 *     defaults to deny.
 *   - **Membership precedence (Req 1.3).** A cross-tenant reference (a resource
 *     in an Organization/Team/Project the principal does not belong to) is
 *     denied regardless of any Allow_List grant, and the Policy_Engine is not
 *     even consulted.
 *   - **Biconditional.** Driving the Policy_Engine's verdict with a
 *     {@link FakePolicyResolver}, `authorize` allows exactly when the
 *     conjunction (membership ∧ explicit grant ∧ viewer/tier preconditions)
 *     holds; negating any single conjunct flips the decision to deny. The
 *     expected outcome is computed by an independent reference oracle.
 *   - **Audit (Req 19.4).** Every denial — at any stage — produces exactly one
 *     `access.denied` audit record (coupled to the {@link CapturingAuditRecorder});
 *     an allowed access records nothing.
 *
 * Requirements 34.2/34.8 (Security_Gateway authenticate-before-route /
 * default-deny on an unauthenticated or unauthorized edge request) and
 * 45.2/45.4 (REST API authentication / default-deny) are the *same*
 * default-deny principle applied at the gateway and REST layers; those layers
 * (built in tasks 20.5 / 24.1) enforce it structurally, so here we validate the
 * shared Access_Control `authorize()` default-deny biconditional that they
 * delegate to.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  RESOURCE_TYPES,
  ROLES,
  type Action,
  type ModelInfo,
  type ModelTier,
  type Principal,
  type ResourceRef,
  type Role,
} from '@auxify/types';

import { AccessControl, type AuthorizeOptions } from './index.js';
import {
  CapturingAuditRecorder,
  denyingPolicyResolver,
  grantingPolicyResolver,
  makeModel,
} from './fakes.js';

/** Minimum generated iterations per property (>= 100). */
const NUM_RUNS = 300;

// ---------------------------------------------------------------------------
// Bounded value pools.
//
// Drawing principal memberships and resource scopes from the *same* small
// pools makes the "membership holds" case reachable a good fraction of the
// time, so the biconditional is exercised on both allowed and denied inputs
// (rather than degenerating into all-deny). The cross-tenant generator instead
// uses sentinel ids guaranteed to fall *outside* these pools.
// ---------------------------------------------------------------------------

const ORG_IDS = ['org-1', 'org-2'] as const;
const TEAM_IDS = ['team-1', 'team-2', 'team-3'] as const;
const PROJECT_IDS = ['project-1', 'project-2', 'project-3'] as const;
const MODEL_IDS = ['model-a', 'model-b', 'model-c'] as const;

/** A short non-empty identifier fragment. */
const idArb = fc.string({ minLength: 1, maxLength: 12 });

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

const principalArb: fc.Arbitrary<Principal> = fc.record({
  userId: idArb.map((s) => `user-${s}`),
  organizationId: fc.constantFrom(...ORG_IDS),
  roles: fc.uniqueArray(fc.constantFrom<Role>(...ROLES), { minLength: 1, maxLength: 3 }),
  teamIds: fc.uniqueArray(fc.constantFrom(...TEAM_IDS), { maxLength: 3 }),
  projectIds: fc.uniqueArray(fc.constantFrom(...PROJECT_IDS), { maxLength: 3 }),
  allowedModels: fc.uniqueArray(fc.constantFrom(...MODEL_IDS), { maxLength: 3 }),
  premiumAuthorized: fc.boolean(),
});

const resourceArb: fc.Arbitrary<ResourceRef> = fc.record({
  type: fc.constantFrom(...RESOURCE_TYPES),
  id: idArb.map((s) => `res-${s}`),
  organizationId: fc.constantFrom(...ORG_IDS),
  teamId: fc.option(fc.constantFrom(...TEAM_IDS), { nil: undefined }),
  projectId: fc.option(fc.constantFrom(...PROJECT_IDS), { nil: undefined }),
});

const modelArb: fc.Arbitrary<ModelInfo> = fc
  .record({
    id: fc.constantFrom(...MODEL_IDS),
    tier: fc.constantFrom<ModelTier>('economy', 'standard', 'premium'),
  })
  .map(({ id, tier }) => makeModel(tier, { id }));

const optionsArb: fc.Arbitrary<AuthorizeOptions> = fc.record({
  model: fc.option(modelArb, { nil: undefined }),
  shared: fc.option(fc.boolean(), { nil: undefined }),
});

/** A complete authorization scenario, including the Policy_Engine's verdict. */
interface Scenario {
  principal: Principal;
  resource: ResourceRef;
  action: Action;
  options: AuthorizeOptions;
  /** Whether the (faked) Policy_Engine grants an explicit Allow_List entry. */
  policyGrant: boolean;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  principal: principalArb,
  resource: resourceArb,
  action: fc.constantFrom(...ACTIONS),
  options: optionsArb,
  policyGrant: fc.boolean(),
});

/**
 * A scenario whose resource is *guaranteed* cross-tenant relative to the
 * principal: it violates the Organization, Team, or Project membership check
 * via sentinel ids that fall outside {@link TEAM_IDS}/{@link PROJECT_IDS}.
 */
const crossTenantScenarioArb: fc.Arbitrary<Scenario> = principalArb.chain((principal) =>
  fc
    .record({
      violation: fc.constantFrom('org', 'team', 'project'),
      type: fc.constantFrom(...RESOURCE_TYPES),
      id: idArb.map((s) => `res-${s}`),
      action: fc.constantFrom(...ACTIONS),
      options: optionsArb,
      policyGrant: fc.boolean(),
    })
    .map(({ violation, type, id, action, options, policyGrant }): Scenario => {
      let resource: ResourceRef;
      if (violation === 'org') {
        resource = { type, id, organizationId: `${principal.organizationId}-foreign` };
      } else if (violation === 'team') {
        resource = { type, id, organizationId: principal.organizationId, teamId: 'team-outsider' };
      } else {
        resource = {
          type,
          id,
          organizationId: principal.organizationId,
          projectId: 'project-outsider',
        };
      }
      return { principal, resource, action, options, policyGrant };
    }),
);

// ---------------------------------------------------------------------------
// Reference oracle.
//
// Computed independently from the staged short-circuit implementation, this
// expresses Property 2's logical conjunction directly: allow IFF every
// fail-closed precondition holds. Equality between this oracle and the
// composed AccessControl pipeline is exactly the biconditional under test.
// ---------------------------------------------------------------------------

const VIEWER_READ_ONLY: ReadonlySet<Action> = new Set<Action>(['read', 'list']);
const VIEWER_SHAREABLE: ReadonlySet<ResourceRef['type']> = new Set<ResourceRef['type']>([
  'conversation',
  'prompt_template',
]);

/** Independent restatement of "is this principal a viewer" (Req 19.6). */
function principalIsViewer(principal: Principal): boolean {
  return principal.roles.includes('viewer');
}

/** True IFF the resource is within a tenant scope the principal belongs to (Req 1.3). */
function membershipHolds(principal: Principal, resource: ResourceRef): boolean {
  if (resource.organizationId !== principal.organizationId) return false;
  if (resource.teamId !== undefined && !principal.teamIds.includes(resource.teamId)) return false;
  if (resource.projectId !== undefined && !principal.projectIds.includes(resource.projectId)) {
    return false;
  }
  return true;
}

/** True IFF the viewer resource restriction admits the access (Req 19.6). */
function viewerResourceOk(
  principal: Principal,
  resource: ResourceRef,
  action: Action,
  options: AuthorizeOptions,
): boolean {
  if (!principalIsViewer(principal)) return true;
  if (!VIEWER_READ_ONLY.has(action)) return false;
  if (VIEWER_SHAREABLE.has(resource.type) && options.shared !== true) return false;
  return true;
}

/** True IFF the model-tier gates admit the model (Req 19.5, 19.6, 20.6). */
function modelGatesOk(principal: Principal, options: AuthorizeOptions): boolean {
  const model = options.model;
  if (model === undefined) return true;
  if (principalIsViewer(principal) && model.tier !== 'economy') return false;
  if (model.tier === 'premium' && !principal.premiumAuthorized) return false;
  if (principal.allowedModels.length > 0 && !principal.allowedModels.includes(model.id)) {
    return false;
  }
  return true;
}

/** The expected fail-closed verdict: allow IFF every precondition conjunct holds. */
function expectAllowed(scenario: Scenario): boolean {
  const { principal, resource, action, options, policyGrant } = scenario;
  return (
    membershipHolds(principal, resource) &&
    policyGrant &&
    viewerResourceOk(principal, resource, action, options) &&
    modelGatesOk(principal, options)
  );
}

/** Build an Access_Control whose Policy_Engine grants/denies per `policyGrant`. */
function makeAc(policyGrant: boolean): { ac: AccessControl; audit: CapturingAuditRecorder } {
  const audit = new CapturingAuditRecorder();
  const policyEngine = policyGrant ? grantingPolicyResolver() : denyingPolicyResolver();
  return { ac: new AccessControl({ policyEngine, auditRecorder: audit }), audit };
}

// ---------------------------------------------------------------------------
// Property 2.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 2: Fail-closed default-deny authorization', () => {
  it('denies every access under an empty/deny Policy_Engine, auditing each denial once (Validates: Requirements 1.3, 19.2, 19.4, 19.8, 34.2, 34.8, 45.2, 45.4)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { ac, audit } = makeAc(false); // no Allow_List grants — default-deny

        const decision = await ac.authorize(
          scenario.principal,
          scenario.resource,
          scenario.action,
          scenario.options,
        );

        // Authorization defaults to deny: with no grant, nothing is ever allowed.
        expect(decision.allowed).toBe(false);
        expect(decision.denialCode).toBeDefined();

        // Every denial is audited exactly once as an `access.denied` event.
        expect(audit.count).toBe(1);
        const { event } = audit.recorded[0]!;
        expect(event.action).toBe('access.denied');
        expect(event.actorId).toBe(scenario.principal.userId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('denies a cross-tenant reference regardless of any Allow_List grant, without consulting the Policy_Engine (Validates: Requirements 1.3, 19.4)', async () => {
    await fc.assert(
      fc.asyncProperty(crossTenantScenarioArb, async (scenario) => {
        const audit = new CapturingAuditRecorder();
        // A resolver that *grants* everything — membership must still take
        // precedence and deny the cross-tenant reference (Req 1.3).
        const policyEngine = grantingPolicyResolver();
        const ac = new AccessControl({ policyEngine, auditRecorder: audit });

        const decision = await ac.authorize(
          scenario.principal,
          scenario.resource,
          scenario.action,
          scenario.options,
        );

        expect(decision.allowed).toBe(false);
        expect(decision.denialCode).toBe('cross_tenant');

        // Fail-fast: the Allow_List grant is never even resolved.
        expect(policyEngine.calls).toHaveLength(0);

        // Audited once, scoped to the actor's Organization.
        expect(audit.count).toBe(1);
        const { ctx, event } = audit.recorded[0]!;
        expect(event.action).toBe('access.denied');
        expect(ctx.organizationId).toBe(scenario.principal.organizationId);
        expect(event.metadata).toMatchObject({ denialCode: 'cross_tenant' });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('allows IFF (membership ∧ explicit Allow_List grant ∧ viewer/tier preconditions) — negating any conjunct denies (Validates: Requirements 1.3, 19.2, 19.4, 19.8, 34.2, 34.8, 45.2, 45.4)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { ac, audit } = makeAc(scenario.policyGrant);

        const decision = await ac.authorize(
          scenario.principal,
          scenario.resource,
          scenario.action,
          scenario.options,
        );

        // The biconditional: the composed pipeline equals the conjunction oracle.
        expect(decision.allowed).toBe(expectAllowed(scenario));

        if (decision.allowed) {
          // An allow records nothing and carries the granting policy decision.
          expect(audit.count).toBe(0);
          expect(decision.policyDecision?.allowed).toBe(true);
        } else {
          // Every denial names its fail-closed stage and is audited exactly once.
          expect(decision.denialCode).toBeDefined();
          expect(audit.count).toBe(1);
          expect(audit.recorded[0]!.event.action).toBe('access.denied');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('uses a controllable Policy_Engine so flipping ONLY the grant flips the decision when all other conjuncts hold (Validates: Requirements 19.2, 19.4, 19.8)', async () => {
    // Restrict to scenarios where membership and viewer/tier preconditions hold,
    // isolating the explicit Allow_List grant as the sole remaining conjunct.
    const grantPivotArb = scenarioArb.filter(
      (s) =>
        membershipHolds(s.principal, s.resource) &&
        viewerResourceOk(s.principal, s.resource, s.action, s.options) &&
        modelGatesOk(s.principal, s.options),
    );

    await fc.assert(
      fc.asyncProperty(grantPivotArb, async (scenario) => {
        const granted = makeAc(true);
        const denied = makeAc(false);

        const allowDecision = await granted.ac.authorize(
          scenario.principal,
          scenario.resource,
          scenario.action,
          scenario.options,
        );
        const denyDecision = await denied.ac.authorize(
          scenario.principal,
          scenario.resource,
          scenario.action,
          scenario.options,
        );

        // With every other conjunct satisfied, the explicit grant is decisive.
        expect(allowDecision.allowed).toBe(true);
        expect(denyDecision.allowed).toBe(false);
        expect(denyDecision.denialCode).toBe('policy_denied');

        // Default-deny still audits its single denial; the allow audits nothing.
        expect(granted.audit.count).toBe(0);
        expect(denied.audit.count).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
