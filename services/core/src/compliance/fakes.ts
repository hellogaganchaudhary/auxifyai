/**
 * Test fakes and builders for the Compliance_Manager.
 *
 * The Compliance_Manager composes its ports — a {@link RetentionPolicyStore}, a
 * {@link LegalHoldStore}, the shared {@link AuditRecorder}, a
 * {@link ComplianceClock}, and the optional {@link RetentionEnforcer} /
 * {@link SubjectDataEraser} seams. These in-memory fakes let unit and property
 * tests drive the manager deterministically and inspect what was persisted,
 * audited, deleted/archived, and erased — without a database or any external
 * service:
 *
 *   - {@link InMemoryRetentionPolicyStore} models the tenant-scoped policy
 *     repository: Organization scoping and per-`(level, refId, resourceKind)`
 *     storage.
 *   - {@link InMemoryLegalHoldStore} models the tenant-scoped hold repository:
 *     create / find-by-id / release / find-active / list-active, isolating holds
 *     per Organization.
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert exactly which governance actions were audited (Req 38.2, 38.5,
 *     38.6).
 *   - {@link RecordingRetentionEnforcer} records every disposition applied so a
 *     test can assert the retention deletion fired (Req 38.2, 38.3).
 *   - {@link RecordingSubjectDataEraser} records every subject erased and reports
 *     a configurable {@link SubjectErasureOutcome} (Req 38.4, 38.5).
 *   - {@link MutableComplianceClock} is a hand-advanceable clock so retention
 *     timing is fully testable: fix "now", then advance it across a resource's
 *     retention deadline.
 *   - {@link makeTenant} / {@link makeResource} / {@link sequentialComplianceIdGenerator}
 *     are small builders with sensible defaults.
 *
 * These are imported directly from `./fakes.js` by the unit and property tests
 * (never from the package barrel), matching the established convention.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type { ComplianceIdGenerator } from './compliance-manager.js';
import type {
  ComplianceClock,
  LegalHold,
  RetainableResource,
  RetentionDisposition,
  RetentionEnforcer,
  RetentionPolicy,
  RetentionPolicyStore,
  RetentionResourceKind,
  RetentionScopeLevel,
  LegalHoldStore,
  SubjectDataEraser,
  SubjectErasureOutcome,
} from './types.js';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * A hand-advanceable {@link ComplianceClock}, so retention timing is fully
 * testable: fix "now" at construction, then {@link advance} it across a
 * resource's retention deadline (or {@link set} an absolute instant).
 */
export class MutableComplianceClock implements ComplianceClock {
  private current: number;

  /** @param startMs The initial "now" in epoch milliseconds (default 2026-01-01T00:00:00Z). */
  constructor(startMs: number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.current = startMs;
  }

  /** The current time in milliseconds since the Unix epoch. */
  now(): number {
    return this.current;
  }

  /** Advance the clock by `deltaMs` milliseconds. */
  advance(deltaMs: number): void {
    this.current += deltaMs;
  }

  /** Advance the clock by `days` days. */
  advanceDays(days: number): void {
    this.current += days * 24 * 60 * 60 * 1000;
  }

  /** Set the clock to an absolute epoch-millisecond instant. */
  set(absoluteMs: number): void {
    this.current = absoluteMs;
  }
}

// ---------------------------------------------------------------------------
// Audit recorder
// ---------------------------------------------------------------------------

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which governance actions were audited (Req 38.2, 38.5, 38.6).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({
      ctx: { ...ctx },
      event: { ...event, metadata: { ...(event.metadata ?? {}) } },
    });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `compliance.retention_applied`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Retention policy store
// ---------------------------------------------------------------------------

/** Clone a {@link RetentionPolicy} so stored rows cannot be mutated by callers. */
function clonePolicy(policy: RetentionPolicy): RetentionPolicy {
  return { ...policy };
}

/**
 * An in-memory {@link RetentionPolicyStore} keyed by
 * `(organizationId, level, refId, resourceKind)`, isolating policies per
 * Organization (Req 1.4).
 */
export class InMemoryRetentionPolicyStore implements RetentionPolicyStore {
  private readonly byKey = new Map<string, RetentionPolicy>();

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async get(
    organizationId: string,
    level: RetentionScopeLevel,
    refId: string,
    resourceKind: RetentionResourceKind,
  ): Promise<RetentionPolicy | null> {
    const found = this.byKey.get(key(organizationId, level, refId, resourceKind));
    return found !== undefined ? clonePolicy(found) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async set(policy: RetentionPolicy): Promise<void> {
    this.byKey.set(
      key(policy.organizationId, policy.level, policy.refId, policy.resourceKind),
      clonePolicy(policy),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async list(organizationId: string): Promise<RetentionPolicy[]> {
    return [...this.byKey.values()]
      .filter((p) => p.organizationId === organizationId)
      .map(clonePolicy);
  }
}

/** Compose the storage key for a retention policy. */
function key(
  organizationId: string,
  level: RetentionScopeLevel,
  refId: string,
  resourceKind: RetentionResourceKind,
): string {
  return `${organizationId}:${level}:${refId}:${resourceKind}`;
}

// ---------------------------------------------------------------------------
// Legal-hold store
// ---------------------------------------------------------------------------

/** Clone a {@link LegalHold} so stored rows cannot be mutated by callers. */
function cloneHold(hold: LegalHold): LegalHold {
  return { ...hold };
}

/**
 * An in-memory {@link LegalHoldStore} isolating holds per Organization
 * (Req 1.4). A resource is "held" when an `active` hold exists for its
 * `(resourceKind, resourceId)`.
 */
export class InMemoryLegalHoldStore implements LegalHoldStore {
  private readonly byId = new Map<string, LegalHold>();

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async create(hold: LegalHold): Promise<void> {
    this.byId.set(this.key(hold.organizationId, hold.id), cloneHold(hold));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findById(organizationId: string, holdId: string): Promise<LegalHold | null> {
    const found = this.byId.get(this.key(organizationId, holdId));
    return found !== undefined ? cloneHold(found) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async release(
    organizationId: string,
    holdId: string,
    releasedAt: string,
  ): Promise<LegalHold | null> {
    const found = this.byId.get(this.key(organizationId, holdId));
    if (found === undefined || found.status === 'released') {
      return null;
    }
    found.status = 'released';
    found.releasedAt = releasedAt;
    return cloneHold(found);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findActive(
    organizationId: string,
    resourceKind: RetentionResourceKind,
    resourceId: string,
  ): Promise<LegalHold | null> {
    for (const hold of this.byId.values()) {
      if (
        hold.organizationId === organizationId &&
        hold.status === 'active' &&
        hold.resourceKind === resourceKind &&
        hold.resourceId === resourceId
      ) {
        return cloneHold(hold);
      }
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listActive(organizationId: string): Promise<LegalHold[]> {
    return [...this.byId.values()]
      .filter((h) => h.organizationId === organizationId && h.status === 'active')
      .map(cloneHold);
  }

  private key(organizationId: string, holdId: string): string {
    return `${organizationId}:${holdId}`;
  }
}

// ---------------------------------------------------------------------------
// Optional seams
// ---------------------------------------------------------------------------

/** A disposition applied through the {@link RetentionEnforcer}. */
export interface AppliedDisposition {
  ctx: TenantContext;
  resourceId: string;
  resourceKind: RetentionResourceKind;
  disposition: RetentionDisposition;
}

/** A recording {@link RetentionEnforcer} capturing every disposition applied (Req 38.2, 38.3). */
export class RecordingRetentionEnforcer implements RetentionEnforcer {
  /** Every applied disposition, in order. */
  readonly applied: AppliedDisposition[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async apply(
    ctx: TenantContext,
    resource: RetainableResource,
    disposition: RetentionDisposition,
  ): Promise<void> {
    this.applied.push({
      ctx: { ...ctx },
      resourceId: resource.resourceId,
      resourceKind: resource.resourceKind,
      disposition,
    });
  }

  /** The number of dispositions applied so far. */
  get count(): number {
    return this.applied.length;
  }

  /** Whether a resource id was acted on. */
  has(resourceId: string): boolean {
    return this.applied.some((a) => a.resourceId === resourceId);
  }
}

/** A subject erased through the {@link SubjectDataEraser}. */
export interface ErasedSubject {
  ctx: TenantContext;
  subjectId: string;
}

/**
 * A recording {@link SubjectDataEraser} capturing every subject erased and
 * reporting a configurable {@link SubjectErasureOutcome} (Req 38.4, 38.5).
 */
export class RecordingSubjectDataEraser implements SubjectDataEraser {
  /** Every erased subject, in order. */
  readonly erased: ErasedSubject[] = [];
  /** The outcome reported for each erasure. */
  outcome: SubjectErasureOutcome;

  constructor(
    outcome: SubjectErasureOutcome = {
      erasedRecordCount: 3,
      erasedResourceKinds: ['conversation', 'file', 'message'],
    },
  ) {
    this.outcome = outcome;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async erase(ctx: TenantContext, subjectId: string): Promise<SubjectErasureOutcome> {
    this.erased.push({ ctx: { ...ctx }, subjectId });
    return {
      erasedRecordCount: this.outcome.erasedRecordCount,
      erasedResourceKinds: [...this.outcome.erasedResourceKinds],
    };
  }

  /** Whether a subject id was erased. */
  has(subjectId: string): boolean {
    return this.erased.some((e) => e.subjectId === subjectId);
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Build a {@link TenantContext} with sensible defaults; override field-by-field. */
export function makeTenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return { organizationId: 'org-1', userId: 'user-1', ...overrides };
}

/** Build a {@link RetainableResource} with sensible defaults; override field-by-field. */
export function makeResource(overrides: Partial<RetainableResource> = {}): RetainableResource {
  return {
    organizationId: 'org-1',
    resourceKind: 'conversation',
    resourceId: 'res-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A deterministic {@link ComplianceIdGenerator} handing out `hold-1`, `hold-2`,
 * … legal-hold ids, for assertion-friendly tests.
 */
export function sequentialComplianceIdGenerator(): ComplianceIdGenerator {
  let holdCounter = 0;
  return {
    holdId: () => `hold-${(holdCounter += 1)}`,
  };
}
