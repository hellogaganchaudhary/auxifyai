/**
 * Unit tests for the Backup_Service (Req 39.1-39.4).
 *
 * These drive the REAL {@link BackupService} over the in-memory fakes (imported
 * directly from `./fakes.js`, never the barrel) with a hand-advanced
 * {@link MutableBackupClock} as the only source of time, covering:
 *
 *   - capture → restore round-trips a store's state to its recovery point
 *     (Req 39.1, 39.3, the basis of the companion Property 59, task 21.6);
 *   - capture verifies integrity and records the outcome (Req 39.2);
 *   - `listBackups` returns retained backups most-recent recovery point first
 *     (Req 39.4);
 *   - restoring a missing recovery point / unknown id fails closed (Req 39.3);
 *   - `purgeExpired` removes exactly the backups whose retention window has
 *     elapsed and leaves the rest (Req 39.4);
 *   - backups never cross an Organization boundary (Req 1.4);
 *   - every backup action is recorded in the Audit_Service (Req 39.2).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { BackupService, checksumOf } from './backup-service.js';
import { BackupIntegrityError, BackupNotFoundError, UnsupportedBackupTargetError } from './errors.js';
import {
  CapturingAuditRecorder,
  InMemoryBackupRecordStore,
  InMemoryBackupSource,
  InMemoryObjectStore,
  MutableBackupClock,
  makeBytes,
  makeTenantContext,
  sequentialBackupIdGenerator,
} from './fakes.js';
import { DEFAULT_BACKUP_RETENTION_MS } from './retention.js';
import type { BackupSourceRegistry } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1, 0, 0, 0);

interface Harness {
  service: BackupService;
  db: InMemoryBackupSource;
  vector: InMemoryBackupSource;
  objects: InMemoryObjectStore;
  records: InMemoryBackupRecordStore;
  audit: CapturingAuditRecorder;
  clock: MutableBackupClock;
  ctx: TenantContext;
}

/** Wire the real service over in-memory fakes, with the database + vector targets configured. */
function makeHarness(options: { retentionMs?: number } = {}): Harness {
  const db = new InMemoryBackupSource();
  const vector = new InMemoryBackupSource();
  const objects = new InMemoryObjectStore();
  const records = new InMemoryBackupRecordStore();
  const audit = new CapturingAuditRecorder();
  const clock = new MutableBackupClock(START);
  const sources: BackupSourceRegistry = { database: db, vector_store: vector };
  const service = new BackupService({
    sources,
    objectStore: objects,
    records,
    audit,
    clock,
    retentionMs: options.retentionMs ?? DEFAULT_BACKUP_RETENTION_MS,
    idGenerator: sequentialBackupIdGenerator(),
  });
  const ctx = makeTenantContext({ organizationId: 'org-1', userId: 'user-1' });
  return { service, db, vector, objects, records, audit, clock, ctx };
}

describe('BackupService.backup (Req 39.1, 39.2)', () => {
  it('captures the target state as a point-in-time snapshot and verifies its integrity', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('database-state-v1'));

    const report = await h.service.backup(h.ctx, 'database');

    expect(report.verified).toBe(true);
    expect(report.record.status).toBe('verified');
    expect(report.record.target).toBe('database');
    expect(report.record.id).toBe('backup-1');
    expect(report.record.organizationId).toBe('org-1');
    expect(report.record.recoveryPoint).toBe(new Date(START).toISOString());
    // The checksum is over the captured bytes, and the bytes live in the Object_Store by reference.
    expect(report.record.checksum).toBe(checksumOf(makeBytes('database-state-v1')));
    expect(await h.objects.exists(report.record.objectKey)).toBe(true);
    expect(await h.objects.get(report.record.objectKey)).toEqual(makeBytes('database-state-v1'));
  });

  it('records the backup outcome in the Audit_Service (Req 39.2)', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('state'));

    const report = await h.service.backup(h.ctx, 'database');

    const captures = h.audit.withAction('backup.capture');
    expect(captures).toHaveLength(1);
    expect(captures[0]?.event.resourceId).toBe(report.record.id);
    expect(captures[0]?.event.resourceType).toBe('backup');
    expect(captures[0]?.ctx.organizationId).toBe('org-1');
    expect(captures[0]?.event.metadata?.status).toBe('verified');
  });

  it('stamps an explicit recovery point when supplied (for the Scheduler, Req 39.1)', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('state'));
    const rp = new Date(START - DAY_MS).toISOString();

    const report = await h.service.backup(h.ctx, 'database', { recoveryPoint: rp });

    expect(report.record.recoveryPoint).toBe(rp);
  });

  it('fails closed for a target with no configured source (Req 39.1)', async () => {
    const h = makeHarness();
    await expect(h.service.backup(h.ctx, 'object_store')).rejects.toBeInstanceOf(
      UnsupportedBackupTargetError,
    );
  });

  it('backupAll captures every configured target (Req 39.1)', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('db'));
    h.vector.setState(h.ctx, makeBytes('vec'));

    const reports = await h.service.backupAll(h.ctx);

    expect(reports.map((r) => r.record.target).sort()).toEqual(['database', 'vector_store']);
    expect(reports.every((r) => r.verified)).toBe(true);
    // A single shared recovery point across the run.
    expect(new Set(reports.map((r) => r.record.recoveryPoint)).size).toBe(1);
  });
});

describe('BackupService.restore (Req 39.3, 39.4)', () => {
  it('round-trips a store to its recovery point after subsequent mutations (Req 39.3)', async () => {
    const h = makeHarness();
    // Capture state at v1 ...
    h.db.setState(h.ctx, makeBytes('state-v1'));
    const captured = await h.service.backup(h.ctx, 'database');

    // ... then mutate the live store to v2 ...
    h.db.setState(h.ctx, makeBytes('state-v2-mutated'));
    expect(h.db.getState(h.ctx)).toEqual(makeBytes('state-v2-mutated'));

    // ... and restore to the captured recovery point.
    const restored = await h.service.restore(h.ctx, {
      target: 'database',
      backupId: captured.record.id,
    });

    expect(restored.id).toBe(captured.record.id);
    expect(h.db.getState(h.ctx)).toEqual(makeBytes('state-v1'));
  });

  it('restores the latest recovery point at or before a cutoff (Req 39.4)', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('s1'));
    const b1 = await h.service.backup(h.ctx, 'database', {
      recoveryPoint: new Date(START).toISOString(),
    });
    h.db.setState(h.ctx, makeBytes('s2'));
    await h.service.backup(h.ctx, 'database', {
      recoveryPoint: new Date(START + 2 * DAY_MS).toISOString(),
    });

    // Mutate, then restore to a cutoff between the two recovery points → picks b1.
    h.db.setState(h.ctx, makeBytes('live'));
    const restored = await h.service.restore(h.ctx, {
      target: 'database',
      recoveryPoint: new Date(START + DAY_MS).toISOString(),
    });

    expect(restored.id).toBe(b1.record.id);
    expect(h.db.getState(h.ctx)).toEqual(makeBytes('s1'));
  });

  it('restores the latest backup when no recovery point is specified (Req 39.4)', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('s1'));
    await h.service.backup(h.ctx, 'database', { recoveryPoint: new Date(START).toISOString() });
    h.db.setState(h.ctx, makeBytes('s2'));
    const latest = await h.service.backup(h.ctx, 'database', {
      recoveryPoint: new Date(START + DAY_MS).toISOString(),
    });

    h.db.setState(h.ctx, makeBytes('live'));
    const restored = await h.service.restore(h.ctx, { target: 'database' });

    expect(restored.id).toBe(latest.record.id);
    expect(h.db.getState(h.ctx)).toEqual(makeBytes('s2'));
  });

  it('records a restore in the Audit_Service (Req 39.2)', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('s'));
    const captured = await h.service.backup(h.ctx, 'database');
    await h.service.restore(h.ctx, { target: 'database', backupId: captured.record.id });

    const restores = h.audit.withAction('backup.restore');
    expect(restores).toHaveLength(1);
    expect(restores[0]?.event.resourceId).toBe(captured.record.id);
  });

  it('fails with not-found when restoring an unknown backup id (Req 39.3)', async () => {
    const h = makeHarness();
    await expect(
      h.service.restore(h.ctx, { target: 'database', backupId: 'does-not-exist' }),
    ).rejects.toBeInstanceOf(BackupNotFoundError);
  });

  it('fails with not-found when no recovery point is at or before the cutoff (Req 39.4)', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('s'));
    await h.service.backup(h.ctx, 'database', {
      recoveryPoint: new Date(START + 10 * DAY_MS).toISOString(),
    });
    await expect(
      h.service.restore(h.ctx, {
        target: 'database',
        recoveryPoint: new Date(START).toISOString(),
      }),
    ).rejects.toBeInstanceOf(BackupNotFoundError);
  });

  it('fails with not-found when the target has no retained backups (Req 39.4)', async () => {
    const h = makeHarness();
    await expect(h.service.restore(h.ctx, { target: 'vector_store' })).rejects.toBeInstanceOf(
      BackupNotFoundError,
    );
  });

  it('fails closed with an integrity error when the snapshot bytes were corrupted (Req 39.2)', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('s'));
    const captured = await h.service.backup(h.ctx, 'database');

    // Corrupt the persisted snapshot out from under the catalog entry.
    await h.objects.put(captured.record.objectKey, makeBytes('corrupted-bytes'));

    await expect(
      h.service.restore(h.ctx, { target: 'database', backupId: captured.record.id }),
    ).rejects.toBeInstanceOf(BackupIntegrityError);
    // The live store was not touched.
    expect(h.db.getState(h.ctx)).toEqual(makeBytes('s'));
  });
});

describe('BackupService.listBackups (Req 39.4)', () => {
  it('returns retained backups most-recent recovery point first', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('s'));
    const oldest = await h.service.backup(h.ctx, 'database', {
      recoveryPoint: new Date(START).toISOString(),
    });
    const middle = await h.service.backup(h.ctx, 'database', {
      recoveryPoint: new Date(START + DAY_MS).toISOString(),
    });
    const newest = await h.service.backup(h.ctx, 'database', {
      recoveryPoint: new Date(START + 2 * DAY_MS).toISOString(),
    });

    const listed = await h.service.listBackups(h.ctx, 'database');
    expect(listed.map((r) => r.id)).toEqual([newest.record.id, middle.record.id, oldest.record.id]);
  });

  it('restricts the listing to a single target when one is given', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('db'));
    h.vector.setState(h.ctx, makeBytes('vec'));
    await h.service.backup(h.ctx, 'database');
    await h.service.backup(h.ctx, 'vector_store');

    const dbOnly = await h.service.listBackups(h.ctx, 'database');
    expect(dbOnly).toHaveLength(1);
    expect(dbOnly[0]?.target).toBe('database');

    const all = await h.service.listBackups(h.ctx);
    expect(all).toHaveLength(2);
  });
});

describe('BackupService.discard', () => {
  it('removes the catalog entry and snapshot bytes and audits the discard', async () => {
    const h = makeHarness();
    h.db.setState(h.ctx, makeBytes('s'));
    const captured = await h.service.backup(h.ctx, 'database');

    await h.service.discard(h.ctx, captured.record.id);

    expect(await h.service.listBackups(h.ctx, 'database')).toHaveLength(0);
    expect(await h.objects.exists(captured.record.objectKey)).toBe(false);
    expect(h.audit.withAction('backup.discard')).toHaveLength(1);
  });

  it('fails with not-found for an unknown id', async () => {
    const h = makeHarness();
    await expect(h.service.discard(h.ctx, 'nope')).rejects.toBeInstanceOf(BackupNotFoundError);
  });
});

describe('BackupService.purgeExpired (Req 39.4)', () => {
  it('purges exactly the backups whose retention window has elapsed and leaves the rest', async () => {
    const retentionMs = 7 * DAY_MS;
    const h = makeHarness({ retentionMs });
    h.db.setState(h.ctx, makeBytes('s'));

    // Capture three backups at different instants by advancing the clock.
    h.clock.set(START);
    const b0 = await h.service.backup(h.ctx, 'database'); // created at START
    h.clock.set(START + 3 * DAY_MS);
    const b3 = await h.service.backup(h.ctx, 'database'); // created at START+3d
    h.clock.set(START + 6 * DAY_MS);
    const b6 = await h.service.backup(h.ctx, 'database'); // created at START+6d

    // Now is START + 8d: b0 (age 8d) is expired (>7d); b3 (age 5d) and b6 (age 2d) remain.
    h.clock.set(START + 8 * DAY_MS);
    const purged = await h.service.purgeExpired(h.ctx, 'database');

    expect(new Set(purged)).toEqual(new Set([b0.record.id]));
    const remaining = await h.service.listBackups(h.ctx, 'database');
    expect(new Set(remaining.map((r) => r.id))).toEqual(new Set([b3.record.id, b6.record.id]));
    expect(await h.objects.exists(b0.record.objectKey)).toBe(false);
    expect(h.audit.withAction('backup.retention_purge')).toHaveLength(1);
  });

  it('retains a backup exactly at the retention deadline and purges one millisecond past it', async () => {
    const retentionMs = 7 * DAY_MS;

    // Exactly at the deadline: retained.
    {
      const h = makeHarness({ retentionMs });
      h.db.setState(h.ctx, makeBytes('s'));
      const b = await h.service.backup(h.ctx, 'database');
      h.clock.set(START + retentionMs); // age === retention
      expect(await h.service.purgeExpired(h.ctx, 'database')).toEqual([]);
      expect(await h.service.listBackups(h.ctx, 'database')).toHaveLength(1);
      expect(b.record.id).toBe('backup-1');
    }

    // One millisecond past the deadline: purged.
    {
      const h = makeHarness({ retentionMs });
      h.db.setState(h.ctx, makeBytes('s'));
      const b = await h.service.backup(h.ctx, 'database');
      h.clock.set(START + retentionMs + 1);
      expect(await h.service.purgeExpired(h.ctx, 'database')).toEqual([b.record.id]);
      expect(await h.service.listBackups(h.ctx, 'database')).toHaveLength(0);
    }
  });
});

describe('BackupService tenant isolation (Req 1.4)', () => {
  it('never lists or restores another Organization\u2019s backups', async () => {
    const h = makeHarness();
    const orgA = makeTenantContext({ organizationId: 'org-a', userId: 'a' });
    const orgB = makeTenantContext({ organizationId: 'org-b', userId: 'b' });

    h.db.setState(orgA, makeBytes('org-a-state'));
    h.db.setState(orgB, makeBytes('org-b-state'));
    const aBackup = await h.service.backup(orgA, 'database');

    // Org B cannot see Org A's backup ...
    expect(await h.service.listBackups(orgB, 'database')).toHaveLength(0);
    // ... cannot restore it by id ...
    await expect(
      h.service.restore(orgB, { target: 'database', backupId: aBackup.record.id }),
    ).rejects.toBeInstanceOf(BackupNotFoundError);
    // ... and cannot discard it.
    await expect(h.service.discard(orgB, aBackup.record.id)).rejects.toBeInstanceOf(
      BackupNotFoundError,
    );

    // Org A's backup is intact and restorable within its own Organization.
    h.db.setState(orgA, makeBytes('mutated'));
    await h.service.restore(orgA, { target: 'database', backupId: aBackup.record.id });
    expect(h.db.getState(orgA)).toEqual(makeBytes('org-a-state'));
    // Org B's live state was untouched throughout.
    expect(h.db.getState(orgB)).toEqual(makeBytes('org-b-state'));
  });
});
