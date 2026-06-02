/**
 * Property-based test for **Property 59: Backup and restore round-trip to a
 * retained recovery point** (design "Property 59"; Req 39.3, 39.4).
 *
 * **Validates: Requirements 39.3, 39.4**
 *
 * Property 59 (design): _For any_ captured platform state, performing a backup,
 * applying arbitrary subsequent mutations, and then restoring to the backup's
 * recovery point yields a state equal to the captured state for all data covered
 * by the backup.
 *
 * This file drives the REAL {@link BackupService} from `../backup/index.js`
 * (built in tasks 21.1-21.5) over the in-memory fakes imported directly from
 * `./fakes.js` (never the package barrel), with a hand-advanced
 * {@link MutableBackupClock} as the only source of time so retention is timed
 * deterministically.
 *
 * The "captured platform state" is modelled as a record set — a `Record<string,
 * string>` keyed by id — that the {@link InMemoryBackupSource} serializes into
 * its single mutable byte buffer (canonical, key-sorted JSON, so byte-level
 * equality of two equal record sets is well-defined). Each run:
 *   1. seeds the live store with an arbitrary captured record set and captures a
 *      backup (a recovery point);
 *   2. applies an arbitrary sequence of inserts / updates / deletes to the live
 *      store so it diverges from the captured state;
 *   3. restores the target to the backup's recovery point (by id or by recovery
 *      point cutoff); and
 *   4. asserts the post-restore live state deep-equals the captured record set.
 *
 * Companion assertions cover the rest of Property 59's surface: integrity is
 * re-verified on restore (a corrupted snapshot fails closed with
 * {@link BackupIntegrityError} and never touches the live store), `listBackups`
 * returns retained recovery points most-recent-first, and a restore to a point
 * still inside the retention window succeeds while `purgeExpired` leaves it.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import {
  BackupIntegrityError,
  BackupService,
  DEFAULT_BACKUP_RETENTION_MS,
  type BackupRecord,
  type BackupSourceRegistry,
} from '../backup/index.js';
import {
  CapturingAuditRecorder,
  InMemoryBackupRecordStore,
  InMemoryBackupSource,
  InMemoryObjectStore,
  MutableBackupClock,
  makeTenantContext,
  sequentialBackupIdGenerator,
} from './fakes.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1, 0, 0, 0);

// ---------------------------------------------------------------------------
// The "captured platform state" model: a record set (id -> value)
// ---------------------------------------------------------------------------

/** The data covered by a backup, modelled as a record set keyed by id. */
type RecordSet = Record<string, string>;

/** An arbitrary subsequent mutation applied to the live store after a backup. */
type Mutation =
  | { readonly kind: 'insert'; readonly key: string; readonly value: string }
  | { readonly kind: 'update'; readonly key: string; readonly value: string }
  | { readonly kind: 'delete'; readonly key: string };

/**
 * Serialize a record set into canonical, key-sorted JSON bytes — the opaque
 * snapshot the {@link InMemoryBackupSource} stores. Key-sorting makes two equal
 * record sets serialize to identical bytes, so the round-trip is exact.
 */
function serialize(state: RecordSet): Uint8Array {
  const entries = Object.keys(state)
    .sort()
    .map((key) => [key, state[key]] as const);
  return new TextEncoder().encode(JSON.stringify(entries));
}

/** Recover a record set from its serialized bytes. */
function deserialize(bytes: Uint8Array): RecordSet {
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) {
    return {};
  }
  const entries = JSON.parse(text) as [string, string][];
  const out: RecordSet = {};
  for (const [key, value] of entries) {
    out[key] = value;
  }
  return out;
}

/** Apply a sequence of mutations to a copy of `state` (the live divergence). */
function applyMutations(state: RecordSet, mutations: readonly Mutation[]): RecordSet {
  const next: RecordSet = { ...state };
  for (const mutation of mutations) {
    if (mutation.kind === 'delete') {
      delete next[mutation.key];
    } else {
      next[mutation.key] = mutation.value;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Short keys over a small space so updates/deletes frequently hit live keys. */
const keyArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 3 });
const valueArb: fc.Arbitrary<string> = fc.string({ maxLength: 8 });

/** An arbitrary captured record set (the platform state covered by a backup). */
const recordSetArb: fc.Arbitrary<RecordSet> = fc.dictionary(keyArb, valueArb, { maxKeys: 8 });

/**
 * An arbitrary mutation. Updates and deletes are biased toward keys that already
 * exist in `existingKeys` (when any) so the live store genuinely diverges;
 * inserts add fresh keys.
 */
function mutationArb(existingKeys: readonly string[]): fc.Arbitrary<Mutation> {
  const insertArb = fc.record({
    kind: fc.constant<'insert'>('insert'),
    key: keyArb,
    value: valueArb,
  });
  if (existingKeys.length === 0) {
    return insertArb;
  }
  const existingKeyArb = fc.constantFrom(...existingKeys);
  return fc.oneof(
    insertArb,
    fc.record({ kind: fc.constant<'update'>('update'), key: existingKeyArb, value: valueArb }),
    fc.record({ kind: fc.constant<'delete'>('delete'), key: existingKeyArb }),
  );
}

/** A complete round-trip scenario: captured state, mutations, and how to restore. */
interface Scenario {
  readonly captured: RecordSet;
  readonly mutations: Mutation[];
  readonly restoreBy: 'id' | 'recoveryPoint';
}

const scenarioArb: fc.Arbitrary<Scenario> = recordSetArb.chain((captured) =>
  fc.record({
    captured: fc.constant(captured),
    mutations: fc.array(mutationArb(Object.keys(captured)), { maxLength: 12 }),
    restoreBy: fc.constantFrom<'id' | 'recoveryPoint'>('id', 'recoveryPoint'),
  }),
);

// ---------------------------------------------------------------------------
// Harness — the real service over the in-memory fakes
// ---------------------------------------------------------------------------

interface Harness {
  readonly service: BackupService;
  readonly db: InMemoryBackupSource;
  readonly objects: InMemoryObjectStore;
  readonly clock: MutableBackupClock;
  readonly ctx: TenantContext;
}

/** Wire the real {@link BackupService} over fresh in-memory fakes (database target). */
function makeHarness(options: { retentionMs?: number } = {}): Harness {
  const db = new InMemoryBackupSource();
  const objects = new InMemoryObjectStore();
  const sources: BackupSourceRegistry = { database: db };
  const clock = new MutableBackupClock(START);
  const service = new BackupService({
    sources,
    objectStore: objects,
    records: new InMemoryBackupRecordStore(),
    audit: new CapturingAuditRecorder(),
    clock,
    retentionMs: options.retentionMs ?? DEFAULT_BACKUP_RETENTION_MS,
    idGenerator: sequentialBackupIdGenerator(),
  });
  const ctx = makeTenantContext({ organizationId: 'org-1', userId: 'user-1' });
  return { service, db, objects, clock, ctx };
}

/** Order backups most-recent recovery point first (an independent oracle). */
function mostRecentFirst(records: readonly BackupRecord[]): BackupRecord[] {
  return [...records].sort((a, b) => {
    if (a.recoveryPoint !== b.recoveryPoint) {
      return a.recoveryPoint < b.recoveryPoint ? 1 : -1;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Property 59
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 59: Backup and restore round-trip to a retained recovery point', () => {
  it('restoring to a backup recovery point yields the captured state after arbitrary mutations (Validates: Requirements 39.3, 39.4)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ captured, mutations, restoreBy }) => {
        const h = makeHarness();

        // 1. Seed the live store with the captured platform state and back it up.
        h.db.setState(h.ctx, serialize(captured));
        const report = await h.service.backup(h.ctx, 'database');
        expect(report.verified).toBe(true);
        const recoveryPoint = report.record.recoveryPoint;

        // 2. Apply arbitrary subsequent mutations so the live store diverges.
        const live = applyMutations(captured, mutations);
        h.db.setState(h.ctx, serialize(live));

        // 3. Restore the target to the backup's recovery point (integrity is
        //    re-verified on restore; a non-throwing restore proves it verified).
        const restored =
          restoreBy === 'id'
            ? await h.service.restore(h.ctx, {
                target: 'database',
                backupId: report.record.id,
              })
            : await h.service.restore(h.ctx, {
                target: 'database',
                recoveryPoint,
              });
        expect(restored.id).toBe(report.record.id);
        expect(restored.recoveryPoint).toBe(recoveryPoint);

        // 4. The post-restore live state equals the captured state for all data
        //    covered by the backup.
        expect(deserialize(h.db.getState(h.ctx))).toEqual(captured);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('re-verifies integrity on restore and fails closed without touching the live store when a snapshot is corrupted (Validates: Requirements 39.3, 39.4)', async () => {
    await fc.assert(
      fc.asyncProperty(recordSetArb, recordSetArb, async (captured, liveBefore) => {
        const h = makeHarness();
        h.db.setState(h.ctx, serialize(captured));
        const report = await h.service.backup(h.ctx, 'database');

        // Corrupt the persisted snapshot bytes out from under the catalog entry:
        // append a byte so both the length and the checksum are guaranteed to differ.
        const original = serialize(captured);
        const corrupted = new Uint8Array(original.length + 1);
        corrupted.set(original);
        corrupted[original.length] = 0xff;
        await h.objects.put(report.record.objectKey, corrupted);

        // The live store holds an arbitrary divergent state at restore time.
        h.db.setState(h.ctx, serialize(liveBefore));

        await expect(
          h.service.restore(h.ctx, { target: 'database', backupId: report.record.id }),
        ).rejects.toBeInstanceOf(BackupIntegrityError);

        // Fail-closed: the live store was never overwritten by the bad snapshot.
        expect(deserialize(h.db.getState(h.ctx))).toEqual(liveBefore);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('listBackups returns retained recovery points most-recent first (Validates: Requirements 39.4)', async () => {
    const deltaDaysArb = fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 2, maxLength: 6 });

    await fc.assert(
      fc.asyncProperty(deltaDaysArb, recordSetArb, async (deltaDays, state) => {
        const h = makeHarness();
        h.db.setState(h.ctx, serialize(state));

        // Capture a backup at each strictly-increasing instant (distinct recovery points).
        const captured: BackupRecord[] = [];
        let cursor = START;
        for (const days of deltaDays) {
          cursor += days * DAY_MS;
          h.clock.set(cursor);
          const report = await h.service.backup(h.ctx, 'database');
          captured.push(report.record);
        }

        const listed = await h.service.listBackups(h.ctx, 'database');
        const expected = mostRecentFirst(captured).map((r) => r.id);
        expect(listed.map((r) => r.id)).toEqual(expected);
      }),
      { numRuns: 150 },
    );
  });

  it('restoring to a point still within the retention window succeeds and is not purged (Validates: Requirements 39.4)', async () => {
    const retentionMs = DEFAULT_BACKUP_RETENTION_MS;
    const withinRetentionArb = fc.integer({ min: 0, max: retentionMs });

    await fc.assert(
      fc.asyncProperty(scenarioArb, withinRetentionArb, async ({ captured, mutations }, elapsedMs) => {
        const h = makeHarness({ retentionMs });
        h.db.setState(h.ctx, serialize(captured));
        const report = await h.service.backup(h.ctx, 'database');

        // Diverge the live store, then move "now" forward but stay inside the window.
        h.db.setState(h.ctx, serialize(applyMutations(captured, mutations)));
        h.clock.set(START + elapsedMs);

        // The retained recovery point is still purge-safe and still restorable.
        expect(await h.service.purgeExpired(h.ctx, 'database')).toEqual([]);
        const stillListed = await h.service.listBackups(h.ctx, 'database');
        expect(stillListed.map((r) => r.id)).toEqual([report.record.id]);

        await h.service.restore(h.ctx, { target: 'database', recoveryPoint: report.record.recoveryPoint });
        expect(deserialize(h.db.getState(h.ctx))).toEqual(captured);
      }),
      { numRuns: 150 },
    );
  });
});
