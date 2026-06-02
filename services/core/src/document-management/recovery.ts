/**
 * The pure recovery-window core (Req 28.7, Property 60).
 *
 * A soft-deleted document is restorable from the Backup_Service for a configured
 * duration — the *recovery window* — after which it is permanently purged and can
 * no longer be recovered. This module isolates the boundary arithmetic of that
 * window as small, total, side-effect-free functions so the
 * Document_Management_Service (and its property tests) can reason about recovery
 * timing deterministically against an injectable {@link DocumentClock}.
 *
 * The window is a half-bounded-at-deletion, inclusive-at-the-deadline interval:
 * a document soft-deleted at instant `deletedAt` is recoverable for every instant
 * `now` with `deletedAt <= now <= deletedAt + windowMs`. Recovery "succeeds
 * exactly within the recovery window" (Property 60) — at the deadline instant it
 * is still recoverable, and one millisecond later it is not.
 */

/** The platform default recovery window: 30 days, in milliseconds (Req 28.7). */
export const DEFAULT_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The instant (epoch ms) at which a document's recovery window closes.
 *
 * @param deletedAtMs The soft-delete instant, in epoch milliseconds.
 * @param windowMs The configured recovery window duration, in milliseconds.
 * @returns The epoch-millisecond deadline `deletedAtMs + windowMs`.
 */
export function recoveryDeadlineMs(deletedAtMs: number, windowMs: number): number {
  return deletedAtMs + windowMs;
}

/**
 * Whether a recovery request at `nowMs` falls within the recovery window of a
 * document soft-deleted at `deletedAtMs` (Req 28.7, Property 60).
 *
 * The window is inclusive of its closing instant: the request is within the
 * window iff `deletedAtMs <= nowMs <= deletedAtMs + windowMs`. A request before
 * the deletion instant (a non-physical clock) is not within the window.
 *
 * @param deletedAtMs The soft-delete instant, in epoch milliseconds.
 * @param nowMs The recovery-request instant, in epoch milliseconds.
 * @param windowMs The configured recovery window duration, in milliseconds.
 * @returns `true` iff the document is still recoverable at `nowMs`.
 */
export function isWithinRecoveryWindow(
  deletedAtMs: number,
  nowMs: number,
  windowMs: number,
): boolean {
  return nowMs >= deletedAtMs && nowMs <= recoveryDeadlineMs(deletedAtMs, windowMs);
}

/**
 * Whether a soft-deleted document's recovery window has elapsed at `nowMs`, so it
 * is eligible for permanent purge (Req 28.7).
 *
 * This is the strict complement of {@link isWithinRecoveryWindow} for a
 * physically-ordered clock: the window has expired iff `nowMs` is strictly past
 * the deadline.
 *
 * @param deletedAtMs The soft-delete instant, in epoch milliseconds.
 * @param nowMs The current instant, in epoch milliseconds.
 * @param windowMs The configured recovery window duration, in milliseconds.
 * @returns `true` iff the recovery window has closed at `nowMs`.
 */
export function isRecoveryWindowExpired(
  deletedAtMs: number,
  nowMs: number,
  windowMs: number,
): boolean {
  return nowMs > recoveryDeadlineMs(deletedAtMs, windowMs);
}
