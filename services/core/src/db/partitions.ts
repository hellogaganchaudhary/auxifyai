/**
 * Monthly-partition helpers for the `usage_records` table (Req 44.7).
 *
 * `usage_records` is declaratively `PARTITION BY RANGE (created_at)`. New monthly
 * partitions must exist before rows for that month are inserted. These helpers
 * render the same DDL as the SQL `create_usage_records_partition()` function so
 * a scheduled job, the migration CLI, or an ops script can pre-create upcoming
 * months from TypeScript. The output is idempotent (`CREATE TABLE IF NOT EXISTS`).
 */

/** The parent partitioned table. */
export const USAGE_RECORDS_TABLE = 'usage_records';

/** Zero-pad a number to two digits (e.g. `6` → `"06"`). */
function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Deterministic partition name for a given year/month, matching the SQL helper:
 * `usage_records_pYYYY_MM` (e.g. June 2026 → `usage_records_p2026_06`).
 */
export function usageRecordsPartitionName(year: number, month: number): string {
  return `${USAGE_RECORDS_TABLE}_p${year}_${pad2(month)}`;
}

/** A half-open month range `[start, end)` formatted as `YYYY-MM-DD` bounds. */
export interface MonthRange {
  /** Inclusive lower bound — first day of the month. */
  start: string;
  /** Exclusive upper bound — first day of the following month. */
  end: string;
}

/**
 * Compute the half-open date range covering the month that contains `date`
 * (UTC). The bounds are the values used in `FOR VALUES FROM (start) TO (end)`.
 */
export function monthRange(date: Date): MonthRange {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-based
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return { start: formatDate(start), end: formatDate(end) };
}

/** Format a Date as a `YYYY-MM-DD` string (UTC). */
function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  return `${y}-${m}-${d}`;
}

/**
 * Render idempotent DDL that creates the monthly partition containing `date`.
 *
 * Example output:
 * ```sql
 * CREATE TABLE IF NOT EXISTS usage_records_p2026_06
 *   PARTITION OF usage_records
 *   FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
 * ```
 */
export function createUsageRecordsPartitionSql(date: Date): string {
  const { start, end } = monthRange(date);
  const name = usageRecordsPartitionName(date.getUTCFullYear(), date.getUTCMonth() + 1);
  return (
    `CREATE TABLE IF NOT EXISTS ${name}\n` +
    `  PARTITION OF ${USAGE_RECORDS_TABLE}\n` +
    `  FOR VALUES FROM ('${start}') TO ('${end}');`
  );
}

/**
 * Render DDL creating partitions for `count` consecutive months starting at
 * `from` (inclusive). Useful for pre-provisioning upcoming months in a single
 * scheduled run. `count` must be >= 1.
 */
export function createUpcomingUsageRecordsPartitionsSql(
  from: Date,
  count: number,
): string {
  if (count < 1) {
    throw new RangeError(`count must be >= 1, received ${count}`);
  }
  const statements: string[] = [];
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  for (let i = 0; i < count; i += 1) {
    statements.push(createUsageRecordsPartitionSql(new Date(Date.UTC(year, month + i, 1))));
  }
  return statements.join('\n\n');
}
