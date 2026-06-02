/**
 * Domain records, inputs, and ports for the Tenancy_Service (Req 1, 20).
 *
 * These types mirror the tenancy/identity schema (migration 0002) and the
 * invitations schema (migration 0013), and define the small ports the service
 * depends on by injection:
 *   - {@link AuditRecorder} (re-exported from `../audit`) records the immutable
 *     mutations the requirements call for (project move, role change, etc.).
 *   - {@link SessionInvalidator} is the seam through which user deactivation
 *     (Req 20.5) triggers session revocation; the concrete implementation is
 *     wired in task 20.3 (Device_Manager). Until then the Tenancy_Service marks
 *     the account deactivated (blocking authentication) and, when an invalidator
 *     is injected, asks it to revoke the user's active sessions.
 */

import type { Role } from '@auxify/types';

export type { AuditRecorder, AuditEvent } from '../audit/index.js';

/**
 * A configurable spend budget attached to a Team or Project (Req 20.1, 20.2).
 *
 * Stored as JSONB; the Budget_Manager (task 19.4) interprets the concrete
 * fields. The Tenancy_Service persists and returns it opaquely, so the shape
 * can evolve without a tenancy change.
 */
export type Budget = Record<string, unknown>;

/** The Organization's multi-factor-authentication policy (migration 0002). */
export type MfaPolicy = 'optional' | 'required';

/** A user account's lifecycle status (migration 0002). */
export type UserStatus = 'active' | 'deactivated';

/** An invitation's lifecycle status (migration 0013). */
export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

/**
 * The tenancy root. Every other resource is associated with exactly one
 * Organization (Req 1.1, 1.2).
 */
export interface Organization {
  id: string;
  name: string;
  dataResidencyRegion: string | null;
  storageQuotaBytes: number;
  conversationRetentionDays: number;
  fileRetentionDays: number;
  mfaPolicy: MfaPolicy;
  createdAt: string;
}

/** A Team within an Organization (Req 20.1). */
export interface Team {
  id: string;
  organizationId: string;
  name: string;
  budget: Budget;
  createdAt: string;
}

/**
 * A Project within a Team. Persisted with a name, owning Team, creation
 * timestamp, and access list (Req 1.5, 20.2).
 */
export interface Project {
  id: string;
  organizationId: string;
  teamId: string;
  name: string;
  accessList: string[];
  budget: Budget;
  createdAt: string;
}

/** A user account belonging to an Organization (migration 0002). */
export interface User {
  id: string;
  organizationId: string;
  email: string;
  roles: Role[];
  /** The per-user permitted-model Allow_List (Req 20.6). */
  allowedModels: string[];
  premiumAuthorized: boolean;
  status: UserStatus;
  mfaEnabled: boolean;
  createdAt: string;
}

/** A membership placing a user within a Team and/or Project (Req 20.4). */
export interface Membership {
  id: string;
  userId: string;
  organizationId: string;
  teamId: string | null;
  projectId: string | null;
  createdAt: string;
}

/** A pending/accepted/revoked user invitation (Req 20.3). */
export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  roles: Role[];
  token: string;
  status: InvitationStatus;
  invitedBy: string | null;
  acceptedUserId: string | null;
  expiresAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

/** Fields to create an Organization. `id` is generated when omitted. */
export interface CreateOrganizationInput {
  id?: string;
  name: string;
  dataResidencyRegion?: string | null;
  storageQuotaBytes?: number;
  conversationRetentionDays?: number;
  fileRetentionDays?: number;
  mfaPolicy?: MfaPolicy;
}

/** Fields to create a Team under the acting Organization (Req 20.1). */
export interface CreateTeamInput {
  id?: string;
  name: string;
  budget?: Budget;
}

/** Fields to create a Project under a Team (Req 1.5, 20.2). */
export interface CreateProjectInput {
  id?: string;
  /** The owning Team; it must belong to the acting Organization. */
  teamId: string;
  name: string;
  accessList?: string[];
  budget?: Budget;
}

/** Fields to create a user account directly (without an invitation). */
export interface CreateUserInput {
  id?: string;
  email: string;
  roles?: Role[];
  allowedModels?: string[];
  premiumAuthorized?: boolean;
  mfaEnabled?: boolean;
}

/** Fields to invite a user (Req 20.3). `id`/`token` are generated when omitted. */
export interface InviteUserInput {
  id?: string;
  email: string;
  roles?: Role[];
  token?: string;
  invitedBy?: string;
  expiresAt?: string | null;
}

/**
 * Fields to accept an invitation and create the user account (Req 20.3).
 *
 * The acceptance flow runs before the invitee is an authenticated principal, so
 * the owning `organizationId` (resolved from the invitation link/token by the
 * caller) is supplied explicitly to scope the operation to one Organization.
 */
export interface AcceptInvitationInput {
  organizationId: string;
  token: string;
  /** The id to assign the created user account. Generated when omitted. */
  userId?: string;
}

/**
 * The target of an assignment: a Team or a Project (Req 20.4).
 *
 * Exactly one of `teamId`/`projectId` identifies the target; both may be set to
 * place the user within a Project of a specific Team.
 */
export interface MembershipTarget {
  teamId?: string;
  projectId?: string;
}

/**
 * The seam through which user deactivation revokes active sessions (Req 20.5).
 *
 * The Tenancy_Service marks the account `deactivated` (which blocks future
 * authentication) and, when an invalidator is injected, asks it to revoke the
 * user's existing sessions. The concrete implementation arrives with the
 * Device_Manager (task 20.3); until then deactivation still blocks new
 * authentication via the persisted status.
 */
export interface SessionInvalidator {
  /**
   * Invalidate every active session/token for the given user.
   *
   * @param userId The user whose sessions must be revoked.
   */
  invalidateAllForUser(userId: string): Promise<void>;
}
