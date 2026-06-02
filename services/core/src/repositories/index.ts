/**
 * Tenant-scoped repository layer (application-layer tenant scoping, Req 1.2, 44.1).
 *
 * Every repository here requires a {@link TenantContext} on every call and
 * automatically injects the Organization predicate into every SELECT/UPDATE/DELETE
 * (and sets/guards it on INSERT), so a query can never be issued without tenant
 * scoping. This is the application arm of the platform's defense-in-depth tenant
 * isolation; it complements the PostgreSQL Row-Level Security added in task 3.2.
 *
 * The layer talks to PostgreSQL through the narrow {@link SqlClient} port
 * (re-exported from the storage layer), so repositories are driver-agnostic and
 * unit-testable against a fake client.
 *
 * Surface:
 *   - {@link TenantScopedRepository} — abstract base centralizing org-predicate
 *     injection and parameter binding (direct column or parent-derived scope).
 *   - {@link TenantCrudRepository} — generic CRUD over any tenant-scoped table;
 *     later tasks instantiate or subclass it.
 *   - {@link ConversationRepository}, {@link MessageRepository} — concrete
 *     repositories over the task-2.3 schema demonstrating both scope strategies.
 *   - {@link MissingTenantContextError}, {@link CrossTenantReferenceError} — the
 *     fail-closed guards.
 */

// Narrow SQL port re-exported so consumers can depend on the repository layer
// alone for the driver-agnostic boundary.
export type { SqlClient, SqlRow, SqlQueryResult } from '../storage/pgvector.js';

// Fail-closed guards (Req 1.2, 1.7).
export {
  MissingTenantContextError,
  CrossTenantReferenceError,
  assertTenantContext,
} from './errors.js';

// Parameterized SQL fragment builders.
export {
  ParamCollector,
  renderPredicates,
  renderInsertColumns,
  renderSetClause,
  type Predicate,
  type ColumnValue,
} from './sql.js';

// Abstract base and its scope/option types.
export {
  TenantScopedRepository,
  type TenantScope,
  type DirectTenantScope,
  type ParentTenantScope,
  type TenantScopedRepositoryOptions,
  type ListOptions,
} from './base-repository.js';

// Generic tenant-scoped CRUD repository.
export { TenantCrudRepository, type RowValues } from './crud-repository.js';

// Concrete repositories over the conversations/messages schema.
export {
  ConversationRepository,
  type ConversationRecord,
  type ConversationShareMode,
  type CreateConversationInput,
  type UpdateConversationInput,
} from './conversation-repository.js';

export {
  MessageRepository,
  type MessageRecord,
  type MessageRole,
  type MessageRating,
  type CreateMessageInput,
  type UpdateMessageInput,
} from './message-repository.js';
