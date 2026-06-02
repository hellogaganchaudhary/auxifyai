/**
 * Property test for conversation list ordering.
 *
 * Feature: auxify-ai-platform, Property 17: Conversation list ordering.
 * Validates: Requirements 5.2.
 *
 * For ANY arbitrary set of conversations (arbitrary `updatedAt`/`createdAt`
 * timestamps, owners, and organizations) this drives the *real*
 * {@link ConversationManager} over the in-memory {@link InMemoryConversationStore}
 * and asserts that `list(ctx, ownerId)`:
 *
 *   1. returns the owner's conversations ordered MOST RECENT UPDATE FIRST —
 *      flattening every group yields a sequence non-increasing by `updatedAt`
 *      that matches the total order (`updatedAt` desc, then `createdAt` desc,
 *      then `id` asc);
 *   2. is GROUPED BY DATE — every conversation in a group shares the same UTC
 *      day, groups appear most-recent-day first, each day is exactly one
 *      contiguous group (no day split across groups), and within a group the
 *      order is most-recent-update first; and
 *   3. is a PERMUTATION of exactly the owner's conversations — none dropped
 *      (completeness), none extra (soundness), and no other owner's or other
 *      organization's conversations leak in.
 *
 * Correctness is checked against an INDEPENDENT oracle (re-implemented here, not
 * imported from the module under test): sort by `updatedAt` desc, tie-break
 * `createdAt` desc then `id` asc, and group contiguously by the `YYYY-MM-DD` UTC
 * day. A fixed injected `now` keeps date labels deterministic. Other-owner rows
 * (same organization) and other-organization rows (same owner id) are seeded so
 * their exclusion is exercised.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import type { ConversationRecord } from '../repositories/index.js';
import {
  CapturingAuditRecorder,
  InMemoryConversationStore,
  InMemoryMessageStore,
  makeConversationRecord,
  sequentialIdGenerator,
} from './fakes.js';
import { ConversationManager } from './conversation-manager.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 300;

/** Milliseconds in one UTC day. */
const MS_PER_DAY = 86_400_000;

/** The tenant whose listing is asserted. */
const ORG = 'org-target';
const OWNER = 'user-owner';
const OTHER_OWNER = 'user-other';
const OTHER_ORG = 'org-other';

const ctx: TenantContext = { organizationId: ORG, userId: OWNER };

/** A fixed clock so `Today`/`Yesterday` labels are deterministic. */
const NOW = new Date('2026-03-15T12:00:00.000Z');
/** Start of NOW's UTC day, the anchor for generated day offsets. */
const BASE_DAY_START = Date.parse('2026-03-15T00:00:00.000Z');

/**
 * An arbitrary UTC ISO timestamp built from a small day/slot grid so that
 * datasets exhibit both many distinct days (exercising grouping) and frequent
 * exact-timestamp collisions (exercising the createdAt/id tie-breaks).
 */
const tsArb: fc.Arbitrary<string> = fc
  .record({
    dayOffset: fc.integer({ min: 0, max: 6 }),
    slotHours: fc.integer({ min: 0, max: 5 }),
  })
  .map(({ dayOffset, slotHours }) =>
    new Date(BASE_DAY_START - dayOffset * MS_PER_DAY + slotHours * 3_600_000).toISOString(),
  );

/** The per-row generated payload (timestamps only; ids/owner/org are assigned per bucket). */
const rowSpecArb = fc.record({ updatedAt: tsArb, createdAt: tsArb });
type RowSpec = { updatedAt: string; createdAt: string };

/**
 * A full dataset: the target owner's rows plus noise rows that MUST be excluded
 * — other-owner rows in the same organization, and other-organization rows
 * carrying the same owner id (proving the org boundary is honored too).
 */
const scenarioArb = fc.record({
  targetRows: fc.array(rowSpecArb, { maxLength: 25 }),
  otherOwnerRows: fc.array(rowSpecArb, { maxLength: 8 }),
  otherOrgRows: fc.array(rowSpecArb, { maxLength: 8 }),
});

/** Build a record for a bucket with a unique, bucket-prefixed id. */
function recordOf(
  prefix: string,
  index: number,
  organizationId: string,
  ownerId: string,
  spec: RowSpec,
): ConversationRecord {
  return makeConversationRecord({
    id: `${prefix}-${index}`,
    organizationId,
    ownerId,
    updatedAt: spec.updatedAt,
    createdAt: spec.createdAt,
  });
}

/**
 * The independent total-order oracle: `updatedAt` desc, then `createdAt` desc,
 * then `id` asc. Re-implemented here (not imported) so the test does not assert
 * the module against itself.
 */
function oracleCompare(
  a: { updatedAt: string; createdAt: string; id: string },
  b: { updatedAt: string; createdAt: string; id: string },
): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** The independent UTC day key oracle for a (valid UTC) ISO timestamp. */
function oracleDayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** The independent date-label oracle relative to NOW (Today/Yesterday/date). */
function oracleLabel(key: string): string {
  const todayKey = NOW.toISOString().slice(0, 10);
  const diffDays = Math.round(
    (Date.parse(`${todayKey}T00:00:00.000Z`) - Date.parse(`${key}T00:00:00.000Z`)) / MS_PER_DAY,
  );
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return key;
}

/** Expected sorted records and contiguous day groups for the owner's rows. */
function expected(records: ConversationRecord[]): {
  sorted: ConversationRecord[];
  groups: { date: string; ids: string[] }[];
} {
  const sorted = [...records].sort(oracleCompare);
  const groups: { date: string; ids: string[] }[] = [];
  let current: { date: string; ids: string[] } | undefined;
  for (const record of sorted) {
    const key = oracleDayKey(record.updatedAt);
    if (current === undefined || current.date !== key) {
      current = { date: key, ids: [] };
      groups.push(current);
    }
    current.ids.push(record.id);
  }
  return { sorted, groups };
}

/** A manager wired to a fresh in-memory store with the fixed NOW clock. */
function makeManager(): { manager: ConversationManager; conversations: InMemoryConversationStore } {
  const now = (): Date => NOW;
  const conversations = new InMemoryConversationStore(now);
  const messages = new InMemoryMessageStore(() => undefined);
  const audit = new CapturingAuditRecorder();
  const manager = new ConversationManager({
    conversations,
    messages,
    audit,
    idGenerator: sequentialIdGenerator(),
    now,
  });
  return { manager, conversations };
}

describe('Feature: auxify-ai-platform, Property 17: Conversation list ordering', () => {
  it('lists the owner conversations most-recent-update first, grouped contiguously by UTC day, as an exact permutation excluding other owners/orgs (Validates: Requirements 5.2)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { manager, conversations } = makeManager();

        // The rows that SHOULD appear in the listing.
        const ownerRecords = scenario.targetRows.map((spec, i) =>
          recordOf('t', i, ORG, OWNER, spec),
        );
        // Noise that MUST be excluded: same org / different owner ...
        const otherOwnerRecords = scenario.otherOwnerRows.map((spec, i) =>
          recordOf('oo', i, ORG, OTHER_OWNER, spec),
        );
        // ... and same owner id / different org.
        const otherOrgRecords = scenario.otherOrgRows.map((spec, i) =>
          recordOf('og', i, OTHER_ORG, OWNER, spec),
        );

        for (const record of [...ownerRecords, ...otherOwnerRecords, ...otherOrgRecords]) {
          conversations.seed(record);
        }

        const { sorted, groups: expectedGroups } = expected(ownerRecords);

        const actualGroups = await manager.list(ctx, OWNER);
        const flat = actualGroups.flatMap((g) => g.conversations);
        const flatIds = flat.map((c) => c.id);

        // (1) + (3) Exact permutation in the total most-recent-first order:
        // this single equality proves completeness (none dropped), soundness
        // (none extra), exclusion of noise, AND the precise ordering.
        expect(flatIds).toEqual(sorted.map((r) => r.id));

        // Every listed conversation belongs to the owner and the organization.
        for (const c of flat) {
          expect(c.ownerId).toBe(OWNER);
          expect(c.organizationId).toBe(ORG);
        }

        // No excluded row id ever leaks in.
        const excludedIds = new Set([
          ...otherOwnerRecords.map((r) => r.id),
          ...otherOrgRecords.map((r) => r.id),
        ]);
        for (const id of flatIds) {
          expect(excludedIds.has(id)).toBe(false);
        }

        // (1) The flattened sequence is non-increasing by updatedAt.
        for (let i = 1; i < flat.length; i += 1) {
          expect(flat[i - 1]!.updatedAt >= flat[i]!.updatedAt).toBe(true);
        }

        // (2) Grouping: one contiguous group per UTC day, most-recent-day first.
        expect(actualGroups.map((g) => g.date)).toEqual(expectedGroups.map((g) => g.date));
        expect(actualGroups.map((g) => g.conversations.map((c) => c.id))).toEqual(
          expectedGroups.map((g) => g.ids),
        );

        const seenDays = new Set<string>();
        for (let i = 0; i < actualGroups.length; i += 1) {
          const group = actualGroups[i]!;

          // Each group's day key appears exactly once (no day split across groups).
          expect(seenDays.has(group.date)).toBe(false);
          seenDays.add(group.date);

          // Groups are strictly most-recent-day first.
          if (i > 0) {
            expect(actualGroups[i - 1]!.date > group.date).toBe(true);
          }

          // Every conversation in the group shares the group's UTC day, and the
          // label matches the independent Today/Yesterday/date oracle.
          expect(group.dateLabel).toBe(oracleLabel(group.date));
          for (const c of group.conversations) {
            expect(oracleDayKey(c.updatedAt)).toBe(group.date);
          }

          // Within the group, order is most-recent-update first (total order).
          for (let j = 1; j < group.conversations.length; j += 1) {
            expect(
              oracleCompare(group.conversations[j - 1]!, group.conversations[j]!),
            ).toBeLessThan(0);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
