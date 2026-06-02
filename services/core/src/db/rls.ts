/**
 * Row-Level Security session binding (the database-enforcement arm of tenant
 * isolation — design "Multi-Tenancy Model", Req 1.2, 1.4).
 *
 * Migration `0015_row_level_security.sql` enables and FORCEs RLS on every
 * tenant-scoped table and binds row visibility to the session GUC
 * `app.current_organization_id`. Those policies only do their job once a
 * connection has *set* that GUC to the caller's Organization. This module is
 * how request handlers (and any code running tenant-scoped queries) bind the
 * session before issuing queries, and reset it afterwards.
 *
 * Fail-closed by construction: every RLS policy compares against
 * `current_setting('app.current_organization_id', true)`, which returns SQL
 * NULL when the GUC is unset, so a connection that never calls
 * {@link setTenantSession} sees no rows. Binding the session is therefore the
 * thing that *grants* visibility to exactly one Organization, never widens it.
 *
 * The GUC is set with `SET LOCAL`, so the binding lives only for the duration
 * of the surrounding transaction and is automatically discarded on COMMIT or
 * ROLLBACK — the recommended pattern for request-scoped tenancy. Use
 * {@link withTenantSession} to run a unit of work inside a transaction with the
 * tenant bound for its lifetime; use {@link setTenantSession} /
 * {@link resetTenantSession} directly when managing the transaction yourself.
 *
 * This layer talks to PostgreSQL through the same narrow {@link SqlClient} port
 * used by the repositories and migration runner, so it is driver-agnostic and
 * unit-testable against a fake client.
 */

import type { TenantContext } from '@auxify/types';

import { assertTenantContext } from '../repositories/errors.js';
import type { SqlClient } from '../storage/pgvector.js';

/**
 * The custom GUC (session/transaction setting) RLS policies compare against.
 *
 * Kept here as the single source of truth so the helper and the migration use
 * the exact same setting name. Changing it requires updating
 * `0015_row_level_security.sql` to match.
 */
export const TENANT_SETTING = 'app.current_organization_id' as const;

/**
 * Validate an Organization id before it is interpolated into a `SET` command.
 *
 * `SET LOCAL` does not accept positional parameters for its *name*, and the
 * value must be embedded as a quoted literal, so we cannot rely on the driver's
 * parameter binding here. Instead we constrain the id to a conservative,
 * injection-safe character set (the same shape ids take everywhere else in the
 * platform: letters, digits, `-`, and `_`). Anything else is rejected before a
 * statement is built.
 */
const SAFE_ORG_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Thrown when an Organization id is unsafe to bind into a session setting. */
export class InvalidTenantSettingError extends Error {
  constructor(message = 'organizationId is not a valid tenant session value') {
    super(message);
    this.name = 'InvalidTenantSettingError';
  }
}

/**
 * Assert that an Organization id is safe to embed in a `SET LOCAL` command.
 *
 * @param organizationId The Organization id to validate.
 * @throws InvalidTenantSettingError if the id is empty or contains characters
 *   outside `[A-Za-z0-9_-]`.
 */
function assertSafeOrganizationId(
  organizationId: string,
): asserts organizationId is string {
  if (
    typeof organizationId !== 'string' ||
    organizationId.length === 0 ||
    !SAFE_ORG_ID_RE.test(organizationId)
  ) {
    throw new InvalidTenantSettingError(
      `organizationId must match ${SAFE_ORG_ID_RE} to bind the RLS session`,
    );
  }
}

/** Options for {@link setTenantSession}. */
export interface SetTenantSessionOptions {
  /**
   * Whether to scope the binding to the current transaction (`SET LOCAL`, the
   * default and recommended request-scoped behavior) or to the whole session
   * (`SET`). Use a session-wide binding only on a dedicated connection you fully
   * control and reset.
   */
  local?: boolean;
}

/**
 * Bind the database session/transaction to a single Organization for RLS.
 *
 * Issues `SET [LOCAL] app.current_organization_id = '<org>'` so every
 * subsequent query on this connection is filtered to the caller's Organization
 * by the policies from migration 0015. Pass the **same** connection used for the
 * ensuing queries (e.g. a checked-out client, not a pool that may hand out a
 * different backend per query).
 *
 * The value is bound via `set_config(...)` with a positional parameter so the
 * Organization id is never string-concatenated into SQL; it is additionally
 * validated by {@link assertSafeOrganizationId} as defense in depth.
 *
 * @param client The dedicated SQL connection that will run the tenant queries.
 * @param ctx The tenant context whose `organizationId` scopes the session.
 * @param options Whether to bind transaction-locally (default) or session-wide.
 * @throws MissingTenantContextError if `ctx` carries no usable Organization.
 * @throws InvalidTenantSettingError if the Organization id is unsafe.
 */
export async function setTenantSession(
  client: SqlClient,
  ctx: TenantContext,
  options: SetTenantSessionOptions = {},
): Promise<void> {
  assertTenantContext(ctx);
  assertSafeOrganizationId(ctx.organizationId);
  const isLocal = options.local ?? true;
  // set_config(setting, value, is_local) is the function form of SET; using it
  // lets us bind the *value* as a positional parameter ($2) rather than
  // interpolating it, while is_local ($3) chooses SET LOCAL vs SET.
  await client.query('SELECT set_config($1, $2, $3)', [
    TENANT_SETTING,
    ctx.organizationId,
    isLocal,
  ]);
}

/**
 * Clear the tenant binding on a connection, returning it to the fail-closed
 * default where no Organization is bound and RLS exposes no rows.
 *
 * Useful when a long-lived connection is reused across tenants outside a
 * transaction (where `SET LOCAL` would not auto-reset). Inside a transaction,
 * COMMIT/ROLLBACK already discards a `SET LOCAL` binding, so an explicit reset
 * is only needed for session-wide (`local: false`) bindings.
 *
 * @param client The connection to reset.
 */
export async function resetTenantSession(client: SqlClient): Promise<void> {
  // RESET restores the setting to its default (unset → current_setting(...,
  // true) returns NULL → no rows visible).
  await client.query(`RESET ${TENANT_SETTING}`);
}

/**
 * Run a unit of work with the tenant bound for the lifetime of a transaction.
 *
 * Opens a transaction, binds the session with `SET LOCAL` (so the binding is
 * automatically discarded when the transaction ends), runs `work`, then COMMITs
 * — or ROLLBACKs if `work` throws, re-throwing the original error. This is the
 * recommended entry point for request handlers: it guarantees the tenant scope
 * is set before any query runs and torn down afterwards, even on failure.
 *
 * @param client A dedicated connection (not a pool) to run the transaction on.
 * @param ctx The tenant context whose Organization scopes the transaction.
 * @param work The tenant-scoped work to perform; receives the same `client`.
 * @returns Whatever `work` resolves to.
 * @throws Re-throws any error from `work` after rolling back; binding/validation
 *   errors are thrown before the transaction is opened.
 */
export async function withTenantSession<T>(
  client: SqlClient,
  ctx: TenantContext,
  work: (client: SqlClient) => Promise<T>,
): Promise<T> {
  // Validate before opening a transaction so a bad context never starts one.
  assertTenantContext(ctx);
  assertSafeOrganizationId(ctx.organizationId);

  await client.query('BEGIN');
  try {
    await setTenantSession(client, ctx, { local: true });
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
