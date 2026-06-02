/**
 * Tenancy_Service (Req 1, 20).
 *
 * Implements the Organization → Team → Project hierarchy plus users,
 * memberships, invitations, assignment, project move, role-change application,
 * user deactivation, and the per-user permitted-model Allow_List. The service
 * associates every resource with exactly one Organization (Req 1.1, 1.2) and
 * records its tenancy mutations through an injected {@link AuditRecorder} port
 * (Req 1.6) — without a hard dependency on the concrete Audit_Service (task
 * 3.9). User deactivation hooks an optional {@link SessionInvalidator} so the
 * later Device_Manager (task 20.3) can revoke sessions (Req 20.5).
 *
 * Tenant isolation is inherited from the repository layer: every call requires
 * a {@link TenantContext} and injects the `organization_id` predicate, so no
 * tenancy operation crosses an Organization boundary (Req 1.4).
 */

export { TenancyService, type TenancyServiceOptions, type IdGenerator } from './service.js';

export {
  OrganizationRepository,
  TeamRepository,
  ProjectRepository,
  UserRepository,
  MembershipRepository,
  InvitationRepository,
  type OrganizationRow,
} from './repositories.js';

export {
  TenancyNotFoundError,
  InvitationNotAcceptableError,
  CrossOrganizationMoveError,
} from './errors.js';

export type {
  SessionInvalidator,
  Budget,
  MfaPolicy,
  UserStatus,
  InvitationStatus,
  Organization,
  Team,
  Project,
  User,
  Membership,
  Invitation,
  CreateOrganizationInput,
  CreateTeamInput,
  CreateProjectInput,
  CreateUserInput,
  InviteUserInput,
  AcceptInvitationInput,
  MembershipTarget,
} from './types.js';
