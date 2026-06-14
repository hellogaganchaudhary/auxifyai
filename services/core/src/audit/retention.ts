/**
 * Audit-log retention policy (Req 37.4).
 *
 * Audit records are retained for **7 years**. This module encodes that window
 * as a single source of truth and provides pure helpers to compute the
 * retention cutoff and classify a record as within- or past-retention.
 *
 * Important separation of duties: the Audit_Service is *append + query only* and
 * never deletes (Req 37.3 — immutability). Actual removal of expired records is
 * governed by the Compliance_Manager (Req 38), which runs with the privileges
 * needed to purge past-retention data (e.g. dropping an expired partition or a
 * privileged purge that bypasses the append-only trigger). The Audit_Service
 * therefore only *represents* the retention window and can *identify* expired
 * records (a read), leaving the deletion itself to the Compliance_Manager.
 */

/** The audit retention window in whole years (Req 37.4). */
export const AUDIT_RETENTION_YEARS = 7 as const;

/**
 * The declarative retention policy for the audit log. Exposed as a value so
 * later components (Compliance_Manager, Report_Generator) can read the same
 * window rather than hard-coding `7` independently.
 */
export interface AuditRetentionPolicy {
  /** The retention window in whole years. */
  readonly years: number;
}

/** The canonical audit retention policy (Req 37.4). */
export const AUDIT_RETENTION_POLICY: AuditRetentionPolicy = {
  years: AUDIT_RETENTION_YEARS,
};

/**
 * Compute the retention cutoff: the instant exactly {@link AUDIT_RETENTION_YEARS}
 * years before `now`. A record whose timestamp is **strictly before** this
 * cutoff has aged out of the retention window and is eligible for purge by the
 * Compliance_Manager.
 *
 * @param now The reference instant. Defaults to the current time.
 * @returns The cutoff as an ISO-8601 string.
 */
export function auditRetentionCutoff(now: Date = new Date()): string {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - AUDIT_RETENTION_YEARS);
  return cutoff.toISOString();
}

/**
 * Whether a record with the given timestamp is still within the retention
 * window at `now` (i.e. at or after the cutoff). Records exactly on the cutoff
 * are considered retained.
 *
 * @param timestamp The record's timestamp (ISO-8601).
 * @param now The reference instant. Defaults to the current time.
 */
export function isWithinAuditRetention(timestamp: string, now: Date = new Date()): boolean {
  const cutoffMs = new Date(auditRetentionCutoff(now)).getTime();
  return new Date(timestamp).getTime() >= cutoffMs;
}
