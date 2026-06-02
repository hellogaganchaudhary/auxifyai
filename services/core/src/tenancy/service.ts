/**
 * The Tenancy_Service (Req 1, 20).
 *
 * Owns the Organization → Team → Project hierarchy plus users, memberships, and
 * invitations, and the per-user permitted-model Allow_List. It is the single
 * place that:
 *   - associates every created resource with exactly one Organization and
 *     records its owning Team/Project where applicable (Req 1.1, 1.2, 1.5);
 *   - creates Teams (Req 20.1) and Projects (Req 20.2) under the tenant;
 *   - invites users and creates accounts on acceptance (Req 20.3);
 *   - assigns users to Teams/Projects (Req 20.4);
 *   - moves a Project to a different Team in the same Organization and records
 *     the change in the Audit_Service (Req 1.6);
 *   - applies role changes so they take effect on subsequent requests (Req 19.7,
 *     20) and deactivates users — blocking authentication and revoking sessions
 *     (Req 20.5);
 *   - manages the per-user allowed-model Allow_List (Req 20.6).
 *
 * Dependencies are injected so the service is unit-testable without a database:
 * a narrow {@link SqlClient}, an {@link AuditRecorder} port (the concrete
 * Audit_Service is built in task 3.9), an optional {@link SessionInvalidator}
 * (Device_Manager seam, task 20.3), and an id/token generator.
 *
 * Tenant isolation is inherited from the repository layer: every repository
 * call requires a {@link TenantContext} and injects the `organization_id`
 * predicate, so no operation here can cross an Organization boundary (Req 1.4).
 */

import { randomUUID } from 'node:crypto';

import type { Role, TenantContext } from '@auxify/types';

import type { SqlClient } from '../storage/pgvector.js';
import {
  CrossOrganizationMoveError,
  InvitationNotAcceptableError,
  TenancyNotFoundError,
} from './errors.js';
import {
  InvitationRepository,
  MembershipRepository,
  OrganizationRepository,
  ProjectRepository,
  TeamRepository,
  UserRepository,
} from './repositories.js';
import type {
  AcceptInvitationInput,
  AuditRecorder,
  CreateOrganizationInput,
  CreateProjectInput,
  CreateTeamInput,
  CreateUserInput,
  Invitation,
  InviteUserInput,
  Membership,
  MembershipTarget,
  Organization,
  Project,
  SessionInvalidator,
  Team,
  User,
} from './types.js';

/** Generates unique ids and invitation tokens (injectable for deterministic tests). */
export interface IdGenerator {
  /** A unique resource id. */
  id(): string;
  /** A unique, hard-to-guess invitation token. */
  token(): string;
}

/** Default id/token generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: IdGenerator = {
  id: () => randomUUID(),
  token: () => `${randomUUID()}${randomUUID()}`.replace(/-/g, ''),
};

/** Construction dependencies for the {@link TenancyService}. */
export interface TenancyServiceOptions {
  /** The narrow SQL port (real `pg` client or a fake in tests). */
  sql: SqlClient;
  /** The append-only audit sink (Req 37.1); the Tenancy_Service records mutations through it. */
  audit: AuditRecorder;
  /**
   * Optional session-invalidation seam used on user deactivation (Req 20.5).
   * When omitted, deactivation still blocks future authentication via the
   * persisted `deactivated` status; the concrete invalidator is wired in task
   * 20.3 (Device_Manager).
   */
  sessionInvalidator?: SessionInvalidator;
  /** Optional id/token generator (defaults to `crypto.randomUUID`). */
  idGenerator?: IdGenerator;
  /** Optional clock for timestamps (defaults to `() => new Date()`), for deterministic tests. */
  now?: () => Date;
}

/**
 * The Tenancy_Service. Construct once with its dependencies and call its
 * lifecycle methods with the acting administrator's {@link TenantContext}.
 */
export class TenancyService {
  private readonly sql: SqlClient;
  private readonly audit: AuditRecorder;
  private readonly sessionInvalidator: SessionInvalidator | undefined;
  private readonly ids: IdGenerator;
  private readonly now: () => Date;

  private readonly organizations: OrganizationRepository;
  private readonly teams: TeamRepository;
  private readonly projects: ProjectRepository;
  private readonly users: UserRepository;
  private readonly memberships: MembershipRepository;
  private readonly invitations: InvitationRepository;

  constructor(options: TenancyServiceOptions) {
    this.sql = options.sql;
    this.audit = options.audit;
    this.sessionInvalidator = options.sessionInvalidator;
    this.ids = options.idGenerator ?? defaultIdGenerator;
    this.now = options.now ?? (() => new Date());

    this.organizations = new OrganizationRepository(this.sql);
    this.teams = new TeamRepository(this.sql);
    this.projects = new ProjectRepository(this.sql);
    this.users = new UserRepository(this.sql);
    this.memberships = new MembershipRepository(this.sql);
    this.invitations = new InvitationRepository(this.sql);
  }

  // -------------------------------------------------------------------------
  // Organization lifecycle (tenancy root, Req 1.1).
  // -------------------------------------------------------------------------

  /**
   * Create a new Organization (a new tenant boundary). Platform-level; not
   * tenant-scoped. The created Organization's id becomes the tenant key for all
   * resources created under it (Req 1.1, 1.2).
   */
  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
    const id = input.id ?? this.ids.id();
    const org = await this.organizations.insert({
      id,
      name: input.name,
      dataResidencyRegion: input.dataResidencyRegion ?? null,
      storageQuotaBytes: input.storageQuotaBytes ?? 0,
      conversationRetentionDays: input.conversationRetentionDays ?? 365,
      fileRetentionDays: input.fileRetentionDays ?? 180,
      mfaPolicy: input.mfaPolicy ?? 'optional',
    });
    await this.audit.record(
      { organizationId: org.id, userId: org.id },
      {
        action: 'organization.create',
        resourceType: 'organization',
        resourceId: org.id,
      },
    );
    return org;
  }

  /** Fetch the caller's Organization, or `null` if it does not exist. */
  async getOrganization(ctx: TenantContext): Promise<Organization | null> {
    return this.organizations.findById(ctx);
  }

  // -------------------------------------------------------------------------
  // Team lifecycle (Req 20.1).
  // -------------------------------------------------------------------------

  /**
   * Create a Team under the caller's Organization with a name and configurable
   * budget (Req 20.1). The Team is associated with exactly one Organization
   * (Req 1.2).
   */
  async createTeam(ctx: TenantContext, input: CreateTeamInput): Promise<Team> {
    const id = input.id ?? this.ids.id();
    const team = await this.teams.create(ctx, {
      id,
      name: input.name,
      budget: input.budget ?? {},
    });
    await this.audit.record(ctx, {
      action: 'team.create',
      resourceType: 'team',
      resourceId: team.id,
    });
    return team;
  }

  /** List Teams within the caller's Organization. */
  async listTeams(ctx: TenantContext): Promise<Team[]> {
    return this.teams.list(ctx);
  }

  // -------------------------------------------------------------------------
  // Project lifecycle (Req 1.5, 20.2).
  // -------------------------------------------------------------------------

  /**
   * Create a Project under a Team, persisting its name, owning Team, creation
   * timestamp, access list, and budget (Req 1.5, 20.2). The owning Team must
   * belong to the caller's Organization; otherwise a {@link TenancyNotFoundError}
   * is raised before any write (so a Project is never orphaned or cross-tenant).
   */
  async createProject(ctx: TenantContext, input: CreateProjectInput): Promise<Project> {
    const team = await this.teams.findById(ctx, input.teamId);
    if (team === null) {
      throw new TenancyNotFoundError('team', input.teamId);
    }
    const id = input.id ?? this.ids.id();
    const project = await this.projects.create(ctx, {
      id,
      teamId: input.teamId,
      name: input.name,
      accessList: input.accessList ?? [],
      budget: input.budget ?? {},
    });
    await this.audit.record(ctx, {
      action: 'project.create',
      resourceType: 'project',
      resourceId: project.id,
      metadata: { teamId: project.teamId },
    });
    return project;
  }

  /** List Projects within the caller's Organization. */
  async listProjects(ctx: TenantContext): Promise<Project[]> {
    return this.projects.list(ctx);
  }

  /**
   * Move a Project to a different Team within the same Organization, reassigning
   * it and recording the change in the Audit_Service (Req 1.6).
   *
   * Both the Project and the destination Team are resolved within the caller's
   * tenant first; a missing Team or Project is reported as a
   * {@link TenancyNotFoundError}, and tenant scoping guarantees the move can
   * never cross an Organization boundary.
   */
  async moveProject(ctx: TenantContext, projectId: string, newTeamId: string): Promise<Project> {
    const project = await this.projects.findById(ctx, projectId);
    if (project === null) {
      throw new TenancyNotFoundError('project', projectId);
    }
    const destinationTeam = await this.teams.findById(ctx, newTeamId);
    if (destinationTeam === null) {
      // The destination Team is not in this Organization (or does not exist):
      // the move would cross a tenant boundary, so refuse it (Req 1.6).
      throw new CrossOrganizationMoveError();
    }

    const fromTeamId = project.teamId;
    const moved = await this.projects.reassignTeam(ctx, projectId, newTeamId);
    if (moved === null) {
      // Should not happen (we just resolved the project), but stay fail-closed.
      throw new TenancyNotFoundError('project', projectId);
    }

    await this.audit.record(ctx, {
      action: 'project.move',
      resourceType: 'project',
      resourceId: projectId,
      metadata: { fromTeamId, toTeamId: newTeamId },
    });
    return moved;
  }

  // -------------------------------------------------------------------------
  // User lifecycle (Req 20.3, 20.5).
  // -------------------------------------------------------------------------

  /**
   * Create a user account directly within the caller's Organization (the
   * administrative path; the invitation path is {@link acceptInvitation}).
   */
  async createUser(ctx: TenantContext, input: CreateUserInput): Promise<User> {
    const id = input.id ?? this.ids.id();
    const user = await this.users.create(ctx, {
      id,
      email: input.email,
      roles: input.roles ?? [],
      allowedModels: input.allowedModels ?? [],
      premiumAuthorized: input.premiumAuthorized ?? false,
      mfaEnabled: input.mfaEnabled ?? false,
    });
    await this.audit.record(ctx, {
      action: 'user.create',
      resourceType: 'user',
      resourceId: user.id,
    });
    return user;
  }

  /** Fetch a user by id within the caller's Organization, or `null`. */
  async getUser(ctx: TenantContext, userId: string): Promise<User | null> {
    return this.users.findById(ctx, userId);
  }

  /** List users within the caller's Organization. */
  async listUsers(ctx: TenantContext): Promise<User[]> {
    return this.users.list(ctx);
  }

  /**
   * Deactivate a user: mark the account `deactivated` (which blocks future
   * authentication, Req 20.5) and revoke the user's active sessions through the
   * injected {@link SessionInvalidator} when one is wired (task 20.3). The
   * deactivation is audited.
   */
  async deactivateUser(ctx: TenantContext, userId: string): Promise<User> {
    const updated = await this.users.setStatus(ctx, userId, 'deactivated');
    if (updated === null) {
      throw new TenancyNotFoundError('user', userId);
    }
    // Revoke active sessions if the Device_Manager seam is wired (Req 20.5).
    if (this.sessionInvalidator !== undefined) {
      await this.sessionInvalidator.invalidateAllForUser(userId);
    }
    await this.audit.record(ctx, {
      action: 'user.deactivate',
      resourceType: 'user',
      resourceId: userId,
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Role and Allow_List application (Req 19.7, 20.6).
  // -------------------------------------------------------------------------

  /**
   * Apply a role change to a user so it takes effect on subsequent requests
   * (Req 19.7, 20). The new role set replaces the user's roles in the persisted
   * record that principals are derived from, and the change is audited.
   */
  async applyRoleChange(ctx: TenantContext, userId: string, roles: Role[]): Promise<User> {
    const updated = await this.users.setRoles(ctx, userId, roles);
    if (updated === null) {
      throw new TenancyNotFoundError('user', userId);
    }
    await this.audit.record(ctx, {
      action: 'user.role_change',
      resourceType: 'user',
      resourceId: userId,
      metadata: { roles },
    });
    return updated;
  }

  /**
   * Set the allowed models for a user, restricting the user's model access to
   * the assigned Allow_List (Req 20.6). The change is audited.
   */
  async setAllowedModels(ctx: TenantContext, userId: string, modelIds: string[]): Promise<User> {
    const updated = await this.users.setAllowedModels(ctx, userId, modelIds);
    if (updated === null) {
      throw new TenancyNotFoundError('user', userId);
    }
    await this.audit.record(ctx, {
      action: 'user.set_allowed_models',
      resourceType: 'user',
      resourceId: userId,
      metadata: { allowedModels: modelIds },
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Invitations (Req 20.3).
  // -------------------------------------------------------------------------

  /**
   * Invite a user by email, persisting a pending invitation with a single-use
   * token and the roles to grant on acceptance (Req 20.3). Returns the
   * invitation including its token so the caller can deliver the invite link.
   */
  async inviteUser(ctx: TenantContext, input: InviteUserInput): Promise<Invitation> {
    const id = input.id ?? this.ids.id();
    const token = input.token ?? this.ids.token();
    const invitation = await this.invitations.create(ctx, {
      id,
      email: input.email,
      roles: input.roles ?? [],
      token,
      invitedBy: input.invitedBy ?? ctx.userId,
      expiresAt: input.expiresAt ?? null,
    });
    await this.audit.record(ctx, {
      action: 'invitation.create',
      resourceType: 'user',
      resourceId: invitation.id,
      metadata: { email: invitation.email },
    });
    return invitation;
  }

  /**
   * Accept an invitation by token, creating the user account and marking the
   * invitation accepted (Req 20.3). Fails closed for unknown, already-accepted,
   * revoked, or expired invitations via {@link InvitationNotAcceptableError}.
   *
   * @returns The newly created user account.
   */
  async acceptInvitation(input: AcceptInvitationInput): Promise<User> {
    // The invitee is not yet an authenticated principal; scope the operation to
    // the Organization the invite belongs to (resolved by the caller).
    const ctx: TenantContext = {
      organizationId: input.organizationId,
      userId: input.userId ?? input.token,
    };

    const invitation = await this.invitations.findByToken(ctx, input.token);
    if (invitation === null) {
      throw new InvitationNotAcceptableError('not_found');
    }
    if (invitation.status === 'accepted') {
      throw new InvitationNotAcceptableError('already_accepted');
    }
    if (invitation.status === 'revoked') {
      throw new InvitationNotAcceptableError('revoked');
    }
    if (
      invitation.expiresAt !== null &&
      new Date(invitation.expiresAt).getTime() < this.now().getTime()
    ) {
      throw new InvitationNotAcceptableError('expired');
    }

    const userId = input.userId ?? this.ids.id();
    const user = await this.users.create(ctx, {
      id: userId,
      email: invitation.email,
      roles: invitation.roles,
      allowedModels: [],
      premiumAuthorized: false,
      mfaEnabled: false,
    });
    await this.invitations.markAccepted(ctx, invitation.id, userId, this.now().toISOString());

    await this.audit.record(ctx, {
      actorId: userId,
      action: 'invitation.accept',
      resourceType: 'user',
      resourceId: userId,
      metadata: { invitationId: invitation.id },
    });
    return user;
  }

  /** Revoke a pending invitation so its token can no longer be accepted. */
  async revokeInvitation(ctx: TenantContext, invitationId: string): Promise<Invitation> {
    const revoked = await this.invitations.markRevoked(ctx, invitationId);
    if (revoked === null) {
      throw new TenancyNotFoundError('invitation', invitationId);
    }
    await this.audit.record(ctx, {
      action: 'invitation.revoke',
      resourceType: 'user',
      resourceId: invitationId,
    });
    return revoked;
  }

  // -------------------------------------------------------------------------
  // Assignment (Req 20.4).
  // -------------------------------------------------------------------------

  /**
   * Assign a user to a Team and/or Project by creating a membership (Req 20.4).
   * The user and any referenced Team/Project are resolved within the caller's
   * Organization first, so a user can never be associated with another tenant's
   * Team/Project. At least one of `teamId`/`projectId` must be supplied.
   */
  async assignUser(
    ctx: TenantContext,
    userId: string,
    target: MembershipTarget,
  ): Promise<Membership> {
    if (target.teamId === undefined && target.projectId === undefined) {
      throw new TenancyNotFoundError('membership target', 'none');
    }

    const user = await this.users.findById(ctx, userId);
    if (user === null) {
      throw new TenancyNotFoundError('user', userId);
    }
    if (target.teamId !== undefined) {
      const team = await this.teams.findById(ctx, target.teamId);
      if (team === null) {
        throw new TenancyNotFoundError('team', target.teamId);
      }
    }
    if (target.projectId !== undefined) {
      const project = await this.projects.findById(ctx, target.projectId);
      if (project === null) {
        throw new TenancyNotFoundError('project', target.projectId);
      }
    }

    const membership = await this.memberships.create(ctx, {
      id: this.ids.id(),
      userId,
      teamId: target.teamId ?? null,
      projectId: target.projectId ?? null,
    });
    await this.audit.record(ctx, {
      action: 'user.assign',
      resourceType: 'membership',
      resourceId: membership.id,
      metadata: { userId, teamId: membership.teamId, projectId: membership.projectId },
    });
    return membership;
  }

  /** List a user's memberships within the caller's Organization. */
  async listMemberships(ctx: TenantContext, userId: string): Promise<Membership[]> {
    return this.memberships.listByUser(ctx, userId);
  }
}
