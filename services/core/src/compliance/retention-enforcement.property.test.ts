/**
 * Property-based test for Compliance_Manager retention enforcement boundaries.
 *
 * Feature: auxify-ai-platform, Property 53: Retention enforcement removes nothing
 * early and nothing past-retention remains.
 * Validates: Requirements 28.6, 38.2, 38.3.
 *
 * Property 53: "For any set of conversations, files, or documents with assorted
 * ages, the configured retention action (hard delete for conversations and
 * files, delete or archive for documents) is applied if and only if the item is
 * past its retention period, the action is recorded in the Audit_Service, and no
 * item past its retention period remains active afterward."
 *
 * Retention is measured from a resource's creation instant against a configured
 * per-kind retention period: a resource is past retention exactly when
 * `now >= createdAt + retentionDays` (inclusive at the deadline, never earlier).
 * An active legal hold exempts a held resource from deletion regardless of age.
 *
 * This drives the REAL {@link ComplianceManager} over the in-memory fakes
 * (imported directly from `./fakes.js`, never the barrel) with a hand-fixed
 * {@link MutableComplianceClock} as the only source of "now", and checks the
 * enforcement sweep against an INDEPENDENT oracle — the pure retention core
 * {@link isPastRetention} / {@link retentionDueAtMs} — for ANY set of
 * conversations/files/documents with assorted ages straddling the boundary, some
 * under an active legal hold:
 *
 *   1. APPLIED IFF PAST-AND-UNHELD — the configured disposition is delegated to
 *      the {@link RecordingRetentionEnforcer} for a resource exactly when it is
 *      past its retention period AND not under an active legal hold. A resource
 *      still within retention is never touched (nothing removed early); a
 *      past-retention held resource is exempt and reported in `exemptByHold`.
 *   2. NOTHING PAST-RETENTION REMAINS — after the sweep, every past-retention,
 *      unheld resource received its delete/archive disposition (so none remains
 *      active), and the applied set equals the oracle's past-and-unheld set
 *      exactly.
 *   3. EVERY APPLIED ACTION IS AUDITED — each applied resource has exactly one
 *      `compliance.retention_applied` event in the capturing Audit_Service.
 *   4. DISPOSITION MATCHES THE KIND — conversations and files are hard-deleted
 *      (`delete`); a document carries its configured disposition (`delete` or
 *      `archive`).
 *
 * The inclusive-at-the-deadline boundary and the legal-hold exemption are also
 * pinned by explicit example cases.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ComplianceManager,
  MS_PER_DAY,
  RETENTION_RESOURCE_KINDS,
  isPastRetention,
  organizationRetentionScope,
  retentionDueAtMs,
  type RetentionDisposition,
  type RetentionResourceKind,
} from '../compliance/index.js';
import {
  CapturingAuditRecorder,
  InMemoryLegalHoldStore,
  InMemoryRetentionPolicyStore,
  MutableComplianceClock,
  RecordingRetentionEnforcer,
  makeResource,
  makeTenant,
  sequentialComplianceIdGenerator,
} from './fakes.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

/** The Organization every generated resource and policy belongs to. */
const ORG = 'org-1';

/** A fixed evaluation instant ("now"), so retention windows are unambiguous. */
const NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);

interface Harness {
  manager: ComplianceManager;
  audit: CapturingAuditRecorder;
  enforcer: RecordingRetentionEnforcer;
}

/** Construct a ComplianceManager wired with deterministic in-memory fakes at NOW_MS. */
function makeHarness(): Harness {
  const policies = new InMemoryRetentionPolicyStore();
  const holds = new InMemoryLegalHoldStore();
  const audit = new CapturingAuditRecorder();
  const enforcer = new RecordingRetentionEnforcer();
  const clock = new MutableComplianceClock(NOW_MS);
  const manager = new ComplianceManager({
    policies,
    holds,
    audit,
    enforcer,
    clock,
    idGenerator: sequentialComplianceIdGenerator(),
  });
  return { manager, audit, enforcer };
}

// ---------------------------------------------------------------------------
// Scenario generators
// ---------------------------------------------------------------------------

/**
 * A single generated resource: its kind, where its creation instant sits
 * relative to its kind's retention boundary (`deltaMs` against the boundary
 * createdAt, `<= 0` is past/at-deadline, `> 0` is still within retention), and
 * whether it is placed under an active legal hold.
 *
 * `deltaMs` is biased to hit the inclusive boundary frequently: exactly at the
 * deadline (`0`), one millisecond past it (`-1`), one millisecond short of it
 * (`1`), and uniformly across both sides.
 */
const resourceArb = fc.record({
  kind: fc.constantFrom<RetentionResourceKind>(...RETENTION_RESOURCE_KINDS),
  deltaMs: fc.oneof(
    fc.constant(0), // created exactly at the boundary -> past (inclusive)
    fc.constant(-1), // one ms older than the boundary -> past
    fc.constant(1), // one ms younger than the boundary -> within retention
    fc.integer({ min: -400 * MS_PER_DAY, max: -1 }), // well past retention
    fc.integer({ min: 1, max: 400 * MS_PER_DAY }), // comfortably within retention
  ),
  held: fc.boolean(),
});

/**
 * A full enforcement scenario: a per-kind retention period (each `>= 30` days,
 * the configurable minimum), the document disposition (`delete` or `archive`),
 * and a set of resources with assorted ages.
 */
const scenarioArb = fc.record({
  retentionDays: fc.record({
    conversation: fc.integer({ min: 30, max: 400 }),
    file: fc.integer({ min: 30, max: 400 }),
    document: fc.integer({ min: 30, max: 400 }),
  }),
  documentDisposition: fc.constantFrom<RetentionDisposition>('delete', 'archive'),
  resources: fc.array(resourceArb, { minLength: 1, maxLength: 12 }),
});

/** A built case: the resource plus its independently-computed oracle verdict. */
interface BuiltCase {
  id: string;
  kind: RetentionResourceKind;
  held: boolean;
  retentionDays: number;
  createdAtMs: number;
  past: boolean;
}

// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 53: Retention enforcement removes nothing early and nothing past-retention remains', () => {
  it('applies the configured disposition iff past-retention and unheld, audits each, and leaves nothing past-retention active (Validates: Requirements 28.6, 38.2, 38.3)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { manager, audit, enforcer } = makeHarness();
        const ctx = makeTenant({ organizationId: ORG });

        const retentionByKind: Record<RetentionResourceKind, number> = scenario.retentionDays;
        // Conversations and files are hard-deleted; a document is delete OR archive.
        const dispositionByKind: Record<RetentionResourceKind, RetentionDisposition> = {
          conversation: 'delete',
          file: 'delete',
          document: scenario.documentDisposition,
        };

        // Configure an Organization-level retention policy for every kind.
        for (const kind of RETENTION_RESOURCE_KINDS) {
          await manager.setRetentionPolicy(ctx, organizationRetentionScope(ORG), {
            resourceKind: kind,
            retentionDays: retentionByKind[kind],
            disposition: dispositionByKind[kind],
          });
        }

        // Build each resource with a creation instant pinned relative to its
        // kind's retention boundary, and compute the oracle verdict independently.
        const cases: BuiltCase[] = scenario.resources.map((r, i) => {
          const retentionDays = retentionByKind[r.kind];
          // The latest createdAt that is still past retention at NOW: created
          // exactly `retentionDays` before now makes the deadline == now (due).
          const boundaryCreatedAtMs = NOW_MS - retentionDays * MS_PER_DAY;
          const createdAtMs = boundaryCreatedAtMs + r.deltaMs;
          const past = isPastRetention(createdAtMs, NOW_MS, retentionDays);

          // Cross-check the oracle against the deadline arithmetic directly.
          const deadline = retentionDueAtMs(createdAtMs, retentionDays);
          expect(deadline).toBe(createdAtMs + retentionDays * MS_PER_DAY);
          expect(past).toBe(NOW_MS >= (deadline ?? Number.POSITIVE_INFINITY));
          // `deltaMs <= 0` straddles the inclusive deadline boundary.
          expect(past).toBe(r.deltaMs <= 0);

          return {
            id: `res-${i}`,
            kind: r.kind,
            held: r.held,
            retentionDays,
            createdAtMs,
            past,
          };
        });

        // Place an active legal hold on every "held" resource before the sweep.
        for (const c of cases) {
          if (c.held) {
            await manager.placeLegalHold(ctx, {
              resourceKind: c.kind,
              resourceId: c.id,
              reason: `hold-${c.id}`,
            });
          }
        }

        const resources = cases.map((c) =>
          makeResource({
            organizationId: ORG,
            resourceKind: c.kind,
            resourceId: c.id,
            createdAt: new Date(c.createdAtMs).toISOString(),
          }),
        );

        const result = await manager.enforceRetention(ctx, resources);

        // Independent oracle partitions.
        const expectedApplied = cases.filter((c) => c.past && !c.held).map((c) => c.id);
        const expectedExempt = cases.filter((c) => c.past && c.held).map((c) => c.id);

        // (1)+(2) The disposition is applied to a resource IFF it is past its
        // retention period AND not held — nothing removed early, and after the
        // sweep no past-retention unheld resource remains untouched.
        for (const c of cases) {
          expect(enforcer.has(c.id)).toBe(c.past && !c.held);
        }
        expect(new Set(result.applied.map((d) => d.resource.resourceId))).toEqual(
          new Set(expectedApplied),
        );
        expect(result.applied).toHaveLength(expectedApplied.length);

        // A past-retention held resource is exempt (not deleted), reported as such.
        expect(new Set(result.exemptByHold.map((d) => d.resource.resourceId))).toEqual(
          new Set(expectedExempt),
        );
        for (const id of expectedExempt) {
          expect(enforcer.has(id)).toBe(false);
        }

        // (3) Every applied action is recorded in the Audit_Service exactly once.
        const appliedAudits = audit.withAction('compliance.retention_applied');
        expect(appliedAudits).toHaveLength(expectedApplied.length);
        expect(new Set(appliedAudits.map((a) => a.event.resourceId))).toEqual(
          new Set(expectedApplied),
        );

        // (4) The disposition matches the kind: hard delete for conversations and
        // files; the configured delete/archive for documents.
        for (const applied of enforcer.applied) {
          expect(applied.disposition).toBe(dispositionByKind[applied.resourceKind]);
          if (applied.resourceKind === 'conversation' || applied.resourceKind === 'file') {
            expect(applied.disposition).toBe('delete');
          } else {
            expect(['delete', 'archive']).toContain(applied.disposition);
          }
        }
        for (const decision of result.applied) {
          expect(decision.due).toBe(true);
          expect(decision.disposition).toBe(dispositionByKind[decision.resource.resourceKind]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('removes a resource exactly at its retention deadline but nothing one millisecond earlier (inclusive boundary)', async () => {
    const { manager, enforcer } = makeHarness();
    const ctx = makeTenant({ organizationId: ORG });
    const retentionDays = 30;
    await manager.setRetentionPolicy(ctx, organizationRetentionScope(ORG), {
      resourceKind: 'conversation',
      retentionDays,
      disposition: 'delete',
    });

    // Created exactly `retentionDays` before now -> deadline === now -> due.
    const atDeadline = makeResource({
      resourceId: 'edge-at',
      createdAt: new Date(NOW_MS - retentionDays * MS_PER_DAY).toISOString(),
    });
    // One millisecond short of the deadline -> not yet due (removes nothing early).
    const justBefore = makeResource({
      resourceId: 'edge-before',
      createdAt: new Date(NOW_MS - retentionDays * MS_PER_DAY + 1).toISOString(),
    });

    const result = await manager.enforceRetention(ctx, [atDeadline, justBefore]);

    expect(result.applied.map((d) => d.resource.resourceId)).toEqual(['edge-at']);
    expect(enforcer.has('edge-at')).toBe(true);
    expect(enforcer.has('edge-before')).toBe(false);
  });

  it('never deletes a past-retention resource under an active legal hold (Validates: Requirements 38.2, 38.3)', async () => {
    const { manager, audit, enforcer } = makeHarness();
    const ctx = makeTenant({ organizationId: ORG });
    await manager.setRetentionPolicy(ctx, organizationRetentionScope(ORG), {
      resourceKind: 'file',
      retentionDays: 180,
      disposition: 'delete',
    });

    // Created 400 days ago -> well past its 180-day retention, but held.
    const held = makeResource({
      resourceKind: 'file',
      resourceId: 'file-held',
      createdAt: new Date(NOW_MS - 400 * MS_PER_DAY).toISOString(),
    });
    await manager.placeLegalHold(ctx, {
      resourceKind: 'file',
      resourceId: 'file-held',
      reason: 'litigation',
    });

    const result = await manager.enforceRetention(ctx, [held]);

    expect(result.applied).toHaveLength(0);
    expect(result.exemptByHold.map((d) => d.resource.resourceId)).toEqual(['file-held']);
    expect(enforcer.has('file-held')).toBe(false);
    expect(audit.withAction('compliance.retention_applied')).toHaveLength(0);
  });
});
