/**
 * The pure retention-evaluation core (Req 38.2, 38.3, 28.6, Property 53).
 *
 * Retention enforcement "removes nothing early and nothing past-retention
 * remains" (Property 53): a governed resource becomes due for its configured
 * disposition exactly when its retention period has elapsed — never before — and
 * an active legal hold exempts a resource from deletion regardless of age. This
 * module isolates that boundary arithmetic and the verification decision as
 * small, total, side-effect-free functions so the Compliance_Manager (and its
 * property tests) can reason about retention timing deterministically against an
 * injectable {@link import('./types.js').ComplianceClock}.
 *
 * The retention window is measured from the resource's creation instant: a
 * resource created at `createdAtMs` with a finite `retentionDays` is past
 * retention for every instant `now` with `now >= createdAtMs + retentionDays`.
 * An "unlimited" policy (`retentionDays === null`) has no deadline, so the
 * resource is never due.
 */

import {
  type ComplianceDecision,
  type ComplianceDenialCode,
  type ComplianceOperation,
} from './types.js';

/** The number of milliseconds in one day. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The number of milliseconds in 30 days (the offboarding erasure deadline, Req 38.4). */
export const OFFBOARDING_ERASURE_WINDOW_MS = 30 * MS_PER_DAY;

/** The number of milliseconds in 72 hours (the GDPR erasure deadline, Req 38.5). */
export const GDPR_ERASURE_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * The instant (epoch ms) at which a resource becomes due for its retention
 * action — i.e. its retention period elapses — or `null` for an "unlimited"
 * policy that has no deadline.
 *
 * Named {@link retentionDueAtMs} (not `retentionDeadlineMs`) so it never
 * collides with the Backup_Service's recovery-window `retentionDeadlineMs` at
 * the shared `@auxify/core` barrel; the two compute different deadlines.
 *
 * @param createdAtMs The resource's creation instant, in epoch milliseconds.
 * @param retentionDays The finite retention period in days, or `null` for unlimited.
 * @returns The epoch-millisecond deadline, or `null` when retention is unlimited.
 */
export function retentionDueAtMs(
  createdAtMs: number,
  retentionDays: number | null,
): number | null {
  if (retentionDays === null) {
    return null;
  }
  return createdAtMs + retentionDays * MS_PER_DAY;
}

/**
 * Whether a resource is past its retention period at `nowMs` (Req 38.2, 38.3,
 * Property 53).
 *
 * A resource with an unlimited policy (`retentionDays === null`) is never past
 * retention. Otherwise it is past retention iff `nowMs` is at or beyond the
 * computed deadline — the boundary is inclusive of the deadline instant, so a
 * resource becomes due exactly when (not strictly after) its period elapses, and
 * is never removed early.
 *
 * @param createdAtMs The resource's creation instant, in epoch milliseconds.
 * @param nowMs The evaluation instant, in epoch milliseconds.
 * @param retentionDays The finite retention period in days, or `null` for unlimited.
 * @returns `true` iff the resource's retention period has elapsed at `nowMs`.
 */
export function isPastRetention(
  createdAtMs: number,
  nowMs: number,
  retentionDays: number | null,
): boolean {
  const deadline = retentionDueAtMs(createdAtMs, retentionDays);
  if (deadline === null) {
    return false;
  }
  return nowMs >= deadline;
}

/**
 * Decide the fail-closed verdict for an operation purely from its verification
 * preconditions (Req 38.6) — pure and side-effect-free.
 *
 * An operation is allowed iff **both** its retention and privacy compliance have
 * been explicitly verified (`true`). If neither precondition is supplied at all,
 * the gate fails closed with `verification_unavailable` rather than assuming
 * compliance; if retention is unverified it blocks with `retention_unverifiable`;
 * if privacy is unverified it blocks with `privacy_unverifiable`. Exposed
 * separately from the manager so the decision logic is directly testable without
 * the audit side effect.
 *
 * @param op The operation whose compliance is being verified.
 * @returns The structured {@link ComplianceDecision}.
 */
export function decideCompliance(op: ComplianceOperation): ComplianceDecision {
  const retentionSupplied = op.retentionVerified !== undefined;
  const privacySupplied = op.privacyVerified !== undefined;

  // Neither precondition supplied at all: fail closed, do not assume compliance.
  if (!retentionSupplied && !privacySupplied) {
    return block(
      'verification_unavailable',
      'no retention or privacy verification was supplied; failing closed',
    );
  }
  if (op.retentionVerified !== true) {
    return block(
      'retention_unverifiable',
      'operation retention compliance could not be verified; blocked',
    );
  }
  if (op.privacyVerified !== true) {
    return block(
      'privacy_unverifiable',
      'operation privacy compliance could not be verified; blocked',
    );
  }
  return {
    allowed: true,
    reason: 'operation allowed: retention and privacy compliance verified',
  };
}

/** Build a blocked {@link ComplianceDecision}. */
function block(denialCode: ComplianceDenialCode, reason: string): ComplianceDecision {
  return { allowed: false, reason, denialCode };
}
