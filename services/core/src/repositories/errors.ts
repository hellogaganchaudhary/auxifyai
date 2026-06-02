/**
 * Repository-layer errors and the TenantContext guard (Req 1.2).
 *
 * The repository layer is the application-scoping arm of the platform's
 * defense-in-depth tenant isolation (design "Multi-Tenancy Model"): every call
 * requires a {@link TenantContext} and the layer automatically injects an
 * `organization_id` predicate into every statement. These errors make the
 * fail-closed behavior explicit and testable:
 *
 *   - {@link MissingTenantContextError} — a call reached the repository layer
 *     without a usable tenant scope. By API design this cannot happen through
 *     the typed surface; the runtime guard catches programmatic misuse (e.g.
 *     an `undefined` context passed through an `any`) so a query is never
 *     issued without tenant scoping.
 *   - {@link CrossTenantReferenceError} — a write referenced a parent record
 *     that does not belong to the caller's Organization (e.g. inserting a
 *     message under another tenant's conversation). The write is refused
 *     (Req 1.7 / "Access checks" deny + audit cross-tenant references).
 */

import type { TenantContext } from '@auxify/types';

/**
 * Thrown when a repository method is invoked without a valid
 * {@link TenantContext}. A valid context carries a non-empty `organizationId`
 * (the tenant predicate) and `userId` (ownership/audit).
 */
export class MissingTenantContextError extends Error {
  constructor(message = 'A TenantContext with organizationId and userId is required') {
    super(message);
    this.name = 'MissingTenantContextError';
  }
}

/**
 * Thrown when a write references a parent record outside the caller's tenant
 * (for example, creating a message under a conversation owned by another
 * Organization). The write is refused so it can never cross a tenant boundary.
 */
export class CrossTenantReferenceError extends Error {
  constructor(message = 'Referenced resource does not exist within the current tenant') {
    super(message);
    this.name = 'CrossTenantReferenceError';
  }
}

/** Narrow runtime check that a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Assert that `ctx` is a usable {@link TenantContext}, throwing
 * {@link MissingTenantContextError} otherwise.
 *
 * This is the runtime half of the "impossible to query without a tenant scope"
 * guarantee. The TypeScript surface already requires a `TenantContext` on every
 * method; this guard additionally rejects contexts forged through `any`/`null`
 * before any SQL is built.
 *
 * @param ctx The tenant context supplied to a repository call.
 */
export function assertTenantContext(
  ctx: TenantContext | null | undefined,
): asserts ctx is TenantContext {
  if (ctx === null || ctx === undefined || typeof ctx !== 'object') {
    throw new MissingTenantContextError();
  }
  if (!isNonEmptyString((ctx as TenantContext).organizationId)) {
    throw new MissingTenantContextError('A TenantContext.organizationId is required');
  }
  if (!isNonEmptyString((ctx as TenantContext).userId)) {
    throw new MissingTenantContextError('A TenantContext.userId is required');
  }
}
