/**
 * Backup_Service typed errors (Req 39.1-39.4).
 *
 * These are the *rejection* errors the Backup_Service raises when a request
 * cannot be served — distinct from a recorded backup *outcome* (a verified /
 * failed {@link import('./types.js').BackupStatus} on a {@link BackupRecord}),
 * which is ordinary data, not a thrown error. Each projects into the
 * platform-wide serializable {@link PlatformError} (Req 46.8) so the same wire
 * shape crosses the REST_API, the WebSocket_Gateway, and the SDK, carrying
 * structured, secret-free `details`:
 *
 *  - {@link UnsupportedBackupTargetError} — a backup/restore was requested for a
 *    {@link BackupTargetKind} that has no configured {@link BackupSource}, so the
 *    service cannot snapshot or restore it (fail-closed, Req 39.1, 39.3).
 *  - {@link BackupNotFoundError} — a restore named a recovery point with no
 *    matching retained backup (Req 39.3, 39.4).
 *  - {@link BackupIntegrityError} — a restore was attempted from a backup whose
 *    bytes no longer match the checksum recorded at capture, so restoring it
 *    would corrupt the store (fail-closed, Req 39.2).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { BackupTargetKind } from './types.js';

/** The stable machine-readable code for a backup target with no configured source (Req 39.1). */
export const UNSUPPORTED_BACKUP_TARGET_CODE = 'BACKUP_UNSUPPORTED_TARGET' as const;

/** The stable machine-readable code for a missing recovery point (Req 39.3, 39.4). */
export const BACKUP_NOT_FOUND_CODE = 'BACKUP_NOT_FOUND' as const;

/** The stable machine-readable code for a failed integrity check before restore (Req 39.2). */
export const BACKUP_INTEGRITY_CODE = 'BACKUP_INTEGRITY_FAILED' as const;

/**
 * Thrown when a backup or restore is requested for a {@link BackupTargetKind}
 * that has no configured {@link import('./types.js').BackupSource} (Req 39.1,
 * 39.3).
 *
 * The service fails closed rather than silently skipping the target.
 * Categorized `validation` (an unserviceable request).
 */
export class UnsupportedBackupTargetError extends Error {
  /** The target that has no configured source. */
  readonly target: BackupTargetKind;

  constructor(target: BackupTargetKind) {
    super(`No backup source is configured for target "${target}"`);
    this.name = 'UnsupportedBackupTargetError';
    this.target = target;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link UNSUPPORTED_BACKUP_TARGET_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNSUPPORTED_BACKUP_TARGET_CODE,
      message: this.message,
      correlationId,
      details: { target: this.target },
    });
  }
}

/**
 * Thrown when a restore selects a recovery point for which no retained backup
 * exists (Req 39.3, 39.4).
 *
 * Covers an unknown backup id, a recovery-point cutoff before the earliest
 * retained backup, and a target with no retained backups at all. Categorized
 * `not_found`.
 */
export class BackupNotFoundError extends Error {
  /** The target the restore was requested for. */
  readonly target: BackupTargetKind;
  /** A short, secret-free reason describing why no recovery point matched. */
  readonly reason: string;

  constructor(target: BackupTargetKind, reason: string) {
    super(`No retained backup for target "${target}": ${reason}`);
    this.name = 'BackupNotFoundError';
    this.target = target;
    this.reason = reason;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `not_found`, code {@link BACKUP_NOT_FOUND_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: BACKUP_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { target: this.target, reason: this.reason },
    });
  }
}

/**
 * Thrown when a restore is attempted from a backup whose stored bytes no longer
 * match the checksum recorded at capture (Req 39.2).
 *
 * Restoring a corrupted snapshot would damage the live store, so the service
 * fails closed and surfaces the integrity failure rather than restoring.
 * Categorized `conflict` (the retained artifact is inconsistent with its
 * recorded state).
 */
export class BackupIntegrityError extends Error {
  /** The id of the backup that failed verification. */
  readonly backupId: string;
  /** The target the backup covered. */
  readonly target: BackupTargetKind;

  constructor(backupId: string, target: BackupTargetKind) {
    super(`Backup "${backupId}" for target "${target}" failed integrity verification`);
    this.name = 'BackupIntegrityError';
    this.backupId = backupId;
    this.target = target;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `conflict`, code {@link BACKUP_INTEGRITY_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'conflict',
      code: BACKUP_INTEGRITY_CODE,
      message: this.message,
      correlationId,
      details: { backupId: this.backupId, target: this.target },
    });
  }
}
