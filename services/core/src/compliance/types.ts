/**
 * Compliance_Manager domain types and injectable ports (Req 38.1-38.6, 28.6).
 *
 * The Compliance_Manager is the platform's data-governance gate: it enforces the
 * Organization's configured data-retention policy (Req 38.1-38.3), honours legal
 * holds (a held resource is exempt from retention deletion), supports data
 * subject deletion / right-to-erasure on offboarding (Req 38.4) and GDPR request
 * (Req 38.5), and — fail-closed — blocks any operation whose retention/privacy
 * compliance cannot be verified (Req 38.6). Every governance action is recorded
 * in the Audit_Service (Req 38.2, 38.5, 38.6, 28.6).
 *
 * This module is the contract layer. It defines:
 *   - the resource-kind and disposition vocabularies the policy is expressed in
 *     ({@link RetentionResourceKind}, {@link RetentionDisposition});
 *   - the per-scope retention policy ({@link RetentionPolicy}) and its scope
 *     model ({@link RetentionScope}, {@link RetentionScopeLevel}) with builders;
 *   - the legal-hold record ({@link LegalHold}) and its inputs;
 *   - the {@link RetainableResource} a retention evaluation runs over and the
 *     {@link RetentionDecision} it yields;
 *   - the data-subject-erasure shapes ({@link SubjectErasureRequest},
 *     {@link SubjectErasureResult}, {@link SubjectErasureOutcome});
 *   - the fail-closed verification shapes ({@link ComplianceOperation},
 *     {@link ComplianceDecision}, {@link ComplianceDenialCode}); and
 *   - the narrow injectable ports the manager composes — a tenant-scoped
 *     {@link RetentionPolicyStore} and {@link LegalHoldStore}, the shared
 *     {@link AuditRecorder}, an injectable {@link ComplianceClock}, and the
 *     optional {@link SubjectDataEraser}/{@link RetentionEnforcer} seams — so the
 *     manager is pure orchestration and fully unit-testable with the in-memory
 *     fakes in `./fakes.js`.
 *
 * Naming: every exported name is `Compliance`-/`Retention`-/`LegalHold`-prefixed
 * (and the clock is {@link ComplianceClock}, the scope builders are
 * `*RetentionScope`) so nothing collides at the shared `@auxify/core` barrel —
 * in particular the disposition is {@link RetentionDisposition} (not the
 * Document_Management_Service's `RetentionAction`) and the clock is not `Clock`.
 *
 * Tenancy: every policy and hold carries its `organizationId`; the stores require
 * the owning Organization on every call and confine the operation to it
 * (Req 1.2, 1.4), so no governance action crosses an Organization boundary.
 */

import type { TenantContext } from '@auxify/types';

export type { AuditRecorder, AuditEvent } from '../audit/index.js';

// --- Resource kinds and dispositions (Req 38.2, 38.3, 28.6) --------------

/**
 * The kind of governed resource a retention policy applies to (Req 38.1-38.3,
 * 28.6).
 *
 *  - `conversation` — chat conversations, retained for the Organization's
 *    configured period (default 365 days, Req 38.1, 38.2);
 *  - `file` — uploaded files, retained 180 days by default (Req 38.3);
 *  - `document` — Document_Management_Service documents, governed by their
 *    configured retention action when retention elapses (Req 28.6).
 */
export type RetentionResourceKind = 'conversation' | 'file' | 'document';

/** All {@link RetentionResourceKind} values, for iteration, validation, and test generators. */
export const RETENTION_RESOURCE_KINDS: readonly RetentionResourceKind[] = [
  'conversation',
  'file',
  'document',
] as const;

/** Narrow runtime guard that a value is a supported {@link RetentionResourceKind}. */
export function isRetentionResourceKind(value: unknown): value is RetentionResourceKind {
  return (
    typeof value === 'string' && (RETENTION_RESOURCE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The action applied when a resource reaches the end of its retention period.
 *
 * `delete` hard-deletes the resource (conversations and files are hard-deleted,
 * Req 38.2, 38.3); `archive` moves it out of active storage into long-term
 * archival (a document may be configured either way, Req 28.6). Named
 * {@link RetentionDisposition} (not `RetentionAction`) so it never collides with
 * the Document_Management_Service's identically-purposed type at the package
 * barrel.
 */
export type RetentionDisposition = 'delete' | 'archive';

/** All {@link RetentionDisposition} values, for iteration, validation, and test generators. */
export const RETENTION_DISPOSITIONS: readonly RetentionDisposition[] = [
  'delete',
  'archive',
] as const;

/** Narrow runtime guard that a value is a supported {@link RetentionDisposition}. */
export function isRetentionDisposition(value: unknown): value is RetentionDisposition {
  return typeof value === 'string' && (RETENTION_DISPOSITIONS as readonly string[]).includes(value);
}

// --- Retention bounds and defaults (Req 38.1, 38.3) ----------------------

/**
 * The minimum configurable retention period in days (Req 38.1).
 *
 * Conversation retention is "configurable between 30 days and unlimited", so a
 * finite retention period shorter than this is rejected by
 * {@link import('./compliance-manager.js').validateRetentionPolicy}.
 */
export const MIN_RETENTION_DAYS = 30;

/**
 * The platform default retention period (in days) for each resource kind, or
 * `null` for "unlimited" (never auto-deleted) (Req 38.1, 38.3).
 *
 * Conversations default to 365 days (Req 38.1) and files to 180 days (Req 38.3).
 * Documents have no platform-wide default — they are governed only when an
 * explicit policy (or the document's own configured retention) applies (Req
 * 28.6) — so their default is `null` (unlimited) until configured.
 */
export const DEFAULT_RETENTION_DAYS: Readonly<Record<RetentionResourceKind, number | null>> = {
  conversation: 365,
  file: 180,
  document: null,
};

// --- Scope model (Req 38.1) ----------------------------------------------

/**
 * The level of the tenant hierarchy a retention policy applies to.
 *
 * A policy may be set at the Organization, Team, or Project level; a resource's
 * effective policy is resolved with Project > Team > Organization precedence
 * (the most specific configured policy wins), defaulting to the per-kind
 * {@link DEFAULT_RETENTION_DAYS} when none is configured.
 */
export type RetentionScopeLevel = 'organization' | 'team' | 'project';

/** All {@link RetentionScopeLevel} values, for iteration, validation, and test generators. */
export const RETENTION_SCOPE_LEVELS: readonly RetentionScopeLevel[] = [
  'organization',
  'team',
  'project',
] as const;

/**
 * A tenant-qualified identity of the entity a retention policy is configured on.
 *
 * Every scope carries its owning {@link organizationId} so a policy is isolated
 * per Organization (Req 1.4): two Organizations that happen to use the same
 * Team/Project id never share a policy. {@link refId} is the id of the entity at
 * {@link level} — and equals {@link organizationId} when the level is
 * `organization`.
 */
export interface RetentionScope {
  /** The Organization that owns the scope (the tenant boundary). */
  organizationId: string;
  /** The hierarchy level the policy applies to. */
  level: RetentionScopeLevel;
  /** The id of the entity at {@link level}; equals {@link organizationId} for `organization`. */
  refId: string;
}

/** Build the Organization-level {@link RetentionScope} for an Organization. */
export function organizationRetentionScope(organizationId: string): RetentionScope {
  return { organizationId, level: 'organization', refId: organizationId };
}

/** Build the Team-level {@link RetentionScope} for a Team within an Organization. */
export function teamRetentionScope(organizationId: string, teamId: string): RetentionScope {
  return { organizationId, level: 'team', refId: teamId };
}

/** Build the Project-level {@link RetentionScope} for a Project within an Organization. */
export function projectRetentionScope(organizationId: string, projectId: string): RetentionScope {
  return { organizationId, level: 'project', refId: projectId };
}

// --- Retention policy (Req 38.1-38.3, 28.6) ------------------------------

/**
 * The fields a caller supplies to configure a retention policy (Req 38.1-38.3).
 *
 * {@link retentionDays} is the finite retention period in days, or `null` for
 * "unlimited" (the resource is never auto-deleted). A finite value must be at
 * least {@link MIN_RETENTION_DAYS} (Req 38.1). {@link disposition} defaults to
 * `delete` — the action applied when retention elapses (Req 38.2, 38.3, 28.6).
 */
export interface RetentionPolicyInput {
  /** The resource kind the policy governs. */
  resourceKind: RetentionResourceKind;
  /** The retention period in days, or `null` for unlimited. */
  retentionDays: number | null;
  /** The action applied when retention elapses; defaults to `delete`. */
  disposition?: RetentionDisposition;
}

/**
 * A persisted retention policy: a {@link RetentionPolicyInput} bound to a
 * {@link RetentionScope} with audit timestamps. Stored and read back through the
 * {@link RetentionPolicyStore}.
 */
export interface RetentionPolicy {
  /** The Organization that owns the policy (the tenant boundary). */
  organizationId: string;
  /** The hierarchy level the policy applies to. */
  level: RetentionScopeLevel;
  /** The id of the entity at {@link level}; equals {@link organizationId} for `organization`. */
  refId: string;
  /** The resource kind the policy governs. */
  resourceKind: RetentionResourceKind;
  /** The retention period in days, or `null` for unlimited (never auto-deleted). */
  retentionDays: number | null;
  /** The action applied when retention elapses (Req 38.2, 38.3, 28.6). */
  disposition: RetentionDisposition;
  /** ISO-8601 instant the policy was first set. */
  createdAt: string;
  /** ISO-8601 instant the policy was last updated. */
  updatedAt: string;
}

// --- Legal hold (a held resource is exempt from retention deletion) ------

/** A legal hold's lifecycle status. */
export type LegalHoldStatus = 'active' | 'released';

/** All {@link LegalHoldStatus} values, for iteration, validation, and test generators. */
export const LEGAL_HOLD_STATUSES: readonly LegalHoldStatus[] = ['active', 'released'] as const;

/**
 * A legal hold placed on a single governed resource.
 *
 * While a hold is `active`, the held resource is **exempt from retention
 * deletion** even when its retention period has elapsed — the obligation to
 * preserve it for litigation/investigation overrides the retention schedule.
 * Releasing the hold re-subjects the resource to retention.
 */
export interface LegalHold {
  /** The hold's stable unique id. */
  id: string;
  /** The Organization that owns the hold (the tenant boundary). */
  organizationId: string;
  /** The kind of resource the hold preserves. */
  resourceKind: RetentionResourceKind;
  /** The id of the held resource. */
  resourceId: string;
  /** The reason the hold was placed (e.g. a case/matter reference). */
  reason: string;
  /** The id of the principal who placed the hold. */
  placedBy: string;
  /** ISO-8601 instant the hold was placed. */
  placedAt: string;
  /** ISO-8601 instant the hold was released, when it is no longer active. */
  releasedAt?: string;
  /** Whether the hold is currently `active` (exempting) or `released`. */
  status: LegalHoldStatus;
}

/** The fields a caller supplies to place a legal hold. */
export interface LegalHoldInput {
  /** An explicit hold id; generated when omitted. */
  id?: string;
  /** The kind of resource to hold. */
  resourceKind: RetentionResourceKind;
  /** The id of the resource to hold. */
  resourceId: string;
  /** The reason for the hold. */
  reason: string;
  /** The principal placing the hold; defaults to the caller's `userId`. */
  placedBy?: string;
}

// --- Retention evaluation (Req 38.2, 38.3, 28.6) -------------------------

/**
 * A resource a retention evaluation runs over.
 *
 * Carries the resource's identity, kind, and creation instant ({@link createdAt})
 * from which its retention deadline is computed, plus the optional owning
 * {@link teamId}/{@link projectId} used to resolve the most specific applicable
 * policy (Project > Team > Organization).
 */
export interface RetainableResource {
  /** The Organization that owns the resource (must match the caller's tenant). */
  organizationId: string;
  /** The kind of resource. */
  resourceKind: RetentionResourceKind;
  /** The resource's stable unique id. */
  resourceId: string;
  /** ISO-8601 instant the resource was created (retention is measured from here). */
  createdAt: string;
  /** The owning Team, used to resolve a Team-level policy. */
  teamId?: string;
  /** The owning Project, used to resolve a Project-level policy. */
  projectId?: string;
}

/** Where a resource's effective retention policy was resolved from. */
export type RetentionPolicySource = 'project' | 'team' | 'organization' | 'default';

/**
 * The verdict for one {@link RetainableResource} from a retention evaluation
 * (Req 38.2, 38.3, 28.6).
 *
 * {@link due} is `true` only when the resource has a finite effective retention
 * period that has elapsed **and** it is not under an active legal hold. When an
 * active hold exempts the resource, {@link due} is `false` and
 * {@link heldByHoldId} names the hold. {@link disposition} is the action that
 * would be applied when due, {@link retentionUntil} is the computed deadline (or
 * `null` for unlimited), and {@link policySource} records where the effective
 * policy came from.
 */
export interface RetentionDecision {
  /** The resource evaluated. */
  resource: RetainableResource;
  /** Whether the resource is due for deletion now (past retention and not held). */
  due: boolean;
  /** The action that applies when due (Req 38.2, 38.3, 28.6). */
  disposition: RetentionDisposition;
  /** A human-readable explanation of the verdict. */
  reason: string;
  /** The computed retention deadline (ISO-8601), or `null` when unlimited. */
  retentionUntil: string | null;
  /** Where the effective policy was resolved from. */
  policySource: RetentionPolicySource;
  /** The id of the active legal hold exempting the resource, when one applies. */
  heldByHoldId?: string;
}

// --- Data subject erasure (Req 38.4, 38.5) -------------------------------

/**
 * Why a data-subject erasure is being performed (Req 38.4, 38.5).
 *
 *  - `offboarding` — a user was offboarded; their personal data must be deleted
 *    within 30 days (Req 38.4);
 *  - `gdpr_request` — a GDPR deletion request was received; the subject's
 *    personal data must be deleted within 72 hours and the deletion recorded
 *    (Req 38.5).
 */
export type SubjectErasureReason = 'offboarding' | 'gdpr_request';

/** All {@link SubjectErasureReason} values, for iteration, validation, and test generators. */
export const SUBJECT_ERASURE_REASONS: readonly SubjectErasureReason[] = [
  'offboarding',
  'gdpr_request',
] as const;

/** The fields a caller supplies to request a data-subject erasure. */
export interface SubjectErasureRequest {
  /** The id of the data subject whose personal data must be erased. */
  subjectId: string;
  /** Why the erasure is being performed (sets the completion deadline). */
  reason: SubjectErasureReason;
}

/**
 * The outcome the optional {@link SubjectDataEraser} port reports after deleting
 * a subject's personal data across the platform's stores (Req 38.4, 38.5).
 */
export interface SubjectErasureOutcome {
  /** The number of records erased across all stores. */
  erasedRecordCount: number;
  /** The kinds of resource erased (e.g. `conversation`, `file`, `message`). */
  erasedResourceKinds: string[];
}

/**
 * The recorded result of a data-subject erasure (Req 38.4, 38.5).
 *
 * {@link deadline} is the regulatory completion deadline computed from the
 * request reason — 30 days for offboarding (Req 38.4), 72 hours for a GDPR
 * request (Req 38.5). {@link outcome} is present only when a
 * {@link SubjectDataEraser} performed the deletion.
 */
export interface SubjectErasureResult {
  /** The subject whose data was erased. */
  subjectId: string;
  /** Why the erasure was performed. */
  reason: SubjectErasureReason;
  /** ISO-8601 instant the erasure was initiated and recorded. */
  erasedAt: string;
  /** ISO-8601 regulatory completion deadline (30d offboarding / 72h GDPR). */
  deadline: string;
  /** The deletion outcome, present when a {@link SubjectDataEraser} was injected. */
  outcome?: SubjectErasureOutcome;
}

// --- Fail-closed verification (Req 38.6) ---------------------------------

/**
 * An operation whose retention/privacy compliance the Compliance_Manager is
 * asked to verify before it proceeds (Req 38.6).
 *
 * {@link retentionVerified} and {@link privacyVerified} are the preconditions
 * the gate checks; either being absent or `false` causes a fail-closed block.
 */
export interface ComplianceOperation {
  /** A label for the operation, e.g. `conversation.export` (recorded on a block). */
  kind: string;
  /** The Organization the operation runs in (scopes the audit record). */
  organizationId: string;
  /** The kind of resource the operation targets, when applicable. */
  resourceKind?: RetentionResourceKind;
  /** The id of the resource the operation targets, when applicable. */
  resourceId?: string;
  /** Whether the operation's retention compliance has been verified. */
  retentionVerified?: boolean;
  /** Whether the operation's privacy compliance has been verified. */
  privacyVerified?: boolean;
}

/**
 * The fail-closed reason a {@link ComplianceDecision} blocked an operation
 * (Req 38.6).
 *
 *  - `retention_unverifiable` — the operation's retention compliance could not
 *    be verified;
 *  - `privacy_unverifiable` — the operation's privacy compliance could not be
 *    verified;
 *  - `verification_unavailable` — neither precondition was supplied at all, so
 *    the gate fails closed rather than assuming compliance.
 */
export type ComplianceDenialCode =
  | 'retention_unverifiable'
  | 'privacy_unverifiable'
  | 'verification_unavailable';

/**
 * The verdict returned by
 * {@link import('./compliance-manager.js').ComplianceManager.verifyCompliance}.
 *
 * `allowed` is `true` only when both retention and privacy compliance are
 * verified; otherwise it is `false` and {@link denialCode} names the fail-closed
 * reason. {@link reason} is a human-readable explanation for logs and audit
 * metadata.
 */
export interface ComplianceDecision {
  /** Whether the operation may proceed. Fail-closed: `false` unless fully verified. */
  allowed: boolean;
  /** A human-readable explanation of the verdict. */
  reason: string;
  /** The fail-closed reason for a block, present only when `allowed` is `false`. */
  denialCode?: ComplianceDenialCode;
}

// --- Injectable ports ----------------------------------------------------

/**
 * The clock the Compliance_Manager reads to fix "now" when stamping policies and
 * holds and when evaluating whether a retention period has elapsed.
 *
 * Injectable so tests can place a resource's creation instant and advance the
 * clock across its retention deadline deterministically. Named
 * {@link ComplianceClock} (not `Clock`) so it never collides with the
 * Model_Router's, Scheduler's, Cache_Manager's, or other clocks in the shared
 * `@auxify/core` barrel.
 */
export interface ComplianceClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link ComplianceClock}, backed by the global `Date.now`. */
export const systemComplianceClock: ComplianceClock = { now: () => Date.now() };

/**
 * The tenant-scoped persistence port for retention policies (Req 38.1-38.3).
 *
 * Implementations key a {@link RetentionPolicy} by
 * `(organizationId, level, refId, resourceKind)` so policies are isolated per
 * Organization (Req 1.4). The concrete backend is a tenant-scoped repository in
 * production; tests use the in-memory fake.
 */
export interface RetentionPolicyStore {
  /**
   * Return the policy configured for a scope and resource kind, or `null` when
   * none is set.
   */
  get(
    organizationId: string,
    level: RetentionScopeLevel,
    refId: string,
    resourceKind: RetentionResourceKind,
  ): Promise<RetentionPolicy | null>;
  /** Insert or replace a retention policy. */
  set(policy: RetentionPolicy): Promise<void>;
  /** List every policy configured within an Organization. */
  list(organizationId: string): Promise<RetentionPolicy[]>;
}

/**
 * The tenant-scoped persistence port for legal holds.
 *
 * Implementations isolate holds per Organization (Req 1.4). A resource is
 * "held" when {@link findActive} returns an `active` hold for its
 * `(resourceKind, resourceId)`; the concrete backend is a tenant-scoped
 * repository in production; tests use the in-memory fake.
 */
export interface LegalHoldStore {
  /** Persist a newly placed hold. */
  create(hold: LegalHold): Promise<void>;
  /** Fetch a hold by id within an Organization, or `null`. */
  findById(organizationId: string, holdId: string): Promise<LegalHold | null>;
  /**
   * Mark a hold released at the given instant. Returns the released hold, or
   * `null` if no matching active/known hold existed.
   */
  release(organizationId: string, holdId: string, releasedAt: string): Promise<LegalHold | null>;
  /**
   * Return the active hold for a resource, or `null` when the resource is not
   * held.
   */
  findActive(
    organizationId: string,
    resourceKind: RetentionResourceKind,
    resourceId: string,
  ): Promise<LegalHold | null>;
  /** List every active hold within an Organization. */
  listActive(organizationId: string): Promise<LegalHold[]>;
}

/**
 * The optional seam that actually deletes/archives a governed resource when its
 * retention period elapses (Req 38.2, 38.3, 28.6).
 *
 * The Compliance_Manager always records a retention deletion in the
 * Audit_Service; when a {@link RetentionEnforcer} is injected it additionally
 * applies the configured disposition to the backing store. Modelling it as a
 * narrow optional port keeps the manager decoupled from the concrete stores and
 * fully testable without them.
 */
export interface RetentionEnforcer {
  /**
   * Apply `disposition` to a resource that is due for retention action.
   *
   * @param ctx The tenant scope.
   * @param resource The resource to delete or archive.
   * @param disposition The configured action to apply.
   */
  apply(
    ctx: TenantContext,
    resource: RetainableResource,
    disposition: RetentionDisposition,
  ): Promise<void>;
}

/**
 * The optional seam that deletes a data subject's personal data across the
 * platform's stores (Req 38.4, 38.5).
 *
 * The Compliance_Manager always records a subject erasure in the Audit_Service;
 * when a {@link SubjectDataEraser} is injected it additionally performs the
 * deletion across stores and reports the {@link SubjectErasureOutcome}.
 */
export interface SubjectDataEraser {
  /**
   * Erase the subject's personal data across all stores within the caller's
   * Organization, returning what was deleted.
   *
   * @param ctx The tenant scope.
   * @param subjectId The data subject to erase.
   */
  erase(ctx: TenantContext, subjectId: string): Promise<SubjectErasureOutcome>;
}
