/**
 * Identity, tenancy, and authorization domain types.
 *
 * These types model the authenticated actor (`Principal`), the tenant scope
 * carried into the persistence layer (`TenantContext`), and the references
 * (`ResourceRef`, `Action`) that the Policy_Engine and Access_Control evaluate.
 * They are reused verbatim by the backend services, the Client_SDK, and the
 * web client so that authorization shapes never drift between layers
 * (Req 46.8).
 */

/**
 * Platform roles in ascending privilege.
 *
 * Roles drive coarse-grained capability gating; fine-grained access is
 * resolved by the Policy_Engine and Access_Control on top of the role
 * (Req 19.1). A `viewer` is the most restricted role — limited to Economy
 * models, shared conversations, and shared prompts (Req 19.6).
 */
export type Role = 'super_admin' | 'admin' | 'power_user' | 'standard_user' | 'viewer';

/** All {@link Role} values, ordered least- to most-restricted-aware for iteration and validation. */
export const ROLES: readonly Role[] = [
  'super_admin',
  'admin',
  'power_user',
  'standard_user',
  'viewer',
] as const;

/**
 * The kinds of resources that can be referenced in an authorization decision.
 *
 * This is the single source of truth for resource kinds across the platform;
 * new native modules extend this union here rather than redefining it locally.
 */
export type ResourceType =
  | 'organization'
  | 'team'
  | 'project'
  | 'user'
  | 'membership'
  | 'policy'
  | 'conversation'
  | 'message'
  | 'persona'
  | 'prompt_template'
  | 'artifact'
  | 'file'
  | 'knowledge_collection'
  | 'knowledge_source'
  | 'knowledge_document'
  | 'knowledge_chunk'
  | 'knowledge_page'
  | 'channel'
  | 'channel_message'
  | 'document'
  | 'agent'
  | 'agent_run'
  | 'workflow'
  | 'usage_record'
  | 'api_key'
  | 'audit_log'
  | 'model';

/** All {@link ResourceType} values, for iteration, validation, and test generators. */
export const RESOURCE_TYPES: readonly ResourceType[] = [
  'organization',
  'team',
  'project',
  'user',
  'membership',
  'policy',
  'conversation',
  'message',
  'persona',
  'prompt_template',
  'artifact',
  'file',
  'knowledge_collection',
  'knowledge_source',
  'knowledge_document',
  'knowledge_chunk',
  'knowledge_page',
  'channel',
  'channel_message',
  'document',
  'agent',
  'agent_run',
  'workflow',
  'usage_record',
  'api_key',
  'audit_log',
  'model',
] as const;

/**
 * The operation a principal attempts to perform on a resource.
 *
 * Actions are the verbs that the Policy_Engine grants via Allow_List entries
 * and that Access_Control authorizes (Req 19.2-19.4).
 */
export type Action =
  | 'create'
  | 'read'
  | 'list'
  | 'update'
  | 'delete'
  | 'share'
  | 'export'
  | 'execute'
  | 'invoke'
  | 'approve'
  | 'manage';

/** All {@link Action} values, for iteration, validation, and test generators. */
export const ACTIONS: readonly Action[] = [
  'create',
  'read',
  'list',
  'update',
  'delete',
  'share',
  'export',
  'execute',
  'invoke',
  'approve',
  'manage',
] as const;

/**
 * A tenant-qualified reference to a resource, used as the subject of an
 * authorization decision.
 *
 * The owning `organizationId` (and, where applicable, `teamId`/`projectId`) is
 * carried alongside the id so Access_Control can deny and audit any reference
 * that crosses an Organization/Team/Project boundary (Req 1.3, 1.7).
 */
export interface ResourceRef {
  /** The kind of resource being referenced. */
  type: ResourceType;
  /** The resource's stable unique id. */
  id: string;
  /** The Organization that owns the resource. */
  organizationId: string;
  /** The owning Team, when the resource is team-scoped. */
  teamId?: string;
  /** The owning Project, when the resource is project-scoped. */
  projectId?: string;
}

/**
 * The authenticated actor on whose behalf a request is made.
 *
 * A `Principal` is derived from the authenticated session/identity and carries
 * exactly the facts authorization needs: the acting user, their Organization,
 * their roles, the Team/Project memberships used for ownership checks (Req 1.3),
 * the Allow_List of permitted models (Req 20.6), and whether Premium-tier
 * models are explicitly authorized (Req 19.5). It is request-time identity, not
 * the persisted user record.
 */
export interface Principal {
  /** The acting user's id. */
  userId: string;
  /** The Organization the user belongs to. */
  organizationId: string;
  /** The user's roles (Req 19.1). */
  roles: Role[];
  /** Teams the user is a member of (Req 1.3, 20.4). */
  teamIds: string[];
  /** Projects the user has access to (Req 1.3, 20.4). */
  projectIds: string[];
  /** The set of model ids the user is permitted to use (Allow_List, Req 20.6). */
  allowedModels: string[];
  /** Whether the user is explicitly authorized to use Premium-tier models (Req 19.5). */
  premiumAuthorized: boolean;
  /** The user's email, when available. */
  email?: string;
  /** The originating session id, when the principal comes from a user session. */
  sessionId?: string;
}

/**
 * The tenant scope required by every repository call.
 *
 * Derived from the authenticated {@link Principal}, a `TenantContext` lets the
 * repository layer automatically inject an `organization_id` predicate into
 * every query (application-layer scoping) and bind the database session for
 * Row-Level Security (Req 1.2, 1.4). `teamId`/`projectId` narrow the scope for
 * team- or project-scoped operations.
 */
export interface TenantContext {
  /** The Organization whose data the request may touch (always required). */
  organizationId: string;
  /** The acting user's id, for ownership predicates and auditing. */
  userId: string;
  /** Narrows the scope to a single Team, when applicable. */
  teamId?: string;
  /** Narrows the scope to a single Project, when applicable. */
  projectId?: string;
}

/**
 * Derive a {@link TenantContext} from an authenticated {@link Principal}.
 *
 * The resulting context always carries the principal's Organization and user
 * id; an optional `scope` narrows it to a specific Team and/or Project that the
 * principal must already be a member of. This is the canonical way services
 * obtain the tenant scope they pass to the repository layer (Req 1.2).
 *
 * @param principal The authenticated actor.
 * @param scope Optional Team/Project narrowing for the operation.
 * @returns A tenant context bound to the principal's Organization.
 */
export function tenantContextFromPrincipal(
  principal: Principal,
  scope?: { teamId?: string; projectId?: string },
): TenantContext {
  const context: TenantContext = {
    organizationId: principal.organizationId,
    userId: principal.userId,
  };
  if (scope?.teamId !== undefined) {
    context.teamId = scope.teamId;
  }
  if (scope?.projectId !== undefined) {
    context.projectId = scope.projectId;
  }
  return context;
}
