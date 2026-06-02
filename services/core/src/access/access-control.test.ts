/**
 * Unit tests for Access_Control (Req 1.3, 1.7, 19.4, 19.5, 19.6).
 *
 * These exercise the full fail-closed pipeline through {@link AccessControl}:
 *   - membership pass/fail and cross-tenant denial + audit (Req 1.3, 1.7);
 *   - Allow_List grant/deny via the Policy_Engine and the audited denial
 *     (Req 19.2, 19.4, 19.8) — verified both with a {@link FakePolicyResolver}
 *     and with the *real* {@link PolicyEngine} over an in-memory SQL client;
 *   - Premium-model gating (Req 19.5);
 *   - viewer resource and model restrictions (Req 19.6);
 *   - that every denial — at any stage — is recorded exactly once through the
 *     AuditRecorder port, and that allowed accesses audit nothing (Req 1.7).
 */

import { describe, expect, it } from 'vitest';

import type { Action, ResourceRef } from '@auxify/types';

import { PolicyEngine } from '../policy/index.js';
import { InMemoryPolicySqlClient } from '../policy/fakes.js';
import { PolicyRepository } from '../policy/policy-repository.js';
import { AccessControl } from './access-control.js';
import { AccessDeniedError } from './errors.js';
import {
  CapturingAuditRecorder,
  denyingPolicyResolver,
  FakePolicyResolver,
  grantingPolicyResolver,
  makeModel,
  makePrincipal,
  makeResource,
} from './fakes.js';

const READ: Action = 'read';

/** Build an Access_Control over a granting policy resolver + capturing audit. */
function makeAccessControl(policyEngine = grantingPolicyResolver()): {
  ac: AccessControl;
  audit: CapturingAuditRecorder;
  policyEngine: FakePolicyResolver;
} {
  const audit = new CapturingAuditRecorder();
  const ac = new AccessControl({ policyEngine, auditRecorder: audit });
  return { ac, audit, policyEngine };
}

// ---------------------------------------------------------------------------
// Stage 1 — membership / cross-tenant (Req 1.3, 1.7)
// ---------------------------------------------------------------------------

describe('AccessControl — membership and cross-tenant (Req 1.3, 1.7)', () => {
  it('permits access to a resource in the principal\u2019s Organization/Team/Project', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ teamIds: ['team-1'], projectIds: ['project-1'] }),
      makeResource({ teamId: 'team-1', projectId: 'project-1' }),
      READ,
    );
    expect(decision.allowed).toBe(true);
    expect(audit.count).toBe(0);
  });

  it('denies and audits a reference to another Organization', async () => {
    const { ac, audit } = makeAccessControl();
    const principal = makePrincipal({ organizationId: 'org-1' });
    const resource = makeResource({ organizationId: 'org-2' });

    const decision = await ac.authorize(principal, resource, READ);

    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('cross_tenant');
    // Audited once, scoped to the *actor's* Organization (not the target's).
    expect(audit.count).toBe(1);
    const { ctx, event } = audit.recorded[0]!;
    expect(ctx.organizationId).toBe('org-1');
    expect(event.action).toBe('access.denied');
    expect(event.actorId).toBe(principal.userId);
    expect(event.metadata).toMatchObject({
      attemptedAction: READ,
      denialCode: 'cross_tenant',
      resourceOrganizationId: 'org-2',
    });
  });

  it('denies and audits a reference to a Team the principal does not belong to', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ teamIds: ['team-1'] }),
      makeResource({ teamId: 'team-9' }),
      READ,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('cross_tenant');
    expect(audit.count).toBe(1);
  });

  it('denies and audits a reference to a Project the principal cannot access', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ projectIds: ['project-1'] }),
      makeResource({ projectId: 'project-9' }),
      READ,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('cross_tenant');
    expect(audit.count).toBe(1);
  });

  it('does not even consult the Policy_Engine on a cross-tenant reference (fail fast)', async () => {
    const policyEngine = grantingPolicyResolver();
    const { ac } = makeAccessControl(policyEngine);
    await ac.authorize(makePrincipal(), makeResource({ organizationId: 'org-2' }), READ);
    expect(policyEngine.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — Allow_List via the Policy_Engine (Req 19.2, 19.4, 19.8)
// ---------------------------------------------------------------------------

describe('AccessControl — Allow_List via the Policy_Engine (Req 19.4)', () => {
  it('grants when the Policy_Engine grants', async () => {
    const { ac, audit } = makeAccessControl(grantingPolicyResolver());
    const decision = await ac.authorize(makePrincipal(), makeResource(), READ);
    expect(decision.allowed).toBe(true);
    expect(decision.policyDecision?.allowed).toBe(true);
    expect(audit.count).toBe(0);
  });

  it('denies and audits when the Policy_Engine denies (default-deny)', async () => {
    const { ac, audit } = makeAccessControl(denyingPolicyResolver());
    const decision = await ac.authorize(makePrincipal(), makeResource(), READ);
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('policy_denied');
    expect(decision.policyDecision?.allowed).toBe(false);
    expect(audit.count).toBe(1);
    expect(audit.recorded[0]!.event.metadata).toMatchObject({ denialCode: 'policy_denied' });
  });

  it('composes the real PolicyEngine over an in-memory SQL client', async () => {
    const sql = new InMemoryPolicySqlClient();
    const audit = new CapturingAuditRecorder();
    const ac = new AccessControl({ policyEngine: new PolicyEngine({ sql }), auditRecorder: audit });

    const principal = makePrincipal();
    const resource: ResourceRef = makeResource();

    // No policy yet → default-deny + audit (Req 19.2, 19.8).
    const before = await ac.authorize(principal, resource, READ);
    expect(before.allowed).toBe(false);
    expect(before.denialCode).toBe('policy_denied');
    expect(audit.count).toBe(1);

    // Grant a user-scope Allow_List entry, then re-authorize → allowed, no new audit.
    const repo = new PolicyRepository(sql);
    await repo.create(
      { organizationId: 'org-1', userId: 'admin' },
      {
        id: 'p1',
        scope: 'user',
        scopeId: 'user-1',
        allowList: [{ action: 'read', resourceType: 'conversation' }],
      },
    );
    const after = await ac.authorize(principal, resource, READ);
    expect(after.allowed).toBe(true);
    expect(after.policyDecision?.decidingScope).toBe('user');
    expect(audit.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 — viewer resource restriction (Req 19.6)
// ---------------------------------------------------------------------------

describe('AccessControl — viewer resource restriction (Req 19.6)', () => {
  it('permits a viewer to read a shared conversation', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ roles: ['viewer'] }),
      makeResource({ type: 'conversation' }),
      READ,
      { shared: true },
    );
    expect(decision.allowed).toBe(true);
    expect(audit.count).toBe(0);
  });

  it('denies and audits a viewer reading an unshared conversation', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ roles: ['viewer'] }),
      makeResource({ type: 'conversation' }),
      READ,
      { shared: false },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('viewer_resource_restricted');
    expect(audit.count).toBe(1);
  });

  it('denies and audits a viewer attempting a non-read-only action', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ roles: ['viewer'] }),
      makeResource({ type: 'conversation' }),
      'update',
      { shared: true },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('viewer_resource_restricted');
    expect(audit.count).toBe(1);
  });

  it('permits a viewer to read a non-shareable resource type (e.g. project) granted by policy', async () => {
    const { ac } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ roles: ['viewer'] }),
      makeResource({ type: 'project' }),
      READ,
    );
    expect(decision.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — model-tier gates (Req 19.5, 19.6, 20.6)
// ---------------------------------------------------------------------------

describe('AccessControl — model-tier gates (Req 19.5, 19.6, 20.6)', () => {
  it('denies and audits a Premium model without Premium authorization', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ premiumAuthorized: false }),
      makeResource({ type: 'message' }),
      'create',
      { model: makeModel('premium') },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('premium_unauthorized');
    expect(audit.count).toBe(1);
  });

  it('permits a Premium model with Premium authorization', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ premiumAuthorized: true }),
      makeResource({ type: 'message' }),
      'create',
      { model: makeModel('premium') },
    );
    expect(decision.allowed).toBe(true);
    expect(audit.count).toBe(0);
  });

  it('denies and audits a viewer using a non-Economy model', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ roles: ['viewer'] }),
      makeResource({ type: 'message' }),
      READ,
      { model: makeModel('standard'), shared: true },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('viewer_model_restricted');
    expect(audit.count).toBe(1);
  });

  it('denies and audits a model outside the principal\u2019s allowed-model list', async () => {
    const { ac, audit } = makeAccessControl();
    const decision = await ac.authorize(
      makePrincipal({ allowedModels: ['model-economy'] }),
      makeResource({ type: 'message' }),
      'create',
      { model: makeModel('standard') },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('model_not_allowed');
    expect(audit.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// authorizeOrThrow + audit cardinality
// ---------------------------------------------------------------------------

describe('AccessControl.authorizeOrThrow', () => {
  it('returns the allow decision when authorized', async () => {
    const { ac } = makeAccessControl();
    const decision = await ac.authorizeOrThrow(makePrincipal(), makeResource(), READ);
    expect(decision.allowed).toBe(true);
  });

  it('throws AccessDeniedError carrying the decision and code on a denial', async () => {
    const { ac, audit } = makeAccessControl(denyingPolicyResolver());
    await expect(ac.authorizeOrThrow(makePrincipal(), makeResource(), READ)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    // The denial was audited exactly once before throwing.
    expect(audit.count).toBe(1);

    try {
      await ac.authorizeOrThrow(makePrincipal(), makeResource(), READ);
    } catch (error) {
      const denied = error as AccessDeniedError;
      expect(denied.code).toBe('policy_denied');
      expect(denied.decision.allowed).toBe(false);
    }
  });
});

describe('AccessControl — every denial is audited exactly once', () => {
  it('records exactly one access.denied event per denied authorize, none for allows', async () => {
    const audit = new CapturingAuditRecorder();
    // Deny only when the action is 'delete', otherwise grant.
    const policyEngine = new FakePolicyResolver((_, __, action) =>
      action === 'delete'
        ? { allowed: false, reason: 'no grant for delete', decidingScope: null }
        : { allowed: true, reason: 'granted', decidingScope: 'org' },
    );
    const ac = new AccessControl({ policyEngine, auditRecorder: audit });

    const principal = makePrincipal();
    const resource = makeResource();

    await ac.authorize(principal, resource, 'read'); // allow
    await ac.authorize(principal, resource, 'list'); // allow
    await ac.authorize(principal, resource, 'delete'); // deny (policy)
    await ac.authorize(principal, makeResource({ organizationId: 'org-2' }), 'read'); // deny (tenant)

    const denials = audit.withAction('access.denied');
    expect(denials).toHaveLength(2);
    expect(audit.count).toBe(2);
  });
});
