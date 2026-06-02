/**
 * The Compliance_Manager (Req 38.1-38.6, 28.6).
 *
 * The Compliance_Manager is the platform's data-governance gate. It enforces the
 * Organization's configured data-retention policy across conversations, files,
 * and documents (Req 38.1-38.3, 28.6); honours legal holds — a held resource is
 * exempt from retention deletion; supports data-subject deletion / right-to-
 * erasure on offboarding (Req 38.4) and on a GDPR request (Req 38.5); and —
 * fail-closed — blocks any operation whose retention/privacy compliance cannot be
 * verified (Req 38.6). Every governance action is recorded in the Audit_Service
 * (Req 38.2, 38.5, 38.6, 28.6).
 *
 * It is pure orchestration over a small set of injectable ports — a tenant-scoped
 * {@link RetentionPolicyStore} and {@link LegalHoldStore}, the shared
 * {@link AuditRecorder}, an injectable {@link ComplianceClock}, and the optional
 * {@link RetentionEnforcer}/{@link SubjectDataEraser} seams — so it is fully
 * unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * Public surface (one cluster per acceptance criterion):
 *   - {@link ComplianceManager.setRetentionPolicy} / {@link ComplianceManager.getRetentionPolicy}
 *     / {@link ComplianceManager.resolveRetentionDays} — set, read, and resolve a
 *     scope's validated retention policy (Req 38.1-38.3);
 *   - {@link ComplianceManager.placeLegalHold} / {@link ComplianceManager.releaseLegalHold}
 *     / {@link ComplianceManager.isOnLegalHold} — place, release, and test a
 *     legal hold that exempts a resource from retention deletion;
 *   - {@link ComplianceManager.evaluateRetention} — the non-mutating per-resource
 *     {@link RetentionDecision} (due iff past retention and not held, Req 38.2,
 *     38.3, Property 53);
 *   - {@link ComplianceManager.enforceRetention} — apply the configured
 *     disposition to every due-and-unheld resource, recording each deletion
 *     (Req 38.2, 38.3, 28.6);
 *   - {@link ComplianceManager.eraseSubject} — delete a subject's personal data
 *     and record it within the regulatory deadline (Req 38.4, 38.5);
 *   - {@link ComplianceManager.verifyCompliance} / {@link ComplianceManager.verifyOrThrow}
 *     — the fail-closed gate that blocks (and audits) an unverifiable operation
 *     (Req 38.6).
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import { ComplianceBlockedError, InvalidRetentionPolicyError, LegalHoldNotFoundError } from './errors.js';
import {
  GDPR_ERASURE_WINDOW_MS,
  OFFBOARDING_ERASURE_WINDOW_MS,
  decideCompliance,
  isPastRetention,
  retentionDueAtMs,
} from './retention.js';
import {
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RETENTION_DISPOSITIONS,
  systemComplianceClock,
  type AuditRecorder,
  type ComplianceClock,
  type ComplianceDecision,
  type ComplianceOperation,
  type LegalHold,
  type LegalHoldInput,
  type RetainableResource,
  type RetentionDecision,
  type RetentionDisposition,
  type RetentionEnforcer,
  type RetentionPolicy,
  type RetentionPolicyInput,
  type RetentionPolicySource,
  type RetentionPolicyStore,
  type RetentionResourceKind,
  type RetentionScope,
  type LegalHoldStore,
  type SubjectDataEraser,
  type SubjectErasureRequest,
  type SubjectErasureResult,
} from './types.js';

/** Generates unique ids for legal holds (injectable for deterministic tests). */
export interface ComplianceIdGenerator {
  /** A unique legal-hold id. */
  holdId(): string;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: ComplianceIdGenerator = {
  holdId: () => randomUUID(),
};

/** Construction options for the {@link ComplianceManager} (all but the optional seams required). */
export interface ComplianceManagerOptions {
  /** The tenant-scoped retention-policy store (Req 38.1-38.3). */
  policies: RetentionPolicyStore;
  /** The tenant-scoped legal-hold store. */
  holds: LegalHoldStore;
  /** The append-only audit sink; every governance action is recorded through it (Req 38.2, 38.5, 38.6). */
  audit: AuditRecorder;
  /** Optional clock for "now" (defaults to {@link systemComplianceClock}), for deterministic tests. */
  clock?: ComplianceClock;
  /** Optional seam that actually deletes/archives a due resource (Req 38.2, 38.3, 28.6). */
  enforcer?: RetentionEnforcer;
  /** Optional seam that erases a subject's personal data across stores (Req 38.4, 38.5). */
  eraser?: SubjectDataEraser;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: ComplianceIdGenerator;
}

/** The recorded outcome of an {@link ComplianceManager.enforceRetention} sweep. */
export interface EnforceRetentionResult {
  /** The decisions that were acted on (one per deleted/archived resource). */
  applied: RetentionDecision[];
  /** The resources skipped because an active legal hold exempted them. */
  exemptByHold: RetentionDecision[];
}

/**
 * The Compliance_Manager: enforces retention, honours legal holds, erases
 * subject data, and fail-closed-blocks unverifiable operations (Req 38.1-38.6).
 */
export class ComplianceManager {
  private readonly policies: RetentionPolicyStore;
  private readonly holds: LegalHoldStore;
  private readonly audit: AuditRecorder;
  private readonly clock: ComplianceClock;
  private readonly enforcer: RetentionEnforcer | undefined;
  private readonly eraser: SubjectDataEraser | undefined;
  private readonly ids: ComplianceIdGenerator;

  constructor(options: ComplianceManagerOptions) {
    this.policies = options.policies;
    this.holds = options.holds;
    this.audit = options.audit;
    this.clock = options.clock ?? systemComplianceClock;
    this.enforcer = options.enforcer;
    this.eraser = options.eraser;
    this.ids = options.idGenerator ?? defaultIdGenerator;
  }

  // --- Retention policy (Req 38.1-38.3) ----------------------------------

  /**
   * Set (insert or replace) the retention policy for a scope and resource kind
   * (Req 38.1-38.3).
   *
   * Validates the configuration ({@link InvalidRetentionPolicyError} on a finite
   * period below the 30-day minimum, a non-integer/negative period, an unknown
   * disposition, or a scope in a different Organization), persists it, and
   * records an immutable `compliance.retention_policy_set` audit event.
   *
   * @param ctx The tenant context; its Organization must own the scope.
   * @param scope The scope the policy applies to.
   * @param input The resource kind, retention period (or `null` for unlimited), and disposition.
   * @returns The persisted {@link RetentionPolicy}.
   */
  async setRetentionPolicy(
    ctx: TenantContext,
    scope: RetentionScope,
    input: RetentionPolicyInput,
  ): Promise<RetentionPolicy> {
    this.assertScopeInTenant(ctx, scope);
    validateRetentionPolicy(input);

    const existing = await this.policies.get(
      scope.organizationId,
      scope.level,
      scope.refId,
      input.resourceKind,
    );
    const nowIso = this.nowIso();
    const policy: RetentionPolicy = {
      organizationId: scope.organizationId,
      level: scope.level,
      refId: scope.refId,
      resourceKind: input.resourceKind,
      retentionDays: input.retentionDays,
      disposition: input.disposition ?? 'delete',
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    await this.policies.set(policy);

    await this.audit.record(ctx, {
      action: 'compliance.retention_policy_set',
      resourceType: 'policy',
      resourceId: policyKey(scope, input.resourceKind),
      timestamp: nowIso,
      metadata: {
        level: scope.level,
        refId: scope.refId,
        resourceKind: input.resourceKind,
        retentionDays: input.retentionDays,
        disposition: policy.disposition,
      },
    });

    return policy;
  }

  /**
   * Return the retention policy configured directly on a scope for a resource
   * kind, or `null` when none is set on that exact scope.
   *
   * @param scope The scope to read.
   * @param resourceKind The resource kind to read the policy for.
   */
  async getRetentionPolicy(
    scope: RetentionScope,
    resourceKind: RetentionResourceKind,
  ): Promise<RetentionPolicy | null> {
    return this.policies.get(scope.organizationId, scope.level, scope.refId, resourceKind);
  }

  /**
   * Resolve the effective retention period (days, or `null` for unlimited) for a
   * resource, applying Project > Team > Organization precedence and falling back
   * to the per-kind {@link DEFAULT_RETENTION_DAYS} when no policy is configured
   * (Req 38.1, 38.3).
   *
   * @param resource The resource whose effective retention is resolved.
   * @returns The resolved retention days/disposition and where it came from.
   */
  async resolveRetentionDays(resource: RetainableResource): Promise<{
    retentionDays: number | null;
    disposition: RetentionDisposition;
    source: RetentionPolicySource;
  }> {
    const org = resource.organizationId;
    const kind = resource.resourceKind;

    if (resource.projectId !== undefined) {
      const projectPolicy = await this.policies.get(org, 'project', resource.projectId, kind);
      if (projectPolicy !== null) {
        return {
          retentionDays: projectPolicy.retentionDays,
          disposition: projectPolicy.disposition,
          source: 'project',
        };
      }
    }
    if (resource.teamId !== undefined) {
      const teamPolicy = await this.policies.get(org, 'team', resource.teamId, kind);
      if (teamPolicy !== null) {
        return {
          retentionDays: teamPolicy.retentionDays,
          disposition: teamPolicy.disposition,
          source: 'team',
        };
      }
    }
    const orgPolicy = await this.policies.get(org, 'organization', org, kind);
    if (orgPolicy !== null) {
      return {
        retentionDays: orgPolicy.retentionDays,
        disposition: orgPolicy.disposition,
        source: 'organization',
      };
    }
    return {
      retentionDays: DEFAULT_RETENTION_DAYS[kind],
      disposition: 'delete',
      source: 'default',
    };
  }

  // --- Legal hold (a held resource is exempt from retention deletion) ----

  /**
   * Place a legal hold on a single governed resource, exempting it from
   * retention deletion while active. Records a `compliance.legal_hold_placed`
   * audit event.
   *
   * @param ctx The tenant context; the hold is scoped to its Organization.
   * @param input The resource to hold and the reason.
   * @returns The persisted active {@link LegalHold}.
   */
  async placeLegalHold(ctx: TenantContext, input: LegalHoldInput): Promise<LegalHold> {
    const nowIso = this.nowIso();
    const hold: LegalHold = {
      id: input.id ?? this.ids.holdId(),
      organizationId: ctx.organizationId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      reason: input.reason,
      placedBy: input.placedBy ?? ctx.userId,
      placedAt: nowIso,
      status: 'active',
    };
    await this.holds.create(hold);

    await this.audit.record(ctx, {
      action: 'compliance.legal_hold_placed',
      resourceType: this.auditResourceType(input.resourceKind),
      resourceId: input.resourceId,
      timestamp: nowIso,
      metadata: { holdId: hold.id, resourceKind: input.resourceKind, reason: input.reason },
    });

    return hold;
  }

  /**
   * Release an active legal hold, re-subjecting its resource to retention.
   * Records a `compliance.legal_hold_released` audit event. Fails closed with
   * {@link LegalHoldNotFoundError} when no such hold exists in the Organization.
   *
   * @param ctx The tenant context.
   * @param holdId The id of the hold to release.
   * @returns The released {@link LegalHold}.
   */
  async releaseLegalHold(ctx: TenantContext, holdId: string): Promise<LegalHold> {
    const nowIso = this.nowIso();
    const released = await this.holds.release(ctx.organizationId, holdId, nowIso);
    if (released === null) {
      throw new LegalHoldNotFoundError(holdId);
    }

    await this.audit.record(ctx, {
      action: 'compliance.legal_hold_released',
      resourceType: this.auditResourceType(released.resourceKind),
      resourceId: released.resourceId,
      timestamp: nowIso,
      metadata: { holdId: released.id, resourceKind: released.resourceKind },
    });

    return released;
  }

  /**
   * Whether a resource currently has an active legal hold (and is therefore
   * exempt from retention deletion).
   *
   * @param organizationId The owning Organization.
   * @param resourceKind The kind of resource.
   * @param resourceId The id of the resource.
   */
  async isOnLegalHold(
    organizationId: string,
    resourceKind: RetentionResourceKind,
    resourceId: string,
  ): Promise<boolean> {
    return (await this.holds.findActive(organizationId, resourceKind, resourceId)) !== null;
  }

  // --- Retention evaluation + enforcement (Req 38.2, 38.3, 28.6) ---------

  /**
   * Evaluate, without mutating anything, whether a resource is due for its
   * configured retention disposition now (Req 38.2, 38.3, Property 53).
   *
   * A resource is `due` iff it has a finite effective retention period that has
   * elapsed **and** it is not under an active legal hold. An active hold exempts
   * the resource (`due: false`, naming the hold); an unlimited policy is never
   * due. The decision also reports the disposition that would apply, the
   * computed deadline, and where the effective policy came from.
   *
   * @param resource The resource to evaluate.
   * @returns The non-mutating {@link RetentionDecision}.
   */
  async evaluateRetention(resource: RetainableResource): Promise<RetentionDecision> {
    const { retentionDays, disposition, source } = await this.resolveRetentionDays(resource);
    const createdAtMs = Date.parse(resource.createdAt);
    const deadlineMs = retentionDueAtMs(createdAtMs, retentionDays);
    const retentionUntil = deadlineMs === null ? null : new Date(deadlineMs).toISOString();

    const past = isPastRetention(createdAtMs, this.clock.now(), retentionDays);

    if (!past) {
      return {
        resource,
        due: false,
        disposition,
        reason:
          retentionDays === null
            ? 'retention is unlimited; never due for deletion'
            : 'within retention period; not yet due',
        retentionUntil,
        policySource: source,
      };
    }

    // Past retention — but an active legal hold exempts the resource.
    const activeHold = await this.holds.findActive(
      resource.organizationId,
      resource.resourceKind,
      resource.resourceId,
    );
    if (activeHold !== null) {
      return {
        resource,
        due: false,
        disposition,
        reason: `past retention but exempt: under active legal hold "${activeHold.id}"`,
        retentionUntil,
        policySource: source,
        heldByHoldId: activeHold.id,
      };
    }

    return {
      resource,
      due: true,
      disposition,
      reason: 'past retention and not under legal hold; due for retention action',
      retentionUntil,
      policySource: source,
    };
  }

  /**
   * Apply the configured retention disposition to every due-and-unheld resource
   * in `resources`, recording each deletion in the Audit_Service (Req 38.2,
   * 38.3, 28.6).
   *
   * Each resource is evaluated via {@link evaluateRetention}: a resource still
   * within retention or exempt under an active legal hold is left untouched (so
   * nothing is removed early and nothing held is removed). For each due resource
   * the configured disposition is delegated to the optional
   * {@link RetentionEnforcer} (when injected) and a
   * `compliance.retention_applied` audit event is recorded.
   *
   * @param ctx The tenant context the sweep runs in.
   * @param resources The candidate resources to evaluate and act on.
   * @returns The decisions applied and those exempted by an active hold.
   */
  async enforceRetention(
    ctx: TenantContext,
    resources: RetainableResource[],
  ): Promise<EnforceRetentionResult> {
    const applied: RetentionDecision[] = [];
    const exemptByHold: RetentionDecision[] = [];

    for (const resource of resources) {
      const decision = await this.evaluateRetention(resource);
      if (decision.heldByHoldId !== undefined) {
        exemptByHold.push(decision);
        continue;
      }
      if (!decision.due) {
        continue;
      }

      if (this.enforcer !== undefined) {
        await this.enforcer.apply(ctx, resource, decision.disposition);
      }
      await this.audit.record(ctx, {
        action: 'compliance.retention_applied',
        resourceType: this.auditResourceType(resource.resourceKind),
        resourceId: resource.resourceId,
        timestamp: this.nowIso(),
        metadata: {
          resourceKind: resource.resourceKind,
          disposition: decision.disposition,
          retentionUntil: decision.retentionUntil,
          policySource: decision.policySource,
        },
      });
      applied.push(decision);
    }

    return { applied, exemptByHold };
  }

  // --- Data subject erasure (Req 38.4, 38.5) -----------------------------

  /**
   * Delete a data subject's personal data and record the deletion within the
   * regulatory deadline (Req 38.4, 38.5).
   *
   * The completion deadline is computed from the request reason — 30 days for
   * offboarding (Req 38.4), 72 hours for a GDPR request (Req 38.5). When a
   * {@link SubjectDataEraser} is injected it performs the deletion across stores
   * and its {@link import('./types.js').SubjectErasureOutcome} is recorded; in
   * all cases a `compliance.subject_erased` audit event is written (Req 38.5).
   *
   * @param ctx The tenant context the erasure runs in.
   * @param request The subject id and the reason (which sets the deadline).
   * @returns The recorded {@link SubjectErasureResult}.
   */
  async eraseSubject(
    ctx: TenantContext,
    request: SubjectErasureRequest,
  ): Promise<SubjectErasureResult> {
    const nowMs = this.clock.now();
    const erasedAt = new Date(nowMs).toISOString();
    const windowMs =
      request.reason === 'gdpr_request' ? GDPR_ERASURE_WINDOW_MS : OFFBOARDING_ERASURE_WINDOW_MS;
    const deadline = new Date(nowMs + windowMs).toISOString();

    const result: SubjectErasureResult = {
      subjectId: request.subjectId,
      reason: request.reason,
      erasedAt,
      deadline,
    };
    if (this.eraser !== undefined) {
      result.outcome = await this.eraser.erase(ctx, request.subjectId);
    }

    await this.audit.record(ctx, {
      action: 'compliance.subject_erased',
      resourceType: 'user',
      resourceId: request.subjectId,
      timestamp: erasedAt,
      metadata: {
        reason: request.reason,
        deadline,
        erasedRecordCount: result.outcome?.erasedRecordCount ?? null,
        erasedResourceKinds: result.outcome?.erasedResourceKinds ?? null,
      },
    });

    return result;
  }

  // --- Fail-closed verification (Req 38.6) -------------------------------

  /**
   * Verify whether an operation's retention/privacy compliance can be confirmed,
   * returning the structured verdict and recording every block (Req 38.6).
   *
   * The decision is fail-closed: it is `allowed: true` only when **both**
   * retention and privacy compliance are verified. An operation that supplies
   * neither precondition blocks with `verification_unavailable` rather than
   * assuming compliance. Any block records a `compliance.blocked` audit event in
   * the Organization before returning.
   *
   * @param ctx The tenant context the operation runs in.
   * @param op The operation whose compliance is being verified.
   * @returns The {@link ComplianceDecision}; blocks are audited as a side effect.
   */
  async verifyCompliance(
    ctx: TenantContext,
    op: ComplianceOperation,
  ): Promise<ComplianceDecision> {
    const decision = decideCompliance(op);
    if (!decision.allowed) {
      await this.audit.record(ctx, {
        action: 'compliance.blocked',
        resourceType: op.resourceKind !== undefined ? this.auditResourceType(op.resourceKind) : 'policy',
        resourceId: op.resourceId ?? op.kind,
        timestamp: this.nowIso(),
        metadata: {
          operationKind: op.kind,
          denialCode: decision.denialCode,
          reason: decision.reason,
        },
      });
    }
    return decision;
  }

  /**
   * Like {@link verifyCompliance}, but throws {@link ComplianceBlockedError} on a
   * block (after the block is audited) and resolves to the allow
   * {@link ComplianceDecision} otherwise. Operation-path callers use this to fail
   * closed with a single throw site while retaining the full decision on the
   * error.
   *
   * @param ctx The tenant context the operation runs in.
   * @param op The operation whose compliance is being verified.
   */
  async verifyOrThrow(ctx: TenantContext, op: ComplianceOperation): Promise<ComplianceDecision> {
    const decision = await this.verifyCompliance(ctx, op);
    if (!decision.allowed) {
      throw new ComplianceBlockedError(op.kind, decision);
    }
    return decision;
  }

  // --- internals ---------------------------------------------------------

  /** The current time as an ISO-8601 instant from the injected clock. */
  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Map a governed resource kind to the shared audit `resourceType`. */
  private auditResourceType(kind: RetentionResourceKind): string {
    switch (kind) {
      case 'conversation':
        return 'conversation';
      case 'file':
        return 'file';
      case 'document':
        return 'document';
    }
  }

  /** Fail closed if a scope is not within the caller's Organization (Req 1.4). */
  private assertScopeInTenant(ctx: TenantContext, scope: RetentionScope): void {
    if (scope.organizationId !== ctx.organizationId) {
      throw new InvalidRetentionPolicyError(
        `scope Organization "${scope.organizationId}" does not match the tenant context Organization "${ctx.organizationId}"`,
      );
    }
  }
}

/** Compose a stable key for a policy, used as an audit resource id. */
function policyKey(scope: RetentionScope, resourceKind: RetentionResourceKind): string {
  return `${scope.level}:${scope.refId}:${resourceKind}`;
}

/**
 * Validate a retention policy configuration, throwing
 * {@link InvalidRetentionPolicyError} on any structurally invalid field
 * (Req 38.1).
 *
 * A finite retention period must be an integer of at least
 * {@link MIN_RETENTION_DAYS} days (Req 38.1); `null` (unlimited) is always
 * valid. The disposition, when supplied, must be a known
 * {@link RetentionDisposition}.
 *
 * @param input The policy configuration to validate.
 */
export function validateRetentionPolicy(input: RetentionPolicyInput): void {
  if (input.retentionDays !== null) {
    if (!Number.isInteger(input.retentionDays)) {
      throw new InvalidRetentionPolicyError(
        `retentionDays must be an integer number of days or null (unlimited)`,
      );
    }
    if (input.retentionDays < MIN_RETENTION_DAYS) {
      throw new InvalidRetentionPolicyError(
        `retentionDays must be at least ${MIN_RETENTION_DAYS} days or null (unlimited)`,
      );
    }
  }
  if (
    input.disposition !== undefined &&
    !(RETENTION_DISPOSITIONS as readonly string[]).includes(input.disposition)
  ) {
    throw new InvalidRetentionPolicyError(`unknown disposition "${String(input.disposition)}"`);
  }
}
