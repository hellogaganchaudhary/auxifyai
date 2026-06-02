/**
 * Unit tests for the Compliance_Manager (Req 38.1-38.6, 28.6).
 *
 * Exercises the full public surface against the deterministic in-memory fakes
 * (a hand-advanced clock, in-memory policy/hold stores, a capturing audit
 * recorder, and recording enforcer/eraser seams) imported directly from
 * `./fakes.js`:
 *
 *  - set + get a retention policy per scope, rejecting an invalid configuration
 *    (Req 38.1-38.3);
 *  - a legal hold exempts a held resource from retention deletion;
 *  - retention evaluation selects exactly the due-and-unheld resources
 *    (Req 38.2, 38.3, Property 53);
 *  - releasing a hold re-subjects the resource to retention;
 *  - tenant isolation between Organizations (Req 1.4);
 *  - subject erasure within the regulatory deadline (Req 38.4, 38.5);
 *  - fail-closed verification blocking an unverifiable operation (Req 38.6);
 *  - audit recording on every governance action (Req 38.2, 38.5, 38.6).
 */

import { describe, expect, it } from 'vitest';

import { ComplianceManager, validateRetentionPolicy } from './compliance-manager.js';
import {
  ComplianceBlockedError,
  InvalidRetentionPolicyError,
  LegalHoldNotFoundError,
} from './errors.js';
import {
  CapturingAuditRecorder,
  InMemoryLegalHoldStore,
  InMemoryRetentionPolicyStore,
  MutableComplianceClock,
  RecordingRetentionEnforcer,
  RecordingSubjectDataEraser,
  makeResource,
  makeTenant,
  sequentialComplianceIdGenerator,
} from './fakes.js';
import {
  organizationRetentionScope,
  projectRetentionScope,
  teamRetentionScope,
} from './types.js';
import type { RetentionPolicyInput } from './types.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** A fixed start instant so retention windows are unambiguous. */
const NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness {
  manager: ComplianceManager;
  policies: InMemoryRetentionPolicyStore;
  holds: InMemoryLegalHoldStore;
  audit: CapturingAuditRecorder;
  enforcer: RecordingRetentionEnforcer;
  eraser: RecordingSubjectDataEraser;
  clock: MutableComplianceClock;
}

/** Construct a ComplianceManager wired with deterministic in-memory fakes. */
function makeManager(): Harness {
  const policies = new InMemoryRetentionPolicyStore();
  const holds = new InMemoryLegalHoldStore();
  const audit = new CapturingAuditRecorder();
  const enforcer = new RecordingRetentionEnforcer();
  const eraser = new RecordingSubjectDataEraser();
  const clock = new MutableComplianceClock(NOW_MS);
  const manager = new ComplianceManager({
    policies,
    holds,
    audit,
    enforcer,
    eraser,
    clock,
    idGenerator: sequentialComplianceIdGenerator(),
  });
  return { manager, policies, holds, audit, enforcer, eraser, clock };
}

/** A baseline valid conversation retention policy (30-day period). */
function policy(overrides: Partial<RetentionPolicyInput> = {}): RetentionPolicyInput {
  return { resourceKind: 'conversation', retentionDays: 30, disposition: 'delete', ...overrides };
}

/** An ISO instant `days` before the harness "now". */
function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// setRetentionPolicy / getRetentionPolicy + validation (Req 38.1-38.3)
// ---------------------------------------------------------------------------

describe('ComplianceManager.setRetentionPolicy / getRetentionPolicy (Req 38.1-38.3)', () => {
  it('persists a retention policy and reads it back for the scope', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const scope = organizationRetentionScope('org-1');

    const stored = await manager.setRetentionPolicy(ctx, scope, policy({ retentionDays: 365 }));

    expect(stored.retentionDays).toBe(365);
    expect(stored.resourceKind).toBe('conversation');
    expect(stored.disposition).toBe('delete');
    expect(stored.level).toBe('organization');

    const fetched = await manager.getRetentionPolicy(scope, 'conversation');
    expect(fetched).not.toBeNull();
    expect(fetched?.retentionDays).toBe(365);
  });

  it('returns null when no policy is configured for a scope/kind', async () => {
    const { manager } = makeManager();
    expect(
      await manager.getRetentionPolicy(organizationRetentionScope('org-1'), 'file'),
    ).toBeNull();
  });

  it('accepts an unlimited (null) retention period', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    const stored = await manager.setRetentionPolicy(
      ctx,
      organizationRetentionScope('org-1'),
      policy({ retentionDays: null }),
    );
    expect(stored.retentionDays).toBeNull();
  });

  it('preserves createdAt while advancing updatedAt on replace', async () => {
    const { manager, clock } = makeManager();
    const ctx = makeTenant();
    const scope = organizationRetentionScope('org-1');

    const first = await manager.setRetentionPolicy(ctx, scope, policy({ retentionDays: 30 }));
    clock.advance(DAY_MS);
    const second = await manager.setRetentionPolicy(ctx, scope, policy({ retentionDays: 90 }));

    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
    expect(second.retentionDays).toBe(90);
  });

  it('rejects a finite retention period below the 30-day minimum (Req 38.1)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await expect(
      manager.setRetentionPolicy(ctx, organizationRetentionScope('org-1'), policy({ retentionDays: 29 })),
    ).rejects.toBeInstanceOf(InvalidRetentionPolicyError);
  });

  it('rejects a non-integer retention period', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await expect(
      manager.setRetentionPolicy(
        ctx,
        organizationRetentionScope('org-1'),
        policy({ retentionDays: 45.5 }),
      ),
    ).rejects.toBeInstanceOf(InvalidRetentionPolicyError);
  });

  it('rejects a scope that belongs to a different Organization (Req 1.4)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant({ organizationId: 'org-1' });
    await expect(
      manager.setRetentionPolicy(ctx, organizationRetentionScope('org-2'), policy()),
    ).rejects.toBeInstanceOf(InvalidRetentionPolicyError);
  });

  it('validateRetentionPolicy accepts a well-formed configuration', () => {
    expect(() =>
      validateRetentionPolicy({ resourceKind: 'file', retentionDays: 180, disposition: 'archive' }),
    ).not.toThrow();
    expect(() =>
      validateRetentionPolicy({ resourceKind: 'document', retentionDays: null }),
    ).not.toThrow();
  });

  it('records a compliance.retention_policy_set audit event on set (Req 37.2)', async () => {
    const { manager, audit } = makeManager();
    const ctx = makeTenant({ organizationId: 'org-7' });

    await manager.setRetentionPolicy(ctx, organizationRetentionScope('org-7'), policy());

    const events = audit.withAction('compliance.retention_policy_set');
    expect(events).toHaveLength(1);
    expect(events[0]?.ctx.organizationId).toBe('org-7');
    expect(events[0]?.event.metadata?.resourceKind).toBe('conversation');
  });
});

// ---------------------------------------------------------------------------
// resolveRetentionDays precedence (Req 38.1, 38.3)
// ---------------------------------------------------------------------------

describe('ComplianceManager.resolveRetentionDays precedence (Req 38.1, 38.3)', () => {
  it('falls back to the per-kind default when no policy is configured', async () => {
    const { manager } = makeManager();

    const conv = await manager.resolveRetentionDays(makeResource({ resourceKind: 'conversation' }));
    expect(conv.retentionDays).toBe(365);
    expect(conv.source).toBe('default');

    const file = await manager.resolveRetentionDays(makeResource({ resourceKind: 'file' }));
    expect(file.retentionDays).toBe(180);
  });

  it('prefers the Project policy over Team and Organization', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await manager.setRetentionPolicy(ctx, organizationRetentionScope('org-1'), policy({ retentionDays: 365 }));
    await manager.setRetentionPolicy(ctx, teamRetentionScope('org-1', 'team-1'), policy({ retentionDays: 90 }));
    await manager.setRetentionPolicy(ctx, projectRetentionScope('org-1', 'proj-1'), policy({ retentionDays: 30 }));

    const resolved = await manager.resolveRetentionDays(
      makeResource({ teamId: 'team-1', projectId: 'proj-1' }),
    );
    expect(resolved.retentionDays).toBe(30);
    expect(resolved.source).toBe('project');
  });

  it('falls back from Project to Team when no Project policy exists', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await manager.setRetentionPolicy(ctx, teamRetentionScope('org-1', 'team-1'), policy({ retentionDays: 90 }));

    const resolved = await manager.resolveRetentionDays(
      makeResource({ teamId: 'team-1', projectId: 'proj-1' }),
    );
    expect(resolved.retentionDays).toBe(90);
    expect(resolved.source).toBe('team');
  });
});

// ---------------------------------------------------------------------------
// legal hold exempts a resource from retention deletion
// ---------------------------------------------------------------------------

describe('ComplianceManager legal hold exemption', () => {
  it('places a hold that exempts a past-retention resource from deletion', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await manager.setRetentionPolicy(ctx, organizationRetentionScope('org-1'), policy({ retentionDays: 30 }));

    // A resource created 60 days ago is well past its 30-day retention.
    const resource = makeResource({ resourceId: 'conv-1', createdAt: isoDaysAgo(60) });

    // Before any hold it is due.
    expect((await manager.evaluateRetention(resource)).due).toBe(true);

    // Place a hold; the same resource is now exempt.
    const hold = await manager.placeLegalHold(ctx, {
      resourceKind: 'conversation',
      resourceId: 'conv-1',
      reason: 'litigation matter 42',
    });
    expect(hold.status).toBe('active');
    expect(await manager.isOnLegalHold('org-1', 'conversation', 'conv-1')).toBe(true);

    const decision = await manager.evaluateRetention(resource);
    expect(decision.due).toBe(false);
    expect(decision.heldByHoldId).toBe(hold.id);
  });

  it('records a compliance.legal_hold_placed audit event', async () => {
    const { manager, audit } = makeManager();
    const ctx = makeTenant();

    await manager.placeLegalHold(ctx, {
      resourceKind: 'file',
      resourceId: 'file-9',
      reason: 'investigation',
    });

    const events = audit.withAction('compliance.legal_hold_placed');
    expect(events).toHaveLength(1);
    expect(events[0]?.event.resourceId).toBe('file-9');
  });

  it('enforceRetention does NOT delete a held resource and reports it as exempt', async () => {
    const { manager, enforcer } = makeManager();
    const ctx = makeTenant();
    await manager.setRetentionPolicy(ctx, organizationRetentionScope('org-1'), policy({ retentionDays: 30 }));
    await manager.placeLegalHold(ctx, {
      resourceKind: 'conversation',
      resourceId: 'conv-held',
      reason: 'hold',
    });

    const held = makeResource({ resourceId: 'conv-held', createdAt: isoDaysAgo(90) });
    const result = await manager.enforceRetention(ctx, [held]);

    expect(result.applied).toHaveLength(0);
    expect(result.exemptByHold.map((d) => d.resource.resourceId)).toEqual(['conv-held']);
    expect(enforcer.has('conv-held')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// retention evaluation selects exactly due-and-unheld (Req 38.2, 38.3, Prop 53)
// ---------------------------------------------------------------------------

describe('ComplianceManager.enforceRetention selects exactly due-and-unheld (Property 53)', () => {
  it('removes nothing early and applies exactly the due, unheld resources', async () => {
    const { manager, enforcer, audit } = makeManager();
    const ctx = makeTenant();
    await manager.setRetentionPolicy(ctx, organizationRetentionScope('org-1'), policy({ retentionDays: 30 }));

    const young = makeResource({ resourceId: 'young', createdAt: isoDaysAgo(10) }); // within retention
    const dueA = makeResource({ resourceId: 'due-a', createdAt: isoDaysAgo(31) }); // past retention
    const dueB = makeResource({ resourceId: 'due-b', createdAt: isoDaysAgo(400) }); // way past
    const held = makeResource({ resourceId: 'held', createdAt: isoDaysAgo(90) }); // past but held

    await manager.placeLegalHold(ctx, {
      resourceKind: 'conversation',
      resourceId: 'held',
      reason: 'hold',
    });

    const result = await manager.enforceRetention(ctx, [young, dueA, dueB, held]);

    // Exactly the due-and-unheld resources are acted on.
    expect(result.applied.map((d) => d.resource.resourceId).sort()).toEqual(['due-a', 'due-b']);
    expect(enforcer.has('due-a')).toBe(true);
    expect(enforcer.has('due-b')).toBe(true);
    // Nothing within retention or held is removed.
    expect(enforcer.has('young')).toBe(false);
    expect(enforcer.has('held')).toBe(false);
    expect(result.exemptByHold.map((d) => d.resource.resourceId)).toEqual(['held']);
    // Each deletion is recorded in the Audit_Service (Req 38.2).
    expect(audit.withAction('compliance.retention_applied')).toHaveLength(2);
  });

  it('treats the deadline instant as due (inclusive boundary, not early)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await manager.setRetentionPolicy(ctx, organizationRetentionScope('org-1'), policy({ retentionDays: 30 }));

    // Created exactly 30 days before "now" → deadline is exactly now → due.
    const atDeadline = makeResource({ resourceId: 'edge', createdAt: isoDaysAgo(30) });
    expect((await manager.evaluateRetention(atDeadline)).due).toBe(true);

    // One millisecond short of the deadline → not yet due (removes nothing early).
    const justBefore = makeResource({
      resourceId: 'edge2',
      createdAt: new Date(NOW_MS - 30 * DAY_MS + 1).toISOString(),
    });
    expect((await manager.evaluateRetention(justBefore)).due).toBe(false);
  });

  it('never deletes a resource under an unlimited (null) retention policy', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await manager.setRetentionPolicy(
      ctx,
      organizationRetentionScope('org-1'),
      policy({ retentionDays: null }),
    );

    const ancient = makeResource({ resourceId: 'ancient', createdAt: isoDaysAgo(100000) });
    const decision = await manager.evaluateRetention(ancient);
    expect(decision.due).toBe(false);
    expect(decision.retentionUntil).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// releasing a hold re-subjects to retention
// ---------------------------------------------------------------------------

describe('ComplianceManager.releaseLegalHold re-subjects to retention', () => {
  it('a released resource becomes due again and is then deleted by enforcement', async () => {
    const { manager, enforcer, audit } = makeManager();
    const ctx = makeTenant();
    await manager.setRetentionPolicy(ctx, organizationRetentionScope('org-1'), policy({ retentionDays: 30 }));

    const hold = await manager.placeLegalHold(ctx, {
      resourceKind: 'conversation',
      resourceId: 'conv-1',
      reason: 'hold',
    });
    const resource = makeResource({ resourceId: 'conv-1', createdAt: isoDaysAgo(90) });

    // While held: exempt.
    expect((await manager.evaluateRetention(resource)).due).toBe(false);

    // Release the hold.
    const released = await manager.releaseLegalHold(ctx, hold.id);
    expect(released.status).toBe('released');
    expect(await manager.isOnLegalHold('org-1', 'conversation', 'conv-1')).toBe(false);

    // Now due again, and enforcement deletes it.
    expect((await manager.evaluateRetention(resource)).due).toBe(true);
    const result = await manager.enforceRetention(ctx, [resource]);
    expect(result.applied).toHaveLength(1);
    expect(enforcer.has('conv-1')).toBe(true);
    expect(audit.withAction('compliance.legal_hold_released')).toHaveLength(1);
  });

  it('fails closed when releasing a hold that does not exist', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();
    await expect(manager.releaseLegalHold(ctx, 'nope')).rejects.toBeInstanceOf(
      LegalHoldNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// tenant isolation (Req 1.4)
// ---------------------------------------------------------------------------

describe('ComplianceManager tenant isolation (Req 1.4)', () => {
  it('does not share a retention policy across Organizations with the same refId', async () => {
    const { manager } = makeManager();
    const ctx1 = makeTenant({ organizationId: 'org-1' });
    await manager.setRetentionPolicy(ctx1, organizationRetentionScope('org-1'), policy({ retentionDays: 30 }));

    // org-2 has no policy, so a same-id resource resolves to the per-kind default.
    const resolved = await manager.resolveRetentionDays(
      makeResource({ organizationId: 'org-2' }),
    );
    expect(resolved.source).toBe('default');
    expect(resolved.retentionDays).toBe(365);
  });

  it('a legal hold in one Organization does not exempt the same resource id in another', async () => {
    const { manager } = makeManager();
    const ctx1 = makeTenant({ organizationId: 'org-1' });
    await manager.placeLegalHold(ctx1, {
      resourceKind: 'conversation',
      resourceId: 'shared-id',
      reason: 'hold',
    });

    expect(await manager.isOnLegalHold('org-1', 'conversation', 'shared-id')).toBe(true);
    expect(await manager.isOnLegalHold('org-2', 'conversation', 'shared-id')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// subject erasure (Req 38.4, 38.5)
// ---------------------------------------------------------------------------

describe('ComplianceManager.eraseSubject (Req 38.4, 38.5)', () => {
  it('erases an offboarded subject within a 30-day deadline and records it', async () => {
    const { manager, eraser, audit } = makeManager();
    const ctx = makeTenant();

    const result = await manager.eraseSubject(ctx, {
      subjectId: 'user-42',
      reason: 'offboarding',
    });

    expect(eraser.has('user-42')).toBe(true);
    expect(result.outcome?.erasedRecordCount).toBe(3);
    // Deadline is 30 days after "now" (Req 38.4).
    expect(Date.parse(result.deadline) - NOW_MS).toBe(30 * DAY_MS);
    expect(audit.withAction('compliance.subject_erased')).toHaveLength(1);
  });

  it('erases a GDPR subject within a 72-hour deadline (Req 38.5)', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();

    const result = await manager.eraseSubject(ctx, {
      subjectId: 'user-99',
      reason: 'gdpr_request',
    });

    // Deadline is 72 hours after "now" (Req 38.5).
    expect(Date.parse(result.deadline) - NOW_MS).toBe(72 * 60 * 60 * 1000);
  });

  it('records the erasure even when no eraser seam is injected', async () => {
    const policies = new InMemoryRetentionPolicyStore();
    const holds = new InMemoryLegalHoldStore();
    const audit = new CapturingAuditRecorder();
    const clock = new MutableComplianceClock(NOW_MS);
    const manager = new ComplianceManager({ policies, holds, audit, clock });

    const result = await manager.eraseSubject(makeTenant(), {
      subjectId: 'user-7',
      reason: 'gdpr_request',
    });

    expect(result.outcome).toBeUndefined();
    expect(audit.withAction('compliance.subject_erased')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fail-closed verification (Req 38.6)
// ---------------------------------------------------------------------------

describe('ComplianceManager.verifyCompliance fail-closed (Req 38.6)', () => {
  it('allows an operation whose retention and privacy compliance are verified', async () => {
    const { manager, audit } = makeManager();
    const ctx = makeTenant();

    const decision = await manager.verifyCompliance(ctx, {
      kind: 'conversation.export',
      organizationId: 'org-1',
      retentionVerified: true,
      privacyVerified: true,
    });

    expect(decision.allowed).toBe(true);
    expect(audit.withAction('compliance.blocked')).toHaveLength(0);
  });

  it('blocks and audits an operation whose retention compliance is unverified', async () => {
    const { manager, audit } = makeManager();
    const ctx = makeTenant();

    const decision = await manager.verifyCompliance(ctx, {
      kind: 'conversation.export',
      organizationId: 'org-1',
      retentionVerified: false,
      privacyVerified: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('retention_unverifiable');
    expect(audit.withAction('compliance.blocked')).toHaveLength(1);
  });

  it('blocks with verification_unavailable when neither precondition is supplied', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();

    const decision = await manager.verifyCompliance(ctx, {
      kind: 'data.migrate',
      organizationId: 'org-1',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.denialCode).toBe('verification_unavailable');
  });

  it('verifyOrThrow throws ComplianceBlockedError on a block (after auditing)', async () => {
    const { manager, audit } = makeManager();
    const ctx = makeTenant();

    await expect(
      manager.verifyOrThrow(ctx, {
        kind: 'file.share',
        organizationId: 'org-1',
        retentionVerified: true,
        privacyVerified: false,
      }),
    ).rejects.toBeInstanceOf(ComplianceBlockedError);

    expect(audit.withAction('compliance.blocked')).toHaveLength(1);
  });

  it('verifyOrThrow returns the allow decision when fully verified', async () => {
    const { manager } = makeManager();
    const ctx = makeTenant();

    const decision = await manager.verifyOrThrow(ctx, {
      kind: 'file.share',
      organizationId: 'org-1',
      retentionVerified: true,
      privacyVerified: true,
    });
    expect(decision.allowed).toBe(true);
  });
});
