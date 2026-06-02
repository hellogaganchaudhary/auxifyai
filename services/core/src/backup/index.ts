/**
 * Backup_Service (Req 39.1-39.4): the platform's point-in-time backup,
 * verification, restore, and retention service.
 *
 * The {@link BackupService} captures scheduled, point-in-time backups of the
 * platform's durable data stores — the Primary_Database, the Vector_Store, and
 * the Object_Store (Req 39.1) — verifies each captured backup's integrity and
 * records its outcome (Req 39.2), restores a selected store to a requested
 * recovery point (Req 39.3), and retains backups for a configured period so any
 * retained recovery point is recoverable (Req 39.4). It is the platform seam the
 * Document_Management_Service's recovery window (task 17.3, the
 * {@link import('../document-management/index.js').DocumentBackupStore}) is the
 * narrow, per-document projection of.
 *
 * Every external capability is a narrow injectable port — a per-target
 * {@link BackupSource} registry (the snapshot/restore mechanics for each store),
 * the shared {@link import('../storage/index.js').ObjectStore} (where each
 * snapshot's bytes are persisted by reference, Req 44.5), a tenant-scoped
 * {@link BackupRecordStore} (the catalog of retained backup metadata), the
 * shared {@link import('../audit/index.js').AuditRecorder} (Req 39.2), and a
 * {@link BackupClock} (so retention is timed deterministically) — so the service
 * is pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`.
 *
 * Surface:
 *   - {@link BackupService.backup} / {@link BackupService.backupAll} — capture
 *     one or every configured target as an integrity-verified, recorded
 *     point-in-time backup (Req 39.1, 39.2);
 *   - {@link BackupService.listBackups} — list a target's retained backups,
 *     most-recent recovery point first (Req 39.4);
 *   - {@link BackupService.restore} — restore a target to a selected recovery
 *     point, re-verifying integrity before touching the live store (Req 39.2,
 *     39.3, 39.4);
 *   - {@link BackupService.discard} / {@link BackupService.purgeExpired} —
 *     discard a single backup, or age out exactly the backups whose retention
 *     window has elapsed (Req 39.4);
 *   - the pure {@link isWithinRetention} / {@link isRetentionExpired} /
 *     {@link retentionDeadlineMs} retention core and
 *     {@link DEFAULT_BACKUP_RETENTION_MS};
 *   - {@link checksumOf}, the deterministic integrity digest (Req 39.2);
 *   - the typed errors and their stable codes
 *     ({@link UnsupportedBackupTargetError}, {@link BackupNotFoundError},
 *     {@link BackupIntegrityError}).
 *
 * The in-memory test fakes (an in-memory backup source, a tenant-scoped catalog,
 * a capturing audit recorder, the advanceable {@link MutableBackupClock}, and the
 * builders) live in `./fakes.js` and are intentionally NOT re-exported from this
 * barrel — they would collide with the equally-named audit-recorder / object-store
 * fakes of sibling modules at the package barrel. Following the established
 * convention, the tests import them directly from `./fakes.js`.
 *
 * The injectable clock is surfaced as {@link BackupClock} /
 * {@link systemBackupClock} (rather than `Clock` / `systemClock`) so the names
 * never collide with the Model_Router's, Scheduler's, Cache_Manager's,
 * Budget_Manager's, or Document_Management_Service's identically-purposed clocks
 * in the shared `@auxify/core` barrel; the domain names are `Backup`-prefixed for
 * the same reason.
 */

export {
  BackupService,
  checksumOf,
  type BackupServiceOptions,
  type BackupOptions,
  type BackupIdGenerator,
} from './backup-service.js';

export {
  DEFAULT_BACKUP_RETENTION_MS,
  retentionDeadlineMs,
  isWithinRetention,
  isRetentionExpired,
} from './retention.js';

export {
  UnsupportedBackupTargetError,
  BackupNotFoundError,
  BackupIntegrityError,
  UNSUPPORTED_BACKUP_TARGET_CODE,
  BACKUP_NOT_FOUND_CODE,
  BACKUP_INTEGRITY_CODE,
} from './errors.js';

export {
  systemBackupClock,
  BACKUP_TARGET_KINDS,
  BACKUP_STATUSES,
  isBackupTargetKind,
  type BackupTargetKind,
  type BackupStatus,
  type BackupRecord,
  type BackupReport,
  type RestoreRequest,
  type BackupSource,
  type BackupSourceRegistry,
  type BackupRecordStore,
  type BackupClock,
} from './types.js';
