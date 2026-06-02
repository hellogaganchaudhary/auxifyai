/**
 * Unit tests for the Policy_Engine (Req 19.1, 19.2, 19.3, 19.8).
 *
 * These exercise the engine against an in-memory {@link InMemoryPolicySqlClient}:
 *   - Organization > Team > User precedence for conflicting decisions (Req 19.3);
 *   - default-deny when no Allow_List grants or no policy resolves (Req 19.2, 19.8);
 *   - wildcard matching and explicit per-scope deny (least privilege);
 *   - tenant scoping (another Organization's policies never apply);
 *   - freshness — a policy change is reflected on the next resolution (Req 19.7).
 *
 * They also cover the pure {@link decidePolicy} algorithm directly.
 */

import { describe, expect, it } from 'vitest';

import type { Action, Principal, ResourceRef } from '@auxify/types';

import { InMemoryPolicySqlClient } from './fakes.js';
import { PolicyEngine, decidePolicy } from './policy-engine.js';
import { PolicyRepository } from './policy-repository.js';
import type { AllowListEntry, Policy } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    roles: ['standard_user'],
    teamIds: ['team-1'],
    projectIds: ['project-1'],
    allowedModels: [],
    premiumAuthorized: false,
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceRef> = {}): ResourceRef {
  return {
    type: 'conversation',
    id: 'conv-1',
    organizationId: 'org-1',
    ...overrides,
  };
}

/** Build an engine over a fresh fake client, returning both for assertions. */
function makeEngine(): { engine: PolicyEngine; sql: InMemoryPolicySqlClient } {
  const sql = new InMemoryPolicySqlClient();
  return { engine: new PolicyEngine({ sql }), sql };
}

/** Convenience to build a Policy for the pure-algorithm tests. */
function policy(
  scope: Policy['scope'],
  scopeId: string,
  allowList: AllowListEntry[],
  organizationId = 'org-1',
): Policy {
  return { id: `${scope}-${scopeId}`, organizationId, scope, scopeId, allowList };
}

const READ: Action = 'read';

// ---------------------------------------------------------------------------
// Pure precedence/merge algorithm (decidePolicy)
// ---------------------------------------------------------------------------

describe('decidePolicy (pure precedence algorithm)', () => {
  it('grants when a single scope allows the permission', () => {
    const decision = decidePolicy(
      {
        org: [],
        team: [],
        user: [policy('user', 'user-1', [{ action: 'read', resourceType: 'conversation' }])],
      },
      READ,
      'conversation',
    );
    expect(decision.allowed).toBe(true);
    expect(decision.decidingScope).toBe('user');
  });

  it('defaults to deny when no scope has any matching entry (Req 19.2, 19.8)', () => {
    const decision = decidePolicy({ org: [], team: [], user: [] }, READ, 'conversation');
    expect(decision.allowed).toBe(false);
    expect(decision.decidingScope).toBeNull();
    expect(decision.reason).toContain('default-deny');
  });

  it('Organization decision overrides a conflicting Team decision (Req 19.3)', () => {
    const decision = decidePolicy(
      {
        org: [
          policy('org', 'org-1', [
            { action: 'read', resourceType: 'conversation', effect: 'deny' },
          ]),
        ],
        team: [policy('team', 'team-1', [{ action: 'read', resourceType: 'conversation' }])],
        user: [],
      },
      READ,
      'conversation',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.decidingScope).toBe('org');
  });

  it('Team decision overrides a conflicting User decision (Req 19.3)', () => {
    const decision = decidePolicy(
      {
        org: [],
        team: [
          policy('team', 'team-1', [
            { action: 'read', resourceType: 'conversation', effect: 'deny' },
          ]),
        ],
        user: [policy('user', 'user-1', [{ action: 'read', resourceType: 'conversation' }])],
      },
      READ,
      'conversation',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.decidingScope).toBe('team');
  });

  it('falls through a silent higher scope to a lower scope that decides', () => {
    // Org policy exists but does not match this permission → silent; Team grants.
    const decision = decidePolicy(
      {
        org: [policy('org', 'org-1', [{ action: 'delete', resourceType: 'document' }])],
        team: [policy('team', 'team-1', [{ action: 'read', resourceType: 'conversation' }])],
        user: [],
      },
      READ,
      'conversation',
    );
    expect(decision.allowed).toBe(true);
    expect(decision.decidingScope).toBe('team');
  });

  it('matches wildcard action and resource entries', () => {
    const decision = decidePolicy(
      { org: [policy('org', 'org-1', [{ action: '*', resourceType: '*' }])], team: [], user: [] },
      READ,
      'conversation',
    );
    expect(decision.allowed).toBe(true);
    expect(decision.decidingScope).toBe('org');
  });

  it('lets an explicit deny win over a co-located allow within the same scope', () => {
    const decision = decidePolicy(
      {
        org: [
          policy('org', 'org-1', [
            { action: 'read', resourceType: 'conversation' },
            { action: '*', resourceType: '*', effect: 'deny' },
          ]),
        ],
        team: [],
        user: [],
      },
      READ,
      'conversation',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.decidingScope).toBe('org');
  });
});

// ---------------------------------------------------------------------------
// PolicyEngine.resolve (over the repository + fake SQL client)
// ---------------------------------------------------------------------------

describe('PolicyEngine.resolve', () => {
  it('denies by default when the Organization has no policies (Req 19.2, 19.8)', async () => {
    const { engine } = makeEngine();
    const decision = await engine.resolve(principal(), resource(), READ);
    expect(decision.allowed).toBe(false);
    expect(decision.decidingScope).toBeNull();
  });

  it('grants when a user-scope Allow_List entry matches', async () => {
    const { engine, sql } = makeEngine();
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
    const decision = await engine.resolve(principal(), resource(), READ);
    expect(decision.allowed).toBe(true);
    expect(decision.decidingScope).toBe('user');
  });

  it('applies Organization > Team > User precedence across stored policies (Req 19.3)', async () => {
    const { engine, sql } = makeEngine();
    const repo = new PolicyRepository(sql);
    const ctx = { organizationId: 'org-1', userId: 'admin' };
    // User allows, Team allows, but Org denies → Org wins.
    await repo.create(ctx, {
      id: 'pu',
      scope: 'user',
      scopeId: 'user-1',
      allowList: [{ action: 'read', resourceType: 'conversation' }],
    });
    await repo.create(ctx, {
      id: 'pt',
      scope: 'team',
      scopeId: 'team-1',
      allowList: [{ action: 'read', resourceType: 'conversation' }],
    });
    await repo.create(ctx, {
      id: 'po',
      scope: 'org',
      scopeId: 'org-1',
      allowList: [{ action: 'read', resourceType: 'conversation', effect: 'deny' }],
    });
    const decision = await engine.resolve(principal(), resource(), READ);
    expect(decision.allowed).toBe(false);
    expect(decision.decidingScope).toBe('org');
  });

  it('never applies another Organization\u2019s policies (tenant scoping)', async () => {
    const { engine, sql } = makeEngine();
    // A policy granting the permission, but owned by a different Organization.
    sql.seed('policies', [
      {
        id: 'foreign',
        organization_id: 'org-2',
        scope: 'user',
        scope_id: 'user-1',
        allow_list: JSON.stringify([{ action: 'read', resourceType: 'conversation' }]),
      },
    ]);
    const decision = await engine.resolve(principal(), resource(), READ);
    expect(decision.allowed).toBe(false);
    expect(decision.decidingScope).toBeNull();
  });

  it('reflects a policy change on the next resolution without caching (Req 19.7)', async () => {
    const { engine, sql } = makeEngine();
    const repo = new PolicyRepository(sql);
    const ctx = { organizationId: 'org-1', userId: 'admin' };

    const before = await engine.resolve(principal(), resource(), READ);
    expect(before.allowed).toBe(false);

    await repo.create(ctx, {
      id: 'p-new',
      scope: 'user',
      scopeId: 'user-1',
      allowList: [{ action: 'read', resourceType: 'conversation' }],
    });

    const after = await engine.resolve(principal(), resource(), READ);
    expect(after.allowed).toBe(true);
    // Each resolve issued fresh reads (no cache): proves freshness mechanically.
    expect(sql.queries.filter((q) => q.text.startsWith('SELECT')).length).toBeGreaterThanOrEqual(6);
  });

  it('denies an action the matching policy does not cover', async () => {
    const { engine, sql } = makeEngine();
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
    const decision = await engine.resolve(principal(), resource(), 'delete');
    expect(decision.allowed).toBe(false);
    expect(decision.decidingScope).toBeNull();
  });
});
