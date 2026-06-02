/**
 * Property-based test for data-subject deletion completeness.
 *
 * Feature: auxify-ai-platform, Property 54: Subject deletion removes all
 * personal data.
 *
 * Design statement (Property 54): "For any offboarding or GDPR deletion request
 * for a subject, after processing there remain no records containing that
 * subject's personal data, and the deletion is recorded in the Audit_Service."
 *
 * Validates: Requirements 38.4, 38.5
 *
 * The {@link SubjectDataEraser} is the single injected seam the
 * Compliance_Manager drives across *every* store that may hold a subject's
 * personal data (conversations, files, messages, profiles, documents, …). We
 * therefore model "all records for the subject across all stores" behind a
 * populated implementation of that port: it is seeded with an arbitrary
 * cross-store population — some records belonging to the target subject, some to
 * OTHER subjects — and its `erase(ctx, subjectId)` removes exactly the target's
 * records within the caller's Organization. After running
 * {@link ComplianceManager.eraseSubject} we assert, over >= 100 generated
 * populations and reasons:
 *
 *   1. NO record containing the subject's personal data remains in any store the
 *      eraser handles (completeness, Req 38.4, 38.5);
 *   2. records belonging to OTHER subjects are untouched (completeness without
 *      over-deletion);
 *   3. the deletion is recorded in the Audit_Service via the capturing recorder
 *      fake, scoped to the Organization, naming the subject and reason (Req 38.5);
 *   4. the recorded {@link SubjectErasureResult} reports the regulatory deadline
 *      window matching the reason — 30 days for offboarding (Req 38.4), 72 hours
 *      for a GDPR request (Req 38.5).
 *
 * The capturing audit recorder and the in-memory policy/hold stores (required by
 * the manager's constructor even though erasure does not touch them) are imported
 * directly from `./fakes.js`, matching the established convention.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import {
  ComplianceManager,
  GDPR_ERASURE_WINDOW_MS,
  OFFBOARDING_ERASURE_WINDOW_MS,
  SUBJECT_ERASURE_REASONS,
  type SubjectDataEraser,
  type SubjectErasureOutcome,
  type SubjectErasureReason,
} from './index.js';
import {
  CapturingAuditRecorder,
  InMemoryLegalHoldStore,
  InMemoryRetentionPolicyStore,
  MutableComplianceClock,
  makeTenant,
} from './fakes.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 200;

/** A fixed start instant so the regulatory deadline arithmetic is unambiguous. */
const NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);

/**
 * The distinct stores the platform spreads a subject's personal data across.
 * The {@link PopulatedSubjectDataEraser} models "all stores" as exactly these
 * buckets; the property requires that after erasure none of them retains a
 * target-subject record.
 */
type PersonalDataStore = 'conversation' | 'file' | 'message' | 'profile' | 'document';

const PERSONAL_DATA_STORES: readonly PersonalDataStore[] = [
  'conversation',
  'file',
  'message',
  'profile',
  'document',
] as const;

/** A single personal-data record living in one of the stores. */
interface PersonalRecord {
  /** A unique id across the whole seeded population. */
  id: string;
  /** The Organization that owns the record (the tenant boundary). */
  organizationId: string;
  /** The data subject the record belongs to. */
  subjectId: string;
  /** Which store the record lives in. */
  store: PersonalDataStore;
}

/**
 * A populated {@link SubjectDataEraser} that models the platform's full set of
 * personal-data stores. Seeded with an arbitrary cross-subject population, its
 * {@link erase} removes exactly the target subject's records (within the caller's
 * Organization) across every store and reports what was deleted — so the test can
 * query the surviving population to verify completeness without over-deletion.
 */
class PopulatedSubjectDataEraser implements SubjectDataEraser {
  /** store -> the records currently held in it. */
  private readonly stores = new Map<PersonalDataStore, PersonalRecord[]>();
  /** Every subject erased, in order, with the context it was scoped to. */
  readonly erasedSubjects: { ctx: TenantContext; subjectId: string }[] = [];

  constructor(population: readonly PersonalRecord[]) {
    for (const store of PERSONAL_DATA_STORES) {
      this.stores.set(store, []);
    }
    for (const record of population) {
      this.stores.get(record.store)?.push({ ...record });
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async erase(ctx: TenantContext, subjectId: string): Promise<SubjectErasureOutcome> {
    this.erasedSubjects.push({ ctx: { ...ctx }, subjectId });

    const erasedStores = new Set<string>();
    let erasedRecordCount = 0;

    for (const store of PERSONAL_DATA_STORES) {
      const held = this.stores.get(store) ?? [];
      const survivors: PersonalRecord[] = [];
      for (const record of held) {
        const isTarget =
          record.organizationId === ctx.organizationId && record.subjectId === subjectId;
        if (isTarget) {
          erasedRecordCount += 1;
          erasedStores.add(store);
        } else {
          survivors.push(record);
        }
      }
      this.stores.set(store, survivors);
    }

    return { erasedRecordCount, erasedResourceKinds: [...erasedStores] };
  }

  /** Every record still held, across all stores. */
  remaining(): PersonalRecord[] {
    return PERSONAL_DATA_STORES.flatMap((store) => this.stores.get(store) ?? []);
  }

  /** Records still held for a given subject within an Organization (across all stores). */
  remainingForSubject(organizationId: string, subjectId: string): PersonalRecord[] {
    return this.remaining().filter(
      (r) => r.organizationId === organizationId && r.subjectId === subjectId,
    );
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * The target subject id — namespaced so it can never collide with a generated
 * "other" subject id (which lives in the disjoint `other:` namespace).
 */
const targetSubjectArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 16 })
  .map((token) => `target:${token}`);

/**
 * A record specification: which store it lives in, whether it belongs to the
 * target subject, and — when it does not — which OTHER subject owns it (always in
 * the disjoint `other:` namespace, so it can never equal the target).
 */
interface RecordSpec {
  store: PersonalDataStore;
  ownedByTarget: boolean;
  otherToken: string;
}

const recordSpecArb: fc.Arbitrary<RecordSpec> = fc.record({
  store: fc.constantFrom(...PERSONAL_DATA_STORES),
  ownedByTarget: fc.boolean(),
  otherToken: fc.string({ minLength: 1, maxLength: 8 }),
});

/** A whole population scenario: target subject, erasure reason, and the records. */
interface Scenario {
  subjectId: string;
  reason: SubjectErasureReason;
  population: PersonalRecord[];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    subjectId: targetSubjectArb,
    reason: fc.constantFrom<SubjectErasureReason>(...SUBJECT_ERASURE_REASONS),
    specs: fc.array(recordSpecArb, { minLength: 0, maxLength: 40 }),
    organizationId: fc.constant('org-1'),
  })
  .map(({ subjectId, reason, specs, organizationId }) => {
    const population: PersonalRecord[] = specs.map((spec, index) => ({
      id: `rec-${index}`,
      organizationId,
      subjectId: spec.ownedByTarget ? subjectId : `other:${spec.otherToken}`,
      store: spec.store,
    }));
    return { subjectId, reason, population };
  });

/** The regulatory deadline window (ms) the reason should produce. */
function expectedWindowMs(reason: SubjectErasureReason): number {
  return reason === 'gdpr_request' ? GDPR_ERASURE_WINDOW_MS : OFFBOARDING_ERASURE_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 54: Subject deletion removes all personal data', () => {
  it('erases every record of the subject across all stores, leaves other subjects untouched, and records the deletion within the regulatory deadline (Validates: Requirements 38.4, 38.5)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const ctx = makeTenant({ organizationId: 'org-1' });

        // The records that must survive (everything NOT owned by the target).
        const expectedSurvivors = scenario.population.filter(
          (r) => !(r.organizationId === ctx.organizationId && r.subjectId === scenario.subjectId),
        );
        const targetRecords = scenario.population.filter(
          (r) => r.organizationId === ctx.organizationId && r.subjectId === scenario.subjectId,
        );
        const targetStores = new Set(targetRecords.map((r) => r.store));

        const eraser = new PopulatedSubjectDataEraser(scenario.population);
        const audit = new CapturingAuditRecorder();
        const clock = new MutableComplianceClock(NOW_MS);
        const manager = new ComplianceManager({
          policies: new InMemoryRetentionPolicyStore(),
          holds: new InMemoryLegalHoldStore(),
          audit,
          eraser,
          clock,
        });

        const result = await manager.eraseSubject(ctx, {
          subjectId: scenario.subjectId,
          reason: scenario.reason,
        });

        // (0) The eraser ran exactly once for this subject, in this Organization.
        expect(eraser.erasedSubjects).toHaveLength(1);
        expect(eraser.erasedSubjects[0]?.subjectId).toBe(scenario.subjectId);
        expect(eraser.erasedSubjects[0]?.ctx.organizationId).toBe(ctx.organizationId);

        // (1) No record containing the subject's personal data remains anywhere.
        expect(eraser.remainingForSubject(ctx.organizationId, scenario.subjectId)).toEqual([]);

        // (2) Records belonging to OTHER subjects are untouched (no over-deletion).
        const survivorIds = eraser
          .remaining()
          .map((r) => r.id)
          .sort();
        const expectedSurvivorIds = expectedSurvivors.map((r) => r.id).sort();
        expect(survivorIds).toEqual(expectedSurvivorIds);

        // (3) The deletion is recorded in the Audit_Service with subject + reason.
        const erasedEvents = audit.withAction('compliance.subject_erased');
        expect(erasedEvents).toHaveLength(1);
        const erased = erasedEvents[0];
        expect(erased?.ctx.organizationId).toBe(ctx.organizationId);
        expect(erased?.event.resourceType).toBe('user');
        expect(erased?.event.resourceId).toBe(scenario.subjectId);
        expect(erased?.event.metadata?.reason).toBe(scenario.reason);
        expect(erased?.event.metadata?.deadline).toBe(result.deadline);
        expect(erased?.event.metadata?.erasedRecordCount).toBe(targetRecords.length);

        // (4) The outcome reports exactly what was deleted, across exactly the
        //     stores that held the subject's data.
        expect(result.subjectId).toBe(scenario.subjectId);
        expect(result.reason).toBe(scenario.reason);
        expect(result.outcome?.erasedRecordCount).toBe(targetRecords.length);
        expect([...(result.outcome?.erasedResourceKinds ?? [])].sort()).toEqual(
          [...targetStores].sort(),
        );

        // (4b) The recorded result carries the regulatory deadline window matching
        //      the reason (offboarding 30d / GDPR 72h).
        expect(Date.parse(result.deadline) - Date.parse(result.erasedAt)).toBe(
          expectedWindowMs(scenario.reason),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
