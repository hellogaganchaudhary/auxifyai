import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { tenantContextFromPrincipal, type Principal } from './identity';

function basePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    roles: ['standard_user'],
    teamIds: ['team-1'],
    projectIds: ['project-1'],
    allowedModels: ['gpt-4o'],
    premiumAuthorized: false,
    ...overrides,
  };
}

describe('tenantContextFromPrincipal', () => {
  it('always carries the principal organization and user id', () => {
    const ctx = tenantContextFromPrincipal(basePrincipal());
    expect(ctx.organizationId).toBe('org-1');
    expect(ctx.userId).toBe('user-1');
    expect('teamId' in ctx).toBe(false);
    expect('projectId' in ctx).toBe(false);
  });

  it('narrows scope to a team and/or project when provided', () => {
    const ctx = tenantContextFromPrincipal(basePrincipal(), {
      teamId: 'team-9',
      projectId: 'project-9',
    });
    expect(ctx.teamId).toBe('team-9');
    expect(ctx.projectId).toBe('project-9');
  });

  it('omits undefined scope fields rather than setting them to undefined', () => {
    const ctx = tenantContextFromPrincipal(basePrincipal(), { teamId: 'team-2' });
    expect(ctx.teamId).toBe('team-2');
    expect('projectId' in ctx).toBe(false);
  });
});

describe('tenantContextFromPrincipal (property-based)', () => {
  it('derived context preserves the principal organization and user for any principal', () => {
    const principalArb: fc.Arbitrary<Principal> = fc.record({
      userId: fc.string({ minLength: 1 }),
      organizationId: fc.string({ minLength: 1 }),
      roles: fc.constant<Principal['roles']>(['standard_user']),
      teamIds: fc.array(fc.string()),
      projectIds: fc.array(fc.string()),
      allowedModels: fc.array(fc.string()),
      premiumAuthorized: fc.boolean(),
    });

    fc.assert(
      fc.property(principalArb, (principal) => {
        const ctx = tenantContextFromPrincipal(principal);
        return ctx.organizationId === principal.organizationId && ctx.userId === principal.userId;
      }),
      { numRuns: 100 },
    );
  });
});
