/**
 * Tenant-scoped repositories backing the Tenancy_Service (Req 1, 20).
 *
 * Every repository here (except the Organization root) extends
 * {@link TenantScopedRepository}, so it inherits the always-injected
 * `organization_id` predicate — no tenancy query can cross an Organization
 * boundary (Req 1.2, 1.4). Each maps between the snake_case SQL rows
 * (migrations 0002 and 0013) and the camelCase domain records in `./types`.
 *
 * The {@link OrganizationRepository} is the one special case: organizations are
 * the tenancy *root* and carry no `organization_id` column (their own `id` is
 * the tenant key). Creating an Organization establishes a new tenant boundary
 * and therefore cannot itself be tenant-scoped; reads/updates are scoped by the
 * caller's `organizationId`, which must equal the row's `id`.
 */

import type { Role, TenantContext } from '@auxify/types';

import { TenantScopedRepository, type ListOptions } from '../repositories/base-repository.js';
import { assertTenantContext } from '../repositories/errors.js';
import { ParamCollector, renderInsertColumns, type ColumnValue } from '../repositories/sql.js';
import type { SqlClient, SqlRow } from '../storage/pgvector.js';
import type {
  Budget,
  Invitation,
  InvitationStatus,
  MfaPolicy,
  Membership,
  Organization,
  Project,
  Team,
  User,
  UserStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Small row-mapping helpers (cross the SQL ↔ domain boundary safely).
// ---------------------------------------------------------------------------

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Parse a JSONB column that may arrive as a string or already-parsed value. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/** Coerce a Postgres TEXT[]/array column into a string array. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === null || value === undefined) return [];
  // Some drivers may return JSON-encoded arrays as strings.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) return (JSON.parse(trimmed) as unknown[]).map((v) => String(v));
  }
  return [];
}

// ---------------------------------------------------------------------------
// OrganizationRepository — the tenancy root (no organization_id column).
// ---------------------------------------------------------------------------

/** Fields persisted by {@link OrganizationRepository.insert}. */
export interface OrganizationRow {
  id: string;
  name: string;
  dataResidencyRegion: string | null;
  storageQuotaBytes: number;
  conversationRetentionDays: number;
  fileRetentionDays: number;
  mfaPolicy: MfaPolicy;
}

/**
 * Repository over `organizations`. Because organizations are the tenant root,
 * `insert` is not tenant-scoped (it creates the boundary); all other operations
 * are scoped by the caller's `organizationId` (which equals the row id).
 */
export class OrganizationRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly table = 'organizations',
  ) {}

  private toRecord(row: SqlRow): Organization {
    return {
      id: String(row.id),
      name: String(row.name ?? ''),
      dataResidencyRegion: stringOrNull(row.data_residency_region),
      storageQuotaBytes: Number(row.storage_quota_bytes ?? 0),
      conversationRetentionDays: Number(row.conversation_retention_days ?? 365),
      fileRetentionDays: Number(row.file_retention_days ?? 180),
      mfaPolicy: (stringOrNull(row.mfa_policy) ?? 'optional') as MfaPolicy,
      createdAt: String(row.created_at),
    };
  }

  /**
   * Create a new Organization (a new tenant boundary). This is a platform-level
   * operation and is intentionally not tenant-scoped.
   */
  async insert(row: OrganizationRow): Promise<Organization> {
    const params = new ParamCollector();
    const values: ColumnValue[] = [
      { column: 'id', value: row.id },
      { column: 'name', value: row.name },
      { column: 'data_residency_region', value: row.dataResidencyRegion },
      { column: 'storage_quota_bytes', value: row.storageQuotaBytes },
      { column: 'conversation_retention_days', value: row.conversationRetentionDays },
      { column: 'file_retention_days', value: row.fileRetentionDays },
      { column: 'mfa_policy', value: row.mfaPolicy },
    ];
    const { columns, placeholders } = renderInsertColumns(values, params);
    const text = `INSERT INTO ${this.table} (${columns}) VALUES (${placeholders}) RETURNING *`;
    const result = await this.sql.query(text, params.params);
    const created = result.rows[0];
    if (created === undefined) {
      throw new Error(`INSERT into ${this.table} returned no row`);
    }
    return this.toRecord(created);
  }

  /** Fetch the caller's Organization (scoped by id = ctx.organizationId), or `null`. */
  async findById(ctx: TenantContext): Promise<Organization | null> {
    assertTenantContext(ctx);
    const params = new ParamCollector();
    const text = `SELECT * FROM ${this.table} WHERE id = ${params.add(ctx.organizationId)} LIMIT 1`;
    const result = await this.sql.query(text, params.params);
    const row = result.rows[0];
    return row === undefined ? null : this.toRecord(row);
  }
}

// ---------------------------------------------------------------------------
// TeamRepository — direct organization_id scope.
// ---------------------------------------------------------------------------

/** Repository over `teams`, always scoped to the caller's Organization. */
export class TeamRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'teams') {
    super(sql, { table, scope: { kind: 'direct', column: 'organization_id' } });
  }

  private toRecord(row: SqlRow): Team {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      name: String(row.name ?? ''),
      budget: parseJson<Budget>(row.budget, {}),
      createdAt: String(row.created_at),
    };
  }

  /** Create a Team under the caller's Organization (Req 20.1). */
  async create(
    ctx: TenantContext,
    input: { id: string; name: string; budget: Budget },
  ): Promise<Team> {
    const row = await this.insertRow(ctx, [
      { column: 'id', value: input.id },
      { column: 'name', value: input.name },
      { column: 'budget', value: JSON.stringify(input.budget) },
    ]);
    return this.toRecord(row);
  }

  /** Fetch a Team by id within the caller's Organization, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<Team | null> {
    const row = await this.selectById(ctx, id);
    return row === null ? null : this.toRecord(row);
  }

  /** List Teams in the caller's Organization (most recent first). */
  async list(
    ctx: TenantContext,
    options: Pick<ListOptions, 'limit' | 'offset'> = {},
  ): Promise<Team[]> {
    const rows = await this.selectRows(ctx, {
      orderBy: 'created_at',
      direction: 'DESC',
      limit: options.limit,
      offset: options.offset,
    });
    return rows.map((row) => this.toRecord(row));
  }
}

// ---------------------------------------------------------------------------
// ProjectRepository — direct organization_id scope.
// ---------------------------------------------------------------------------

/** Repository over `projects`, always scoped to the caller's Organization. */
export class ProjectRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'projects') {
    super(sql, { table, scope: { kind: 'direct', column: 'organization_id' } });
  }

  private toRecord(row: SqlRow): Project {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      teamId: String(row.team_id),
      name: String(row.name ?? ''),
      accessList: toStringArray(row.access_list),
      budget: parseJson<Budget>(row.budget, {}),
      createdAt: String(row.created_at),
    };
  }

  /**
   * Create a Project under a Team with a name, access list, and budget
   * (Req 1.5, 20.2). The owning `team_id` and the caller's Organization are
   * persisted; the base layer guards against cross-tenant inserts.
   */
  async create(
    ctx: TenantContext,
    input: { id: string; teamId: string; name: string; accessList: string[]; budget: Budget },
  ): Promise<Project> {
    const row = await this.insertRow(ctx, [
      { column: 'id', value: input.id },
      { column: 'team_id', value: input.teamId },
      { column: 'name', value: input.name },
      { column: 'access_list', value: input.accessList },
      { column: 'budget', value: JSON.stringify(input.budget) },
    ]);
    return this.toRecord(row);
  }

  /** Fetch a Project by id within the caller's Organization, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<Project | null> {
    const row = await this.selectById(ctx, id);
    return row === null ? null : this.toRecord(row);
  }

  /** List Projects in the caller's Organization (most recent first). */
  async list(
    ctx: TenantContext,
    options: Pick<ListOptions, 'limit' | 'offset'> = {},
  ): Promise<Project[]> {
    const rows = await this.selectRows(ctx, {
      orderBy: 'created_at',
      direction: 'DESC',
      limit: options.limit,
      offset: options.offset,
    });
    return rows.map((row) => this.toRecord(row));
  }

  /**
   * Reassign a Project to a different Team within the same Organization
   * (Req 1.6). Returns the updated record, or `null` if no tenant-scoped
   * Project matched.
   */
  async reassignTeam(
    ctx: TenantContext,
    projectId: string,
    newTeamId: string,
  ): Promise<Project | null> {
    const row = await this.updateById(ctx, projectId, [{ column: 'team_id', value: newTeamId }]);
    return row === null ? null : this.toRecord(row);
  }
}

// ---------------------------------------------------------------------------
// UserRepository — direct organization_id scope.
// ---------------------------------------------------------------------------

/** Repository over `users`, always scoped to the caller's Organization. */
export class UserRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'users') {
    super(sql, { table, scope: { kind: 'direct', column: 'organization_id' } });
  }

  private toRecord(row: SqlRow): User {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      email: String(row.email ?? ''),
      roles: parseJson<Role[]>(row.roles, []),
      allowedModels: toStringArray(row.allowed_models),
      premiumAuthorized: Boolean(row.premium_authorized),
      status: (stringOrNull(row.status) ?? 'active') as UserStatus,
      mfaEnabled: Boolean(row.mfa_enabled),
      createdAt: String(row.created_at),
    };
  }

  /** Create a user account within the caller's Organization. */
  async create(
    ctx: TenantContext,
    input: {
      id: string;
      email: string;
      roles: Role[];
      allowedModels: string[];
      premiumAuthorized: boolean;
      mfaEnabled: boolean;
    },
  ): Promise<User> {
    const row = await this.insertRow(ctx, [
      { column: 'id', value: input.id },
      { column: 'email', value: input.email },
      { column: 'roles', value: JSON.stringify(input.roles) },
      { column: 'allowed_models', value: input.allowedModels },
      { column: 'premium_authorized', value: input.premiumAuthorized },
      { column: 'mfa_enabled', value: input.mfaEnabled },
    ]);
    return this.toRecord(row);
  }

  /** Fetch a user by id within the caller's Organization, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<User | null> {
    const row = await this.selectById(ctx, id);
    return row === null ? null : this.toRecord(row);
  }

  /** Fetch a user by email within the caller's Organization, or `null`. */
  async findByEmail(ctx: TenantContext, email: string): Promise<User | null> {
    const rows = await this.selectRows(ctx, {
      where: [{ column: 'email', value: email }],
      limit: 1,
    });
    const row = rows[0];
    return row === undefined ? null : this.toRecord(row);
  }

  /** List users in the caller's Organization (most recent first). */
  async list(
    ctx: TenantContext,
    options: Pick<ListOptions, 'limit' | 'offset'> = {},
  ): Promise<User[]> {
    const rows = await this.selectRows(ctx, {
      orderBy: 'created_at',
      direction: 'DESC',
      limit: options.limit,
      offset: options.offset,
    });
    return rows.map((row) => this.toRecord(row));
  }

  /** Replace a user's role set (Req 19.7, 20). */
  async setRoles(ctx: TenantContext, userId: string, roles: Role[]): Promise<User | null> {
    const row = await this.updateById(ctx, userId, [
      { column: 'roles', value: JSON.stringify(roles) },
    ]);
    return row === null ? null : this.toRecord(row);
  }

  /** Replace a user's permitted-model Allow_List (Req 20.6). */
  async setAllowedModels(
    ctx: TenantContext,
    userId: string,
    modelIds: string[],
  ): Promise<User | null> {
    const row = await this.updateById(ctx, userId, [{ column: 'allowed_models', value: modelIds }]);
    return row === null ? null : this.toRecord(row);
  }

  /** Set a user's lifecycle status (e.g. deactivate — Req 20.5). */
  async setStatus(ctx: TenantContext, userId: string, status: UserStatus): Promise<User | null> {
    const row = await this.updateById(ctx, userId, [{ column: 'status', value: status }]);
    return row === null ? null : this.toRecord(row);
  }
}

// ---------------------------------------------------------------------------
// MembershipRepository — direct organization_id scope.
// ---------------------------------------------------------------------------

/** Repository over `memberships`, always scoped to the caller's Organization. */
export class MembershipRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'memberships') {
    super(sql, { table, scope: { kind: 'direct', column: 'organization_id' } });
  }

  private toRecord(row: SqlRow): Membership {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      organizationId: String(row.organization_id),
      teamId: stringOrNull(row.team_id),
      projectId: stringOrNull(row.project_id),
      createdAt: String(row.created_at),
    };
  }

  /** Create a membership placing a user within a Team and/or Project (Req 20.4). */
  async create(
    ctx: TenantContext,
    input: { id: string; userId: string; teamId: string | null; projectId: string | null },
  ): Promise<Membership> {
    const row = await this.insertRow(ctx, [
      { column: 'id', value: input.id },
      { column: 'user_id', value: input.userId },
      { column: 'team_id', value: input.teamId },
      { column: 'project_id', value: input.projectId },
    ]);
    return this.toRecord(row);
  }

  /** List a user's memberships within the caller's Organization. */
  async listByUser(ctx: TenantContext, userId: string): Promise<Membership[]> {
    const rows = await this.selectRows(ctx, {
      where: [{ column: 'user_id', value: userId }],
      orderBy: 'created_at',
      direction: 'ASC',
    });
    return rows.map((row) => this.toRecord(row));
  }
}

// ---------------------------------------------------------------------------
// InvitationRepository — direct organization_id scope.
// ---------------------------------------------------------------------------

/** Repository over `invitations`, always scoped to the caller's Organization. */
export class InvitationRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'invitations') {
    super(sql, { table, scope: { kind: 'direct', column: 'organization_id' } });
  }

  private toRecord(row: SqlRow): Invitation {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      email: String(row.email ?? ''),
      roles: parseJson<Role[]>(row.roles, []),
      token: String(row.token),
      status: (stringOrNull(row.status) ?? 'pending') as InvitationStatus,
      invitedBy: stringOrNull(row.invited_by),
      acceptedUserId: stringOrNull(row.accepted_user_id),
      expiresAt: stringOrNull(row.expires_at),
      acceptedAt: stringOrNull(row.accepted_at),
      createdAt: String(row.created_at),
    };
  }

  /** Persist a pending invitation within the caller's Organization (Req 20.3). */
  async create(
    ctx: TenantContext,
    input: {
      id: string;
      email: string;
      roles: Role[];
      token: string;
      invitedBy: string | null;
      expiresAt: string | null;
    },
  ): Promise<Invitation> {
    const row = await this.insertRow(ctx, [
      { column: 'id', value: input.id },
      { column: 'email', value: input.email },
      { column: 'roles', value: JSON.stringify(input.roles) },
      { column: 'token', value: input.token },
      { column: 'status', value: 'pending' },
      { column: 'invited_by', value: input.invitedBy },
      { column: 'expires_at', value: input.expiresAt },
    ]);
    return this.toRecord(row);
  }

  /** Fetch an invitation by id within the caller's Organization, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<Invitation | null> {
    const row = await this.selectById(ctx, id);
    return row === null ? null : this.toRecord(row);
  }

  /** Fetch an invitation by its single-use token within the caller's Organization. */
  async findByToken(ctx: TenantContext, token: string): Promise<Invitation | null> {
    const rows = await this.selectRows(ctx, {
      where: [{ column: 'token', value: token }],
      limit: 1,
    });
    const row = rows[0];
    return row === undefined ? null : this.toRecord(row);
  }

  /** Mark an invitation accepted, recording the created user and timestamp. */
  async markAccepted(
    ctx: TenantContext,
    id: string,
    acceptedUserId: string,
    acceptedAt: string,
  ): Promise<Invitation | null> {
    const row = await this.updateById(ctx, id, [
      { column: 'status', value: 'accepted' },
      { column: 'accepted_user_id', value: acceptedUserId },
      { column: 'accepted_at', value: acceptedAt },
    ]);
    return row === null ? null : this.toRecord(row);
  }

  /** Mark a pending invitation revoked. */
  async markRevoked(ctx: TenantContext, id: string): Promise<Invitation | null> {
    const row = await this.updateById(ctx, id, [{ column: 'status', value: 'revoked' }]);
    return row === null ? null : this.toRecord(row);
  }
}
