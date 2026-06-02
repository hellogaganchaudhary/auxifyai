/**
 * Backup_Service domain types and injectable ports (Req 39.1-39.4).
 *
 * The Backup_Service captures point-in-time backups of the platform's durable
 * data stores — the Primary_Database, the Vector_Store, and the Object_Store
 * (Req 39.1) — verifies each captured backup's integrity and records its
 * outcome (Req 39.2), restores a selected store to a requested recovery point
 * (Req 39.3), and retains backups for a configured period so any retained
 * recovery point is recoverable (Req 39.4). It is the platform seam the
 * Document_Management_Service's recovery window references; here it is the
 * general service the design specifies.
 *
 * Everything the service cannot do purely is a narrow injectable port so it
 * stays pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`:
 *
 *   - a {@link BackupSource} per {@link BackupTargetKind} — the seam that
 *     snapshots a store's current state and restores a captured snapshot
 *     (production wires the database/vector/object adapters; tests substitute an
 *     in-memory source);
 *   - the shared {@link import('../storage/index.js').ObjectStore} — where each
 *     snapshot's bytes are persisted by reference (Req 44.5), keyed under the
 *     owning Organization so backups never cross a tenant boundary;
 *   - a tenant-scoped {@link BackupRecordStore} — the catalog of retained
 *     backup metadata (recovery point, integrity checksum, outcome);
 *   - the shared {@link import('../audit/index.js').AuditRecorder} — every
 *     capture, restore, discard, and retention purge is recorded (Req 39.2);
 *   - a {@link BackupClock} — so retention is timed deterministically in tests.
 *
 * Tenancy: every backup carries its `organizationId`; the
 * {@link BackupRecordStore} requires a {@link TenantContext} on every method and
 * confines the operation to the caller's Organization (Req 1.2, 1.4), and the
 * snapshot bytes are keyed under that Organization in the Object_Store.
 */

import type { TenantContext } from '@auxify/types';

/**
 * The kinds of durable platform data the Backup_Service captures (Req 39.1).
 *
 * Mirrors the design's covered stores: the Primary_Database, the Vector_Store,
 * and the Object_Store. Each kind is backed by its own injectable
 * {@link BackupSource} so the snapshot/restore mechanics stay decoupled from the
 * orchestration.
 */
export type BackupTargetKind = 'database' | 'vector_store' | 'object_store';

/** All {@link BackupTargetKind} values, for iteration, validation, and test generators. */
export const BACKUP_TARGET_KINDS: readonly BackupTargetKind[] = [
  'database',
  'vector_store',
  'object_store',
] as const;

/** Narrow runtime guard that a value is a supported {@link BackupTargetKind}. */
export function isBackupTargetKind(value: unknown): value is BackupTargetKind {
  return typeof value === 'string' && (BACKUP_TARGET_KINDS as readonly string[]).includes(value);
}

/**
 * The integrity outcome recorded for a completed backup (Req 39.2).
 *
 * A backup whose bytes read back from the Object_Store match the checksum
 * computed at capture is `verified`; one whose bytes are missing or differ is
 * `failed`. Only a `verified` backup is a usable recovery point.
 */
export type BackupStatus = 'verified' | 'failed';

/** All {@link BackupStatus} values, for iteration and test generators. */
export const BACKUP_STATUSES: readonly BackupStatus[] = ['verified', 'failed'] as const;

/**
 * The retained metadata of a single captured backup (Req 39.2, 39.4).
 *
 * The snapshot bytes themselves live in the Object_Store under {@link objectKey}
 * (a point-in-time copy stored by reference); this record is the catalog entry
 * the service lists, restores from, discards, and ages out under the retention
 * policy. {@link recoveryPoint} is the instant the snapshot represents — the
 * recovery point a restore targets (Req 39.3) — and {@link checksum} is the
 * integrity digest verified on capture and again before any restore (Req 39.2).
 */
export interface BackupRecord {
  /** The backup's stable unique id. */
  id: string;
  /** The Organization that owns the backup (its tenant scope, Req 1.4). */
  organizationId: string;
  /** The store the backup captured (Req 39.1). */
  target: BackupTargetKind;
  /** The ISO-8601 instant the snapshot represents — the recovery point (Req 39.3, 39.4). */
  recoveryPoint: string;
  /** The Object_Store key the snapshot bytes are persisted under (by reference). */
  objectKey: string;
  /** The captured snapshot size, in bytes. */
  sizeBytes: number;
  /** The integrity checksum of the snapshot bytes, verified before restore (Req 39.2). */
  checksum: string;
  /** The recorded integrity outcome of the backup (Req 39.2). */
  status: BackupStatus;
  /** The ISO-8601 instant the backup was created. */
  createdAt: string;
}

/**
 * The outcome of a {@link BackupService.backup} call (the design's
 * `BackupReport`, Req 39.2).
 *
 * Carries the persisted {@link BackupRecord} and the verified integrity flag so
 * a caller (or the Scheduler driving periodic backups, Req 39.1) can record and
 * act on the outcome without re-reading the catalog.
 */
export interface BackupReport {
  /** The persisted backup catalog entry. */
  record: BackupRecord;
  /** Whether the backup's integrity verified on capture (Req 39.2). */
  verified: boolean;
}

/**
 * A request to restore a store to a retained recovery point (Req 39.3, 39.4).
 *
 * Names the {@link target} store and selects which retained recovery point to
 * restore: an explicit {@link backupId}; or the latest backup whose recovery
 * point is at or before {@link recoveryPoint}; or, when neither is given, the
 * latest retained backup for the target.
 */
export interface RestoreRequest {
  /** The store to restore (Req 39.3). */
  target: BackupTargetKind;
  /** Restore this specific backup by id; takes precedence over {@link recoveryPoint}. */
  backupId?: string;
  /** Restore the latest backup whose recovery point is at or before this ISO-8601 instant. */
  recoveryPoint?: string;
}

/**
 * The seam that snapshots a store's current state and restores a captured
 * snapshot (Req 39.1, 39.3).
 *
 * Modelling each store's backup mechanics as a narrow port keeps the
 * Backup_Service decoupled from the concrete Primary_Database / Vector_Store /
 * Object_Store: production wires an adapter per {@link BackupTargetKind}, while
 * tests substitute an in-memory source. A {@link capture} returns the store's
 * current state as opaque, serializable bytes the service persists by reference;
 * a {@link restore} replaces the store's state with previously captured bytes,
 * which is what makes a backup → mutate → restore sequence round-trip
 * (Property 59). Both are tenant-scoped so a backup confines to its Organization.
 */
export interface BackupSource {
  /**
   * Capture the target store's current state for the caller's Organization as
   * opaque, serializable bytes (Req 39.1).
   *
   * @param ctx The tenant scope to snapshot.
   * @returns The point-in-time snapshot bytes.
   */
  capture(ctx: TenantContext): Promise<Uint8Array>;
  /**
   * Restore the target store's state for the caller's Organization from a
   * previously captured snapshot (Req 39.3).
   *
   * @param ctx The tenant scope to restore.
   * @param snapshot The snapshot bytes a prior {@link capture} produced.
   */
  restore(ctx: TenantContext, snapshot: Uint8Array): Promise<void>;
}

/**
 * The set of {@link BackupSource}s the Backup_Service backs up and restores,
 * keyed by {@link BackupTargetKind} (Req 39.1).
 *
 * A target without a configured source is rejected by the service with an
 * {@link import('./errors.js').UnsupportedBackupTargetError}, so a deployment
 * can wire only the stores it operates while the service fails closed on any
 * other target.
 */
export type BackupSourceRegistry = Partial<Record<BackupTargetKind, BackupSource>>;

/**
 * The tenant-scoped catalog of retained backup metadata (Req 39.2, 39.4).
 *
 * Every method takes the caller's {@link TenantContext} so the catalog is
 * automatically scoped to the Organization (Req 1.2, 1.4) — the service never
 * touches a backend directly. The concrete implementation is the tenant-scoped
 * repository; tests substitute the in-memory
 * {@link import('./fakes.js').InMemoryBackupRecordStore}.
 */
export interface BackupRecordStore {
  /** Persist (insert or replace) a backup catalog entry within the caller's Organization. */
  put(ctx: TenantContext, record: BackupRecord): Promise<void>;
  /** Fetch a backup by id within the caller's Organization, or `null` if none matches. */
  findById(ctx: TenantContext, id: string): Promise<BackupRecord | null>;
  /**
   * List the caller's Organization's backups, optionally for a single target
   * (Req 39.4). Ordering is the service's concern; the store may return any order.
   */
  list(ctx: TenantContext, target?: BackupTargetKind): Promise<BackupRecord[]>;
  /**
   * Remove a backup catalog entry within the caller's Organization (a discard or
   * a retention purge). Returns the removed record, or `null` if none matched.
   */
  remove(ctx: TenantContext, id: string): Promise<BackupRecord | null>;
}

/**
 * The injectable clock the service reads to time retention (Req 39.4).
 *
 * Injectable so unit tests can age backups deterministically without real time:
 * a hand-advanced clock fixes "now" and moves it across a backup's retention
 * deadline. Named {@link BackupClock} (not `Clock`) so it never collides with
 * the Model_Router's, Scheduler's, or Document_Management_Service's
 * identically-purposed clocks in the shared `@auxify/core` barrel.
 */
export interface BackupClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link BackupClock}, backed by the global `Date.now`. */
export const systemBackupClock: BackupClock = { now: () => Date.now() };
