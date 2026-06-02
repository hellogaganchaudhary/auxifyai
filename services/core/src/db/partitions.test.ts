/**
 * Unit + property tests for the usage_records monthly-partition helpers
 * (Req 44.7). The property test asserts the rendered range is always a correct
 * half-open month window for any timestamp, complementing the example-based
 * cases below.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  createUpcomingUsageRecordsPartitionsSql,
  createUsageRecordsPartitionSql,
  monthRange,
  usageRecordsPartitionName,
} from './partitions.js';

describe('usageRecordsPartitionName', () => {
  it('zero-pads the month and uses the YYYY_MM convention', () => {
    expect(usageRecordsPartitionName(2026, 6)).toBe('usage_records_p2026_06');
    expect(usageRecordsPartitionName(2026, 12)).toBe('usage_records_p2026_12');
  });
});

describe('monthRange', () => {
  it('computes a half-open [first-of-month, first-of-next-month) window', () => {
    const range = monthRange(new Date(Date.UTC(2026, 5, 17))); // 2026-06-17
    expect(range).toEqual({ start: '2026-06-01', end: '2026-07-01' });
  });

  it('rolls the year over for December', () => {
    const range = monthRange(new Date(Date.UTC(2026, 11, 31))); // 2026-12-31
    expect(range).toEqual({ start: '2026-12-01', end: '2027-01-01' });
  });
});

describe('createUsageRecordsPartitionSql', () => {
  it('renders idempotent PARTITION OF DDL with the correct bounds', () => {
    const sql = createUsageRecordsPartitionSql(new Date(Date.UTC(2026, 5, 1)));
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS usage_records_p2026_06');
    expect(sql).toContain('PARTITION OF usage_records');
    expect(sql).toContain("FOR VALUES FROM ('2026-06-01') TO ('2026-07-01')");
  });
});

describe('createUpcomingUsageRecordsPartitionsSql', () => {
  it('renders consecutive monthly partitions including a year rollover', () => {
    const sql = createUpcomingUsageRecordsPartitionsSql(
      new Date(Date.UTC(2026, 10, 1)), // Nov 2026
      3,
    );
    expect(sql).toContain('usage_records_p2026_11');
    expect(sql).toContain('usage_records_p2026_12');
    expect(sql).toContain('usage_records_p2027_01');
  });

  it('rejects a count below 1', () => {
    expect(() => createUpcomingUsageRecordsPartitionsSql(new Date(), 0)).toThrow(
      RangeError,
    );
  });
});

describe('monthRange — property', () => {
  it('always yields a valid half-open month window for any timestamp', () => {
    fc.assert(
      fc.property(
        // Any epoch millisecond in a broad, realistic range.
        fc.integer({ min: 0, max: Date.UTC(2100, 0, 1) }),
        (ms) => {
          const date = new Date(ms);
          const { start, end } = monthRange(date);
          const startDate = new Date(`${start}T00:00:00.000Z`);
          const endDate = new Date(`${end}T00:00:00.000Z`);

          // start is the first of the containing month.
          expect(startDate.getUTCDate()).toBe(1);
          expect(startDate.getUTCFullYear()).toBe(date.getUTCFullYear());
          expect(startDate.getUTCMonth()).toBe(date.getUTCMonth());

          // end is strictly after start and is the first of the next month.
          expect(endDate.getTime()).toBeGreaterThan(startDate.getTime());
          expect(endDate.getUTCDate()).toBe(1);

          // The window contains the original instant.
          expect(date.getTime()).toBeGreaterThanOrEqual(startDate.getTime());
          expect(date.getTime()).toBeLessThan(endDate.getTime());

          // The partition name matches the start month.
          const name = usageRecordsPartitionName(
            startDate.getUTCFullYear(),
            startDate.getUTCMonth() + 1,
          );
          expect(createUsageRecordsPartitionSql(date)).toContain(name);
        },
      ),
      { numRuns: 200 },
    );
  });
});
