/**
 * Tenancy_Service domain errors (Req 1, 20).
 *
 * These make the service's fail-closed and not-found conditions explicit and
 * testable. They complement the repository-layer guards
 * ({@link MissingTenantContextError}, {@link CrossTenantReferenceError}) by
 * expressing tenancy *business-rule* failures: a referenced parent that does
 * not exist within the tenant, an invitation that cannot be accepted, or a
 * project move that would cross an Organization boundary.
 */

/** Thrown when a referenced tenancy resource does not exist within the tenant. */
export class TenancyNotFoundError extends Error {
  constructor(
    /** The kind of resource that was not found (e.g. `team`, `project`, `user`). */
    readonly resource: string,
    /** The id that was looked up. */
    readonly id: string,
  ) {
    super(`${resource} "${id}" was not found in the current organization`);
    this.name = 'TenancyNotFoundError';
  }
}

/**
 * Thrown when an invitation cannot be accepted (unknown token, already
 * accepted, revoked, or expired). The reason is carried for the caller and for
 * auditing, but no detail about other tenants is leaked.
 */
export class InvitationNotAcceptableError extends Error {
  constructor(readonly reason: 'not_found' | 'already_accepted' | 'revoked' | 'expired') {
    super(`Invitation cannot be accepted: ${reason}`);
    this.name = 'InvitationNotAcceptableError';
  }
}

/**
 * Thrown when a project move targets a Team outside the project's Organization.
 * Tenant scoping makes a cross-Organization move impossible by construction;
 * this error surfaces the attempt explicitly (Req 1.6).
 */
export class CrossOrganizationMoveError extends Error {
  constructor(message = 'A project can only be moved to a Team within the same Organization') {
    super(message);
    this.name = 'CrossOrganizationMoveError';
  }
}
