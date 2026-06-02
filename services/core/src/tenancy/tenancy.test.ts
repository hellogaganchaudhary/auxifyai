/**
 * Unit tests for the Tenancy_Service (Req 1, 20).
 *
 * These exercise the full lifecycle against an in-memory {@link InMemorySqlClient}
 * and a capturing {@link FakeAuditRecorder}: organization/team/project/user/
 * membership creation, invitations and acceptance, assignment, project move,
 * role-change application, user deactivation (with session invalidation), and
 * the per-user allowed-model Allow_List. They also assert the fail-closed and
 * tenant-isolation behaviours the requirements call for.
 */

import { describe, expect, it } from 'vitest';

import type { Role, TenantContext } from '@auxify/types';

import {
  CrossOrganizationMoveError,
  InvitationNotAcceptableError,
  TenancyNotFoundError,
} from './errors.js';
import { FakeAuditRecorder, FakeSessionInvalidator, InMemorySqlClient } from './fakes.js';
import { TenancyService, type IdGenerator, type TenancyServiceOptions } from './service.js';

/** A deterministic id/token generator so tests can assert exact ids. */
class SequentialIds implements IdGenerator {
  private idN = 0;
  private tokenN = 0;
  id(): string {
    this.idN += 1;
    return `id-${this.idN}`;
  }
  token(): string {
    this.tokenN += 1;
    return `token-${this.tokenN}`;
  }
}

interface Harness {
  service: TenancyService;
  sql: InMemorySqlClient;
  audit: FakeAuditRecorder;
  sessions: FakeSessionInvalidator;
}

function makeService(overrides: Partial<TenancyServiceOptions> = {}): Harness {
  const sql = new InMemorySqlClient();
  const audit = new FakeAuditRecorder();
  const sessions = new FakeSessionInvalidator();
  const service = new TenancyService({
    sql,
    audit,
    sessionInvalidator: sessions,
    idGenerator: new SequentialIds(),
    now: () => new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  });
  return { service, sql, audit, sessions };
}

const ctx: TenantContext = { organizationId: 'org-1', userId: 'admin-1' };
const otherOrgCtx: TenantContext = { organizationId: 'org-2', userId: 'admin-2' };

/** Create an Organization row directly in the store for a scoped context. */
async function seedOrg(h: Harness, organizationId: string): Promise<void> {
  h.sql.seed('organizations', [
    {
      id: organizationId,
      name: organizationId,
      data_residency_region: null,
      storage_quota_bytes: 0,
      conversation_retention_days: 365,
      file_retention_days: 180,
      mfa_policy: 'optional',
      created_at: '2026-01-01T00:00:00.000Z',
    },
  ]);
}

describe('TenancyService — organization lifecycle (Req 1.1)', () => {
  it('creates an organization and audits it', async () => {
    const h = makeService();
    const org = await h.service.createOrganization({ name: 'Acme' });

    expect(org.id).toBe('id-1');
    expect(org.name).toBe('Acme');
    expect(org.conversationRetentionDays).toBe(365);
    expect(h.audit.withAction('organization.create')).toHaveLength(1);

    const fetched = await h.service.getOrganization({ organizationId: org.id, userId: 'u' });
    expect(fetched?.id).toBe(org.id);
  });
});

describe('TenancyService — team lifecycle (Req 20.1, 1.2)', () => {
  it('creates a team under the caller organization with a budget and audits it', async () => {
    const h = makeService();
    const team = await h.service.createTeam(ctx, {
      name: 'Engineering',
      budget: { monthlyUsd: 500 },
    });

    expect(team.organizationId).toBe('org-1');
    expect(team.name).toBe('Engineering');
    expect(team.budget).toEqual({ monthlyUsd: 500 });

    const audited = h.audit.withAction('team.create');
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      organizationId: 'org-1',
      resourceType: 'team',
      resourceId: team.id,
    });
  });

  it('lists only teams within the caller organization', async () => {
    const h = makeService();
    await h.service.createTeam(ctx, { name: 'A' });
    await h.service.createTeam(otherOrgCtx, { name: 'B' });

    const orgTeams = await h.service.listTeams(ctx);
    expect(orgTeams).toHaveLength(1);
    expect(orgTeams[0]?.name).toBe('A');
  });
});

describe('TenancyService — project lifecycle (Req 1.5, 20.2)', () => {
  it('persists name, owning team, creation timestamp, and access list', async () => {
    const h = makeService();
    const team = await h.service.createTeam(ctx, { name: 'Eng' });
    const project = await h.service.createProject(ctx, {
      teamId: team.id,
      name: 'Apollo',
      accessList: ['user-1', 'user-2'],
      budget: { monthlyUsd: 100 },
    });

    expect(project.organizationId).toBe('org-1');
    expect(project.teamId).toBe(team.id);
    expect(project.name).toBe('Apollo');
    expect(project.accessList).toEqual(['user-1', 'user-2']);
    expect(project.budget).toEqual({ monthlyUsd: 100 });
    expect(project.createdAt).toBeTruthy();
    expect(h.audit.withAction('project.create')).toHaveLength(1);
  });

  it('rejects creating a project under a team that is not in the tenant', async () => {
    const h = makeService();
    await expect(
      h.service.createProject(ctx, { teamId: 'team-missing', name: 'X' }),
    ).rejects.toBeInstanceOf(TenancyNotFoundError);
  });

  it('does not create a project under another organization team', async () => {
    const h = makeService();
    const foreignTeam = await h.service.createTeam(otherOrgCtx, { name: 'Foreign' });

    // org-1 cannot see org-2's team, so the project creation fails closed.
    await expect(
      h.service.createProject(ctx, { teamId: foreignTeam.id, name: 'X' }),
    ).rejects.toBeInstanceOf(TenancyNotFoundError);
  });
});

describe('TenancyService — project move (Req 1.6)', () => {
  it('reassigns the project to a new team and records the change in the audit service', async () => {
    const h = makeService();
    const teamA = await h.service.createTeam(ctx, { name: 'A' });
    const teamB = await h.service.createTeam(ctx, { name: 'B' });
    const project = await h.service.createProject(ctx, { teamId: teamA.id, name: 'P' });

    const moved = await h.service.moveProject(ctx, project.id, teamB.id);
    expect(moved.teamId).toBe(teamB.id);

    const audited = h.audit.withAction('project.move');
    expect(audited).toHaveLength(1);
    expect(audited[0]?.metadata).toEqual({ fromTeamId: teamA.id, toTeamId: teamB.id });
    expect(audited[0]?.resourceId).toBe(project.id);
  });

  it('refuses to move a project to a team outside its organization', async () => {
    const h = makeService();
    const teamA = await h.service.createTeam(ctx, { name: 'A' });
    const project = await h.service.createProject(ctx, { teamId: teamA.id, name: 'P' });
    const foreignTeam = await h.service.createTeam(otherOrgCtx, { name: 'Foreign' });

    await expect(h.service.moveProject(ctx, project.id, foreignTeam.id)).rejects.toBeInstanceOf(
      CrossOrganizationMoveError,
    );
    // No move audit event should be recorded for the refused attempt.
    expect(h.audit.withAction('project.move')).toHaveLength(0);
  });

  it('fails closed when the project does not exist in the tenant', async () => {
    const h = makeService();
    const team = await h.service.createTeam(ctx, { name: 'A' });
    await expect(h.service.moveProject(ctx, 'project-missing', team.id)).rejects.toBeInstanceOf(
      TenancyNotFoundError,
    );
  });
});

describe('TenancyService — user lifecycle and deactivation (Req 20.5)', () => {
  it('creates and lists users within the tenant', async () => {
    const h = makeService();
    const user = await h.service.createUser(ctx, {
      email: 'a@example.com',
      roles: ['standard_user'],
    });
    expect(user.organizationId).toBe('org-1');
    expect(user.status).toBe('active');

    const users = await h.service.listUsers(ctx);
    expect(users.map((u) => u.email)).toEqual(['a@example.com']);
  });

  it('deactivates a user, blocks future auth via status, and revokes sessions', async () => {
    const h = makeService();
    const user = await h.service.createUser(ctx, { email: 'a@example.com' });

    const deactivated = await h.service.deactivateUser(ctx, user.id);
    expect(deactivated.status).toBe('deactivated');
    expect(h.sessions.invalidated).toEqual([user.id]);
    expect(h.audit.withAction('user.deactivate')).toHaveLength(1);
  });

  it('deactivation works without a session invalidator wired (status still blocks auth)', async () => {
    const sql = new InMemorySqlClient();
    const audit = new FakeAuditRecorder();
    const service = new TenancyService({ sql, audit, idGenerator: new SequentialIds() });
    const user = await service.createUser(ctx, { email: 'a@example.com' });

    const deactivated = await service.deactivateUser(ctx, user.id);
    expect(deactivated.status).toBe('deactivated');
  });

  it('fails closed when deactivating a user outside the tenant', async () => {
    const h = makeService();
    const user = await h.service.createUser(otherOrgCtx, { email: 'foreign@example.com' });
    await expect(h.service.deactivateUser(ctx, user.id)).rejects.toBeInstanceOf(
      TenancyNotFoundError,
    );
    expect(h.sessions.invalidated).toEqual([]);
  });
});

describe('TenancyService — role change and allowed-model list (Req 19.7, 20.6)', () => {
  it('applies a role change so the persisted record reflects it', async () => {
    const h = makeService();
    const user = await h.service.createUser(ctx, { email: 'a@example.com', roles: ['viewer'] });

    const roles: Role[] = ['power_user', 'admin'];
    const updated = await h.service.applyRoleChange(ctx, user.id, roles);
    expect(updated.roles).toEqual(roles);

    const reread = await h.service.getUser(ctx, user.id);
    expect(reread?.roles).toEqual(roles);
    expect(h.audit.withAction('user.role_change')).toHaveLength(1);
  });

  it('restricts a user to the assigned allowed-model Allow_List', async () => {
    const h = makeService();
    const user = await h.service.createUser(ctx, { email: 'a@example.com' });

    const models = ['gpt-economy', 'claude-haiku'];
    const updated = await h.service.setAllowedModels(ctx, user.id, models);
    expect(updated.allowedModels).toEqual(models);

    const reread = await h.service.getUser(ctx, user.id);
    expect(reread?.allowedModels).toEqual(models);
    expect(h.audit.withAction('user.set_allowed_models')).toHaveLength(1);
  });

  it('fails closed for role/model changes on a foreign user', async () => {
    const h = makeService();
    const foreign = await h.service.createUser(otherOrgCtx, { email: 'foreign@example.com' });
    await expect(h.service.applyRoleChange(ctx, foreign.id, ['admin'])).rejects.toBeInstanceOf(
      TenancyNotFoundError,
    );
    await expect(h.service.setAllowedModels(ctx, foreign.id, ['m'])).rejects.toBeInstanceOf(
      TenancyNotFoundError,
    );
  });
});

describe('TenancyService — invitations (Req 20.3)', () => {
  it('creates a pending invitation with a token and roles', async () => {
    const h = makeService();
    const invitation = await h.service.inviteUser(ctx, {
      email: 'new@example.com',
      roles: ['standard_user'],
    });

    expect(invitation.status).toBe('pending');
    expect(invitation.email).toBe('new@example.com');
    expect(invitation.roles).toEqual(['standard_user']);
    expect(invitation.token).toBe('token-1');
    expect(invitation.invitedBy).toBe('admin-1');
    expect(h.audit.withAction('invitation.create')).toHaveLength(1);
  });

  it('creates the user account on acceptance with the invited roles', async () => {
    const h = makeService();
    const invitation = await h.service.inviteUser(ctx, {
      email: 'new@example.com',
      roles: ['power_user'],
    });

    const user = await h.service.acceptInvitation({
      organizationId: 'org-1',
      token: invitation.token,
    });

    expect(user.email).toBe('new@example.com');
    expect(user.roles).toEqual(['power_user']);
    expect(user.organizationId).toBe('org-1');
    expect(h.audit.withAction('invitation.accept')).toHaveLength(1);

    // The invitation is now marked accepted and cannot be reused.
    await expect(
      h.service.acceptInvitation({ organizationId: 'org-1', token: invitation.token }),
    ).rejects.toBeInstanceOf(InvitationNotAcceptableError);
  });

  it('rejects an unknown token', async () => {
    const h = makeService();
    await seedOrg(h, 'org-1');
    await expect(
      h.service.acceptInvitation({ organizationId: 'org-1', token: 'nope' }),
    ).rejects.toBeInstanceOf(InvitationNotAcceptableError);
  });

  it('rejects an expired invitation', async () => {
    const h = makeService();
    const invitation = await h.service.inviteUser(ctx, {
      email: 'late@example.com',
      expiresAt: '2026-01-01T00:00:00.000Z', // before the fixed clock (2026-06-01)
    });
    await expect(
      h.service.acceptInvitation({ organizationId: 'org-1', token: invitation.token }),
    ).rejects.toBeInstanceOf(InvitationNotAcceptableError);
  });

  it('rejects a revoked invitation', async () => {
    const h = makeService();
    const invitation = await h.service.inviteUser(ctx, { email: 'rev@example.com' });
    await h.service.revokeInvitation(ctx, invitation.id);

    await expect(
      h.service.acceptInvitation({ organizationId: 'org-1', token: invitation.token }),
    ).rejects.toBeInstanceOf(InvitationNotAcceptableError);
  });

  it('does not accept an invitation through a different organization context', async () => {
    const h = makeService();
    const invitation = await h.service.inviteUser(ctx, { email: 'new@example.com' });
    // Accepting under org-2 must not find the org-1 invitation (tenant scoped).
    await expect(
      h.service.acceptInvitation({ organizationId: 'org-2', token: invitation.token }),
    ).rejects.toBeInstanceOf(InvitationNotAcceptableError);
  });
});

describe('TenancyService — assignment (Req 20.4)', () => {
  it('assigns a user to a team via a membership and audits it', async () => {
    const h = makeService();
    const team = await h.service.createTeam(ctx, { name: 'Eng' });
    const user = await h.service.createUser(ctx, { email: 'a@example.com' });

    const membership = await h.service.assignUser(ctx, user.id, { teamId: team.id });
    expect(membership.userId).toBe(user.id);
    expect(membership.teamId).toBe(team.id);
    expect(membership.projectId).toBeNull();

    const memberships = await h.service.listMemberships(ctx, user.id);
    expect(memberships).toHaveLength(1);
    expect(h.audit.withAction('user.assign')).toHaveLength(1);
  });

  it('assigns a user to a project (and team)', async () => {
    const h = makeService();
    const team = await h.service.createTeam(ctx, { name: 'Eng' });
    const project = await h.service.createProject(ctx, { teamId: team.id, name: 'P' });
    const user = await h.service.createUser(ctx, { email: 'a@example.com' });

    const membership = await h.service.assignUser(ctx, user.id, {
      teamId: team.id,
      projectId: project.id,
    });
    expect(membership.teamId).toBe(team.id);
    expect(membership.projectId).toBe(project.id);
  });

  it('requires at least one of team/project', async () => {
    const h = makeService();
    const user = await h.service.createUser(ctx, { email: 'a@example.com' });
    await expect(h.service.assignUser(ctx, user.id, {})).rejects.toBeInstanceOf(
      TenancyNotFoundError,
    );
  });

  it('fails closed assigning a foreign user or to a foreign team', async () => {
    const h = makeService();
    const team = await h.service.createTeam(ctx, { name: 'Eng' });
    const foreignUser = await h.service.createUser(otherOrgCtx, { email: 'foreign@example.com' });
    await expect(
      h.service.assignUser(ctx, foreignUser.id, { teamId: team.id }),
    ).rejects.toBeInstanceOf(TenancyNotFoundError);

    const user = await h.service.createUser(ctx, { email: 'a@example.com' });
    const foreignTeam = await h.service.createTeam(otherOrgCtx, { name: 'Foreign' });
    await expect(
      h.service.assignUser(ctx, user.id, { teamId: foreignTeam.id }),
    ).rejects.toBeInstanceOf(TenancyNotFoundError);
  });
});

describe('TenancyService — tenant isolation of resources (Req 1.2, 1.4)', () => {
  it('associates every created resource with exactly one organization', async () => {
    const h = makeService();
    const team = await h.service.createTeam(ctx, { name: 'Eng' });
    const project = await h.service.createProject(ctx, { teamId: team.id, name: 'P' });
    const user = await h.service.createUser(ctx, { email: 'a@example.com' });

    expect(team.organizationId).toBe('org-1');
    expect(project.organizationId).toBe('org-1');
    expect(user.organizationId).toBe('org-1');

    // Another organization sees none of these resources.
    expect(await h.service.listTeams(otherOrgCtx)).toHaveLength(0);
    expect(await h.service.listProjects(otherOrgCtx)).toHaveLength(0);
    expect(await h.service.listUsers(otherOrgCtx)).toHaveLength(0);
  });
});
