/**
 * Access_Control — the request-path authorization gate (Req 1.3, 1.7, 19.4,
 * 19.5, 19.6).
 *
 * Access_Control is the component that every request-serving service consults
 * before touching a resource. It composes the platform's fail-closed guards
 * into a single verdict, denying by default and granting only when *every*
 * stage passes. It does not itself read or merge policies — that is the
 * Policy_Engine's job — it orchestrates the guards and records every denial.
 *
 * ## Fail-closed decision pipeline
 *
 * `authorize` runs these stages in order; the first failing stage denies (and
 * audits), and reaching the end grants:
 *
 *   1. **Membership / cross-tenant (Req 1.3, 1.7).** The resource's owning
 *      Organization must be the principal's, and any Team/Project the resource
 *      is scoped to must be one the principal belongs to. A reference to an
 *      Organization/Team/Project the principal is not a member of is denied as
 *      a cross-tenant reference and audited.
 *   2. **Allow_List via the Policy_Engine (Req 19.2, 19.4, 19.8).** The injected
 *      Policy_Engine resolves whether an explicit Allow_List grant (with
 *      Organization > Team > User precedence) permits the action. No grant —
 *      including the default-deny path when no policy resolves — denies and
 *      audits.
 *   3. **Viewer resource restriction (Req 19.6).** A `viewer` is read-only and
 *      may access shared conversations and shared prompts only; a non-read-only
 *      action, or an unshared conversation/prompt, is denied and audited.
 *   4. **Model-tier gates (Req 19.5, 19.6, 20.6).** When the request names a
 *      model, {@link checkModelAccess} applies the viewer→Economy restriction,
 *      the Premium-authorization requirement, and the per-user allowed-model
 *      Allow_List. A failing gate denies and audits.
 *
 * Because each stage can only deny, the pipeline is fail-closed by
 * construction: a new resource kind, model, or action defaults to deny unless an
 * explicit grant and every membership/tier gate admit it (Property 2).
 *
 * ## Auditing every denial (Req 1.7, 19.4)
 *
 * Every denial — at any stage — is recorded through the injected
 * {@link AuditRecorder} port as an `access.denied` event scoped to the *actor's*
 * Organization (so a cross-tenant attempt is logged in the attacker's tenant,
 * not the target's). Allowed accesses record nothing. This honors the same
 * audit contract pinned down by Property 3.
 *
 * ## Dependency injection
 *
 * The Policy_Engine and Audit_Service are injected via the constructor as the
 * narrow {@link PolicyResolver} and {@link AuditRecorder} ports, so production
 * wires the real {@link import('../policy/index.js').PolicyEngine} and
 * {@link import('../audit/index.js').AuditService} while tests substitute fakes.
 */

import {
  tenantContextFromPrincipal,
  type Action,
  type Principal,
  type ResourceRef,
} from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import type { PolicyDecision } from '../policy/index.js';
import { AccessDeniedError } from './errors.js';
import { checkModelAccess, isViewer } from './model-access.js';
import type { AuthorizeOptions, AuthzDecision, AuthzDenialCode } from './types.js';

/**
 * The narrow Policy_Engine port Access_Control depends on (Req 19.4).
 *
 * The production {@link import('../policy/index.js').PolicyEngine} satisfies
 * this structurally; tests pass a fake resolver. Keeping the dependency as a
 * one-method port (rather than the concrete class) inverts the dependency so
 * Access_Control can be unit- and property-tested without a database.
 */
export interface PolicyResolver {
  /**
   * Resolve whether `principal` may perform `action` on `resource`, applying
   * Organization > Team > User precedence and defaulting to deny.
   */
  resolve(principal: Principal, resource: ResourceRef, action: Action): Promise<PolicyDecision>;
}

/** Construction dependencies for {@link AccessControl} (all injected). */
export interface AccessControlOptions {
  /** The Policy_Engine (or a fake) resolving Allow_List grants (Req 19.4). */
  policyEngine: PolicyResolver;
  /** The Audit_Service (or a fake) recording every denial (Req 1.7, 19.4). */
  auditRecorder: AuditRecorder;
}

/** The actions a `viewer` (a read-only role) may perform (Req 19.6). */
const VIEWER_READ_ONLY_ACTIONS: ReadonlySet<Action> = new Set<Action>(['read', 'list']);

/**
 * Resource types a viewer may access only when shared with them (Req 19.6):
 * shared conversations and shared prompts.
 */
const VIEWER_SHAREABLE_RESOURCE_TYPES: ReadonlySet<ResourceRef['type']> = new Set<
  ResourceRef['type']
>(['conversation', 'prompt_template']);

/** Build a denied {@link AuthzDecision}. */
function deny(denialCode: AuthzDenialCode, reason: string): AuthzDecision {
  return { allowed: false, reason, denialCode };
}

/**
 * Membership / cross-tenant check (Req 1.3, 1.7) — pure.
 *
 * Permits only when the resource's owning Organization is the principal's and
 * every Team/Project the resource is scoped to is one the principal belongs to.
 * Any other reference is a cross-tenant reference and is denied.
 *
 * @returns `null` when membership holds, or a `cross_tenant` denial otherwise.
 */
export function checkMembership(principal: Principal, resource: ResourceRef): AuthzDecision | null {
  if (resource.organizationId !== principal.organizationId) {
    return deny(
      'cross_tenant',
      `resource Organization "${resource.organizationId}" is not the principal's Organization`,
    );
  }
  if (resource.teamId !== undefined && !principal.teamIds.includes(resource.teamId)) {
    return deny(
      'cross_tenant',
      `principal is not a member of the resource's owning Team "${resource.teamId}"`,
    );
  }
  if (resource.projectId !== undefined && !principal.projectIds.includes(resource.projectId)) {
    return deny(
      'cross_tenant',
      `principal does not have access to the resource's owning Project "${resource.projectId}"`,
    );
  }
  return null;
}

/**
 * Viewer resource restriction (Req 19.6) — pure.
 *
 * A `viewer` is read-only and may access shared conversations and shared
 * prompts only. Returns `null` for non-viewers and for permitted viewer access;
 * otherwise a `viewer_resource_restricted` denial.
 */
export function checkViewerResource(
  principal: Principal,
  resource: ResourceRef,
  action: Action,
  options: AuthorizeOptions,
): AuthzDecision | null {
  if (!isViewer(principal)) return null;

  // Read-only: a viewer may only read/list, never mutate (Req 19.6).
  if (!VIEWER_READ_ONLY_ACTIONS.has(action)) {
    return deny(
      'viewer_resource_restricted',
      `viewer role is read-only and may not "${action}" a ${resource.type}`,
    );
  }

  // Conversations and prompts must be shared with the viewer (Req 19.6).
  if (VIEWER_SHAREABLE_RESOURCE_TYPES.has(resource.type) && options.shared !== true) {
    return deny(
      'viewer_resource_restricted',
      `viewer role may access shared ${resource.type}s only`,
    );
  }

  return null;
}

/**
 * Access_Control. Construct once with the Policy_Engine and Audit_Service
 * ports, then call {@link authorize} (non-throwing) or {@link authorizeOrThrow}
 * (request-path convenience) on every resource access.
 */
export class AccessControl {
  private readonly policyEngine: PolicyResolver;
  private readonly auditRecorder: AuditRecorder;

  constructor(options: AccessControlOptions) {
    this.policyEngine = options.policyEngine;
    this.auditRecorder = options.auditRecorder;
  }

  /**
   * Authorize `action` by `principal` on `resource`, returning the structured
   * verdict and recording every denial (Req 1.3, 1.7, 19.4, 19.5, 19.6).
   *
   * The decision is fail-closed: it is `allowed: true` only when membership, the
   * Allow_List (Policy_Engine), the viewer resource restriction, and — when a
   * model is supplied — the model-tier gates all pass. Any failing stage returns
   * a denial whose `denialCode` names the stage, after recording an
   * `access.denied` audit event in the principal's Organization.
   *
   * @param principal The authenticated actor.
   * @param resource The resource being acted on.
   * @param action The action being attempted.
   * @param options Optional model/sharing/request metadata (see {@link AuthorizeOptions}).
   * @returns The {@link AuthzDecision}; denials are audited as a side effect.
   */
  async authorize(
    principal: Principal,
    resource: ResourceRef,
    action: Action,
    options: AuthorizeOptions = {},
  ): Promise<AuthzDecision> {
    // Stage 1 — membership / cross-tenant (Req 1.3, 1.7).
    const membership = checkMembership(principal, resource);
    if (membership !== null) {
      return this.denied(principal, resource, action, membership, options);
    }

    // Stage 2 — Allow_List via the Policy_Engine (Req 19.2, 19.4, 19.8).
    const policyDecision = await this.policyEngine.resolve(principal, resource, action);
    if (!policyDecision.allowed) {
      const decision: AuthzDecision = {
        allowed: false,
        reason: policyDecision.reason,
        denialCode: 'policy_denied',
        policyDecision,
      };
      return this.denied(principal, resource, action, decision, options);
    }

    // Stage 3 — viewer resource restriction (Req 19.6).
    const viewerResource = checkViewerResource(principal, resource, action, options);
    if (viewerResource !== null) {
      return this.denied(principal, resource, action, viewerResource, options);
    }

    // Stage 4 — model-tier gates, only when the request names a model
    // (Req 19.5, 19.6, 20.6).
    if (options.model !== undefined) {
      const modelAccess = checkModelAccess(principal, options.model);
      if (!modelAccess.allowed) {
        const decision = deny(modelAccess.denialCode!, modelAccess.reason);
        return this.denied(principal, resource, action, decision, options);
      }
    }

    // Every stage passed — grant.
    return {
      allowed: true,
      reason: `authorized: ${action} on ${resource.type}`,
      policyDecision,
    };
  }

  /**
   * Like {@link authorize}, but throws {@link AccessDeniedError} on a denial
   * (after the denial is audited) and resolves to the allow {@link AuthzDecision}
   * otherwise. Request-path callers use this to fail closed with a single throw
   * site while retaining the full decision on the error.
   */
  async authorizeOrThrow(
    principal: Principal,
    resource: ResourceRef,
    action: Action,
    options: AuthorizeOptions = {},
  ): Promise<AuthzDecision> {
    const decision = await this.authorize(principal, resource, action, options);
    if (!decision.allowed) {
      throw new AccessDeniedError(decision);
    }
    return decision;
  }

  /**
   * Record an `access.denied` audit event for a denial and return the decision
   * unchanged (Req 1.7, 19.4). The event is scoped to the *actor's* Organization
   * so a cross-tenant attempt is logged in the actor's tenant; its metadata
   * carries the attempted action, the denial stage, and the reason.
   */
  private async denied(
    principal: Principal,
    resource: ResourceRef,
    action: Action,
    decision: AuthzDecision,
    options: AuthorizeOptions,
  ): Promise<AuthzDecision> {
    const ctx = tenantContextFromPrincipal(principal);
    await this.auditRecorder.record(ctx, {
      action: 'access.denied',
      resourceType: resource.type,
      resourceId: resource.id,
      actorId: principal.userId,
      ip: options.ip,
      userAgent: options.userAgent,
      metadata: {
        attemptedAction: action,
        denialCode: decision.denialCode,
        reason: decision.reason,
        resourceOrganizationId: resource.organizationId,
        ...(resource.teamId !== undefined ? { resourceTeamId: resource.teamId } : {}),
        ...(resource.projectId !== undefined ? { resourceProjectId: resource.projectId } : {}),
      },
    });
    return decision;
  }
}
