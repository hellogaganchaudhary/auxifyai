/**
 * The Backup_Service (Req 39.1-39.4).
 *
 * Captures point-in-time backups of the platform's durable data stores — the
 * Primary_Database, the Vector_Store, and the Object_Store (Req 39.1) — verifies
 * each captured backup's integrity and records its outcome (Req 39.2), restores
 * a selected store to a requested recovery point (Req 39.3), and retains backups
 * for a configured period so any retained recovery point is recoverable
 * (Req 39.4). It is the platform seam the Document_Management_Service's recovery
 * window references.
 *
 * It is pure orchestration over five injectable ports — a per-target
 * {@link BackupSource} registry, the shared
 * {@link import('../storage/index.js').ObjectStore} (where snapshot bytes live
 * by reference), a tenant-scoped {@link BackupRecordStore} (the catalog of
 * retained backup metadata), the shared
 * {@link import('../audit/index.js').AuditRecorder} (Req 39.2), and a
 * {@link BackupClock} (so retention is timed deterministically) — so it is fully
 * unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * Surface (one method per acceptance criterion):
 *   - {@link BackupService.backup} — capture one target's current state as a
 *     point-in-time snapshot stored by reference, verify its integrity, record
 *     the outcome, and return a {@link BackupReport} (Req 39.1, 39.2).
 *   - {@link BackupService.backupAll} — capture every configured target at once,
 *     for the Scheduler driving periodic backups (Req 39.1).
 *   - {@link BackupService.listBackups} — list a target's retained backups,
 *     most-recent recovery point first (Req 39.4).
 *   - {@link BackupService.restore} — restore a target to a selected recovery
 *     point (an explicit id, the latest at-or-before a cutoff, or simply the
 *     latest), re-verifying integrity before touching the live store (Req 39.2,
 *     39.3, 39.4).
 *   - {@link BackupService.discard} — discard a single retained backup.
 *   - {@link BackupService.purgeExpired} — purge exactly the backups whose
 *     configured retention window has elapsed (Req 39.4).
 *
 * Tenancy: every operation takes the caller's {@link TenantContext}; snapshot
 * bytes are keyed under the Organization in the Object_Store and the catalog is
 * Organization-scoped, so a backup never crosses a tenant boundary (Req 1.4).
 */

import { createHash, randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import { ObjectNotFoundError, type ObjectStore } from '../storage/index.js';
import {
  BackupIntegrityError,
  BackupNotFoundError,
  UnsupportedBackupTargetError,
} from './errors.js';
import { DEFAULT_BACKUP_RETENTION_MS, isRetentionExpired } from './retention.js';
import {
  systemBackupClock,
  type BackupClock,
  type BackupRecord,
  type BackupRecordStore,
  type BackupReport,
  type BackupSource,
  type BackupSourceRegistry,
  type BackupTargetKind,
  type RestoreRequest,
} from './types.js';

/** Generates unique backup ids (injectable for deterministic tests). */
export interface BackupIdGenerator {
  /** A unique backup id. */
  backupId(): string;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: BackupIdGenerator = {
  backupId: () => randomUUID(),
};

/** Options narrowing a single {@link BackupService.backup} capture. */
export interface BackupOptions {
  /**
   * The ISO-8601 recovery point the snapshot represents (Req 39.3); defaults to
   * the clock's "now". Lets the Scheduler stamp a backup with the cadence
   * instant it fired for.
   */
  recoveryPoint?: string;
  /** An explicit backup id (defaults to a generated id). */
  id?: string;
}

/** Construction options for the {@link BackupService}. */
export interface BackupServiceOptions {
  /**
   * The per-target snapshot/restore sources (Req 39.1). A target without a
   * configured source is rejected with {@link UnsupportedBackupTargetError}.
   */
  sources: BackupSourceRegistry;
  /** The Object_Store where snapshot bytes are persisted by reference (Req 44.5). */
  objectStore: ObjectStore;
  /** The tenant-scoped catalog of retained backup metadata (Req 39.2, 39.4). */
  records: BackupRecordStore;
  /** The append-only audit sink; every backup action is recorded through it (Req 39.2). */
  audit: AuditRecorder;
  /** Optional clock for "now" (defaults to {@link systemBackupClock}), for deterministic tests. */
  clock?: BackupClock;
  /**
   * The retention window backups are kept for, in milliseconds (Req 39.4);
   * defaults to {@link DEFAULT_BACKUP_RETENTION_MS}.
   */
  retentionMs?: number;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: BackupIdGenerator;
}

/**
 * The Backup_Service: captures, verifies, lists, restores, discards, and ages
 * out point-in-time backups of the platform's durable data stores
 * (Req 39.1-39.4).
 */
export class BackupService {
  private readonly sources: BackupSourceRegistry;
  private readonly objectStore: ObjectStore;
  private readonly records: BackupRecordStore;
  private readonly audit: AuditRecorder;
  private readonly clock: BackupClock;
  private readonly retentionMs: number;
  private readonly ids: BackupIdGenerator;

  constructor(options: BackupServiceOptions) {
    this.sources = { ...options.sources };
    this.objectStore = options.objectStore;
    this.records = options.records;
    this.audit = options.audit;
    this.clock = options.clock ?? systemBackupClock;
    this.retentionMs = options.retentionMs ?? DEFAULT_BACKUP_RETENTION_MS;
    this.ids = options.idGenerator ?? defaultIdGenerator;
  }

  /**
   * Capture a point-in-time backup of one target's current state (Req 39.1),
   * verify its integrity, and record the outcome (Req 39.2).
   *
   * Snapshots the target through its configured {@link BackupSource}, persists
   * the opaque snapshot bytes in the Object_Store *by reference* under a
   * tenant-scoped key, then reads them back and compares checksums to verify
   * integrity. The catalog entry is persisted with the verified/failed status
   * either way (so a failed backup is still recorded, Req 39.2) and a
   * `backup.capture` audit event is recorded.
   *
   * @param ctx The tenant scope to back up.
   * @param target The store to capture (Req 39.1).
   * @param options Optional explicit recovery point and/or id.
   * @returns The {@link BackupReport} — the persisted record and the verified flag.
   * @throws {UnsupportedBackupTargetError} If `target` has no configured source.
   */
  async backup(
    ctx: TenantContext,
    target: BackupTargetKind,
    options: BackupOptions = {},
  ): Promise<BackupReport> {
    const source = this.sourceFor(target);
    const nowMs = this.clock.now();
    const id = options.id ?? this.ids.backupId();
    const recoveryPoint = options.recoveryPoint ?? new Date(nowMs).toISOString();
    const createdAt = new Date(nowMs).toISOString();
    const objectKey = this.objectKey(ctx.organizationId, target, id);

    const snapshot = await source.capture(ctx);
    const checksum = checksumOf(snapshot);
    await this.objectStore.put(objectKey, snapshot, {
      contentType: 'application/octet-stream',
      metadata: { organizationId: ctx.organizationId, target, backupId: id },
    });

    // Verify integrity by reading the persisted bytes back and re-checksumming
    // (Req 39.2): a usable recovery point is one whose stored bytes match.
    const verified = await this.verifyStored(objectKey, checksum);

    const record: BackupRecord = {
      id,
      organizationId: ctx.organizationId,
      target,
      recoveryPoint,
      objectKey,
      sizeBytes: snapshot.byteLength,
      checksum,
      status: verified ? 'verified' : 'failed',
      createdAt,
    };
    await this.records.put(ctx, record);

    await this.audit.record(ctx, {
      action: 'backup.capture',
      resourceType: 'backup',
      resourceId: id,
      timestamp: createdAt,
      metadata: {
        target,
        recoveryPoint,
        sizeBytes: record.sizeBytes,
        status: record.status,
      },
    });

    return { record, verified };
  }

  /**
   * Capture every configured target at once (Req 39.1) — the entry point for the
   * Scheduler driving periodic platform backups at the configured frequency.
   *
   * @param ctx The tenant scope to back up.
   * @param options Optional shared recovery point applied to each target's capture.
   * @returns One {@link BackupReport} per configured target.
   */
  async backupAll(ctx: TenantContext, options: BackupOptions = {}): Promise<BackupReport[]> {
    const recoveryPoint = options.recoveryPoint ?? new Date(this.clock.now()).toISOString();
    const reports: BackupReport[] = [];
    for (const target of Object.keys(this.sources) as BackupTargetKind[]) {
      reports.push(await this.backup(ctx, target, { recoveryPoint }));
    }
    return reports;
  }

  /**
   * List a target's retained backups, most-recent recovery point first
   * (Req 39.4).
   *
   * Ordering is stable and deterministic: by `recoveryPoint` descending, then
   * `createdAt` descending, then `id` ascending, so the head is always the
   * latest recovery point.
   *
   * @param ctx The tenant scope.
   * @param target Optionally restrict the listing to a single target.
   * @returns The retained backups in most-recent-first order.
   */
  async listBackups(ctx: TenantContext, target?: BackupTargetKind): Promise<BackupRecord[]> {
    const all = await this.records.list(ctx, target);
    return [...all].sort(compareMostRecentFirst);
  }

  /**
   * Restore a target to a selected recovery point (Req 39.3, 39.4).
   *
   * Resolves which retained backup to restore — an explicit
   * {@link RestoreRequest.backupId}; else the latest verified backup whose
   * recovery point is at or before {@link RestoreRequest.recoveryPoint}; else the
   * latest verified backup for the target — then re-verifies the snapshot's
   * integrity against its recorded checksum before replacing the live store's
   * state, so a corrupted recovery point fails closed rather than restoring
   * (Req 39.2). Records a `backup.restore` audit event on success.
   *
   * @param ctx The tenant scope to restore.
   * @param request The target and recovery-point selection.
   * @returns The {@link BackupRecord} that was restored.
   * @throws {UnsupportedBackupTargetError} If the target has no configured source.
   * @throws {BackupNotFoundError} If no retained backup matches the selection.
   * @throws {BackupIntegrityError} If the selected snapshot fails verification.
   */
  async restore(ctx: TenantContext, request: RestoreRequest): Promise<BackupRecord> {
    const source = this.sourceFor(request.target);
    const record = await this.resolveRestoreTarget(ctx, request);

    const snapshot = await this.readVerified(record);
    await source.restore(ctx, snapshot);

    await this.audit.record(ctx, {
      action: 'backup.restore',
      resourceType: 'backup',
      resourceId: record.id,
      timestamp: new Date(this.clock.now()).toISOString(),
      metadata: { target: record.target, recoveryPoint: record.recoveryPoint },
    });

    return record;
  }

  /**
   * Discard a single retained backup: remove its catalog entry and its snapshot
   * bytes, and record a `backup.discard` audit event.
   *
   * @param ctx The tenant scope.
   * @param backupId The backup to discard.
   * @throws {BackupNotFoundError} If no backup with that id exists in the Organization.
   */
  async discard(ctx: TenantContext, backupId: string): Promise<void> {
    const record = await this.records.findById(ctx, backupId);
    if (record === null) {
      throw new BackupNotFoundError('database', `no backup with id "${backupId}"`);
    }
    await this.records.remove(ctx, backupId);
    await this.objectStore.delete(record.objectKey);
    await this.audit.record(ctx, {
      action: 'backup.discard',
      resourceType: 'backup',
      resourceId: backupId,
      timestamp: new Date(this.clock.now()).toISOString(),
      metadata: { target: record.target, recoveryPoint: record.recoveryPoint },
    });
  }

  /**
   * Purge exactly the backups whose configured retention window has elapsed at
   * "now" (Req 39.4).
   *
   * A backup created at `createdAt` is purged iff `now` is strictly past
   * `createdAt + retentionMs` (the pure {@link isRetentionExpired} boundary), so
   * a still-retained backup is never removed and an expired one never remains.
   * Each purge removes the catalog entry and its snapshot bytes and records a
   * `backup.retention_purge` audit event.
   *
   * @param ctx The tenant scope.
   * @param target Optionally restrict the purge to a single target.
   * @returns The ids of the backups that were purged, in most-recent-first order.
   */
  async purgeExpired(ctx: TenantContext, target?: BackupTargetKind): Promise<string[]> {
    const nowMs = this.clock.now();
    const candidates = await this.listBackups(ctx, target);
    const purged: string[] = [];
    for (const record of candidates) {
      if (isRetentionExpired(Date.parse(record.createdAt), nowMs, this.retentionMs)) {
        await this.records.remove(ctx, record.id);
        await this.objectStore.delete(record.objectKey);
        await this.audit.record(ctx, {
          action: 'backup.retention_purge',
          resourceType: 'backup',
          resourceId: record.id,
          timestamp: new Date(nowMs).toISOString(),
          metadata: { target: record.target, recoveryPoint: record.recoveryPoint },
        });
        purged.push(record.id);
      }
    }
    return purged;
  }

  // --- internals ---------------------------------------------------------

  /** Resolve the configured source for a target or fail closed (Req 39.1). */
  private sourceFor(target: BackupTargetKind): BackupSource {
    const source = this.sources[target];
    if (source === undefined) {
      throw new UnsupportedBackupTargetError(target);
    }
    return source;
  }

  /** The tenant-scoped Object_Store key a target's snapshot bytes live under. */
  private objectKey(organizationId: string, target: BackupTargetKind, id: string): string {
    return `backups/${organizationId}/${target}/${id}`;
  }

  /** Read the persisted bytes back and confirm they match the capture checksum (Req 39.2). */
  private async verifyStored(objectKey: string, checksum: string): Promise<boolean> {
    try {
      const stored = await this.objectStore.get(objectKey);
      return checksumOf(stored) === checksum;
    } catch (cause) {
      if (cause instanceof ObjectNotFoundError) {
        return false;
      }
      throw cause;
    }
  }

  /**
   * Resolve which retained backup a {@link RestoreRequest} selects, failing
   * closed with {@link BackupNotFoundError} when nothing matches (Req 39.3, 39.4).
   */
  private async resolveRestoreTarget(
    ctx: TenantContext,
    request: RestoreRequest,
  ): Promise<BackupRecord> {
    if (request.backupId !== undefined) {
      const found = await this.records.findById(ctx, request.backupId);
      if (found === null || found.target !== request.target) {
        throw new BackupNotFoundError(
          request.target,
          `no backup with id "${request.backupId}"`,
        );
      }
      return found;
    }

    // Only a verified backup is a usable recovery point (Req 39.4).
    const usable = (await this.listBackups(ctx, request.target)).filter(
      (record) => record.status === 'verified',
    );

    if (request.recoveryPoint !== undefined) {
      const cutoff = request.recoveryPoint;
      const atOrBefore = usable.filter((record) => record.recoveryPoint <= cutoff);
      const selected = atOrBefore[0];
      if (selected === undefined) {
        throw new BackupNotFoundError(
          request.target,
          `no retained recovery point at or before "${cutoff}"`,
        );
      }
      return selected;
    }

    const latest = usable[0];
    if (latest === undefined) {
      throw new BackupNotFoundError(request.target, 'no retained backups');
    }
    return latest;
  }

  /** Read a backup's snapshot bytes and re-verify integrity before a restore (Req 39.2). */
  private async readVerified(record: BackupRecord): Promise<Uint8Array> {
    let snapshot: Uint8Array;
    try {
      snapshot = await this.objectStore.get(record.objectKey);
    } catch (cause) {
      if (cause instanceof ObjectNotFoundError) {
        throw new BackupIntegrityError(record.id, record.target);
      }
      throw cause;
    }
    if (record.status !== 'verified' || checksumOf(snapshot) !== record.checksum) {
      throw new BackupIntegrityError(record.id, record.target);
    }
    return snapshot;
  }
}

/**
 * Compute a backup's integrity checksum over its snapshot bytes (Req 39.2).
 *
 * A SHA-256 hex digest: deterministic, so the same bytes always verify and any
 * difference (corruption, truncation) is detected before a restore.
 */
export function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Order two backups most-recent recovery point first, then most-recently
 * created, then by id — the stable total order {@link BackupService.listBackups}
 * presents.
 */
function compareMostRecentFirst(a: BackupRecord, b: BackupRecord): number {
  if (a.recoveryPoint !== b.recoveryPoint) {
    return a.recoveryPoint < b.recoveryPoint ? 1 : -1;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
