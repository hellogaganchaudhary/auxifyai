/**
 * The pure backup-retention core (Req 39.4).
 *
 * A captured backup is retained — and therefore recoverable (Req 39.4) — for a
 * configured duration after its creation: the *retention window*. Once that
 * window elapses the backup is eligible to be purged and is no longer a usable
 * recovery point. This module isolates the boundary arithmetic of that window as
 * small, total, side-effect-free functions so the Backup_Service (and its unit
 * tests) can reason about retention deterministically against an injectable
 * {@link import('./types.js').BackupClock}.
 *
 * The window is inclusive at its closing instant: a backup created at
 * `createdAtMs` is retained for every instant `nowMs` with
 * `createdAtMs <= nowMs <= createdAtMs + retentionMs`, and is expired (eligible
 * for purge) strictly past the deadline. This mirrors the
 * Document_Management_Service's recovery-window convention exactly so the two
 * boundary models never drift.
 */

/** The platform default backup retention period: 30 days, in milliseconds (Req 39.4). */
export const DEFAULT_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The instant (epoch ms) at which a backup's retention window closes.
 *
 * @param createdAtMs The capture instant, in epoch milliseconds.
 * @param retentionMs The configured retention duration, in milliseconds.
 * @returns The epoch-millisecond deadline `createdAtMs + retentionMs`.
 */
export function retentionDeadlineMs(createdAtMs: number, retentionMs: number): number {
  return createdAtMs + retentionMs;
}

/**
 * Whether a backup created at `createdAtMs` is still retained at `nowMs`
 * (Req 39.4).
 *
 * The window is inclusive of its closing instant: the backup is retained iff
 * `createdAtMs <= nowMs <= createdAtMs + retentionMs`. A reference instant
 * before the capture instant (a non-physical clock) is treated as not retained.
 *
 * @param createdAtMs The capture instant, in epoch milliseconds.
 * @param nowMs The reference instant, in epoch milliseconds.
 * @param retentionMs The configured retention duration, in milliseconds.
 * @returns `true` iff the backup is still a usable recovery point at `nowMs`.
 */
export function isWithinRetention(
  createdAtMs: number,
  nowMs: number,
  retentionMs: number,
): boolean {
  return nowMs >= createdAtMs && nowMs <= retentionDeadlineMs(createdAtMs, retentionMs);
}

/**
 * Whether a backup's retention window has elapsed at `nowMs`, so it is eligible
 * for purge (Req 39.4).
 *
 * This is the strict complement of {@link isWithinRetention} for a
 * physically-ordered clock: the window has expired iff `nowMs` is strictly past
 * the deadline.
 *
 * @param createdAtMs The capture instant, in epoch milliseconds.
 * @param nowMs The current instant, in epoch milliseconds.
 * @param retentionMs The configured retention duration, in milliseconds.
 * @returns `true` iff the retention window has closed at `nowMs`.
 */
export function isRetentionExpired(
  createdAtMs: number,
  nowMs: number,
  retentionMs: number,
): boolean {
  return nowMs > retentionDeadlineMs(createdAtMs, retentionMs);
}
