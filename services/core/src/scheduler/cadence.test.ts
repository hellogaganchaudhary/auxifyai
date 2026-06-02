/**
 * Unit tests for the pure next-due-time computation (Req 17.1).
 *
 * Covers next-due computation for each schedule kind the Scheduler supports —
 * interval, one-shot, and cron — including the inclusive (seed) vs. exclusive
 * (advance) boundary semantics, and the malformed-cadence rejections.
 */

import { describe, expect, it } from 'vitest';

import { compileCadence, parseCron, nextCronTime } from './cadence.js';
import { InvalidCadenceError } from './errors.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('compileCadence — interval (Req 17.1)', () => {
  it('computes the next grid point strictly after the reference time', () => {
    const c = compileCadence({ kind: 'interval', intervalMs: HOUR, anchorMs: 0 }, 0);
    // Exclusive: at an exact grid point, advance to the next one.
    expect(c.nextDueAfter(0)).toBe(HOUR);
    expect(c.nextDueAfter(HOUR)).toBe(2 * HOUR);
    // Mid-interval rounds up to the next grid point.
    expect(c.nextDueAfter(HOUR + 1)).toBe(2 * HOUR);
    expect(c.nextDueAfter(2 * HOUR - 1)).toBe(2 * HOUR);
  });

  it('seeds strictly-after: an interval first fires one interval after the anchor', () => {
    const c = compileCadence({ kind: 'interval', intervalMs: HOUR, anchorMs: 0 }, 0);
    // The anchor is the period start, not itself a fire point.
    expect(c.firstDueAtOrAfter(0)).toBe(HOUR);
    expect(c.firstDueAtOrAfter(1)).toBe(HOUR);
    expect(c.firstDueAtOrAfter(HOUR)).toBe(2 * HOUR);
  });

  it('anchors an interval without anchorMs to the registration time', () => {
    const registeredAt = 5_000;
    const c = compileCadence({ kind: 'interval', intervalMs: 1_000 }, registeredAt);
    // First fire is one interval after registration.
    expect(c.firstDueAtOrAfter(registeredAt)).toBe(registeredAt + 1_000);
    expect(c.nextDueAfter(registeredAt)).toBe(registeredAt + 1_000);
  });

  it('handles a reference time before the anchor', () => {
    const c = compileCadence({ kind: 'interval', intervalMs: HOUR, anchorMs: 10 * HOUR }, 0);
    expect(c.nextDueAfter(0)).toBe(10 * HOUR);
    expect(c.firstDueAtOrAfter(0)).toBe(10 * HOUR);
  });

  it('rejects a non-positive or non-finite interval', () => {
    expect(() => compileCadence({ kind: 'interval', intervalMs: 0 }, 0)).toThrow(
      InvalidCadenceError,
    );
    expect(() => compileCadence({ kind: 'interval', intervalMs: -5 }, 0)).toThrow(
      InvalidCadenceError,
    );
    expect(() =>
      compileCadence({ kind: 'interval', intervalMs: Number.POSITIVE_INFINITY }, 0),
    ).toThrow(InvalidCadenceError);
  });
});

describe('compileCadence — one_shot (Req 17.1)', () => {
  it('is due once at runAtMs and never again', () => {
    const runAtMs = 1_000;
    const c = compileCadence({ kind: 'one_shot', runAtMs }, 0);

    // Seeded inclusively: due at exactly runAtMs and at any earlier reference.
    expect(c.firstDueAtOrAfter(0)).toBe(runAtMs);
    expect(c.firstDueAtOrAfter(runAtMs)).toBe(runAtMs);
    // Once the firing slot has passed, never due again.
    expect(c.nextDueAfter(runAtMs)).toBeNull();
    expect(c.firstDueAtOrAfter(runAtMs + 1)).toBeNull();
  });

  it('rejects a non-finite runAtMs', () => {
    expect(() => compileCadence({ kind: 'one_shot', runAtMs: Number.NaN }, 0)).toThrow(
      InvalidCadenceError,
    );
  });
});

describe('parseCron / nextCronTime (Req 17.1)', () => {
  // 2024-01-01T00:00:00Z
  const epoch = Date.UTC(2024, 0, 1, 0, 0, 0);

  it('every minute matches the next minute boundary strictly after the reference', () => {
    const cron = parseCron('* * * * *');
    expect(nextCronTime(cron, epoch)).toBe(epoch + MIN);
    // Mid-minute rounds up to the next minute.
    expect(nextCronTime(cron, epoch + 30_000)).toBe(epoch + MIN);
  });

  it('matches a specific minute-of-hour', () => {
    const cron = parseCron('30 * * * *'); // every :30
    const at0030 = Date.UTC(2024, 0, 1, 0, 30, 0);
    expect(nextCronTime(cron, epoch)).toBe(at0030);
    // From :30 exactly, the next is the following hour's :30.
    expect(nextCronTime(cron, at0030)).toBe(Date.UTC(2024, 0, 1, 1, 30, 0));
  });

  it('matches a daily time (0 9 * * *)', () => {
    const cron = parseCron('0 9 * * *');
    expect(nextCronTime(cron, epoch)).toBe(Date.UTC(2024, 0, 1, 9, 0, 0));
    const at0900 = Date.UTC(2024, 0, 1, 9, 0, 0);
    expect(nextCronTime(cron, at0900)).toBe(Date.UTC(2024, 0, 2, 9, 0, 0));
  });

  it('supports lists, ranges, and steps', () => {
    expect([...parseCron('0,30 * * * *').minutes]).toEqual([0, 30]);
    expect([...parseCron('9-12 * * * *').minutes]).toEqual([9, 10, 11, 12]);
    expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
  });

  it('matches a day-of-week constraint', () => {
    // Monday (1) at 00:00. 2024-01-01 is a Monday.
    const cron = parseCron('0 0 * * 1');
    expect(nextCronTime(cron, epoch)).toBe(Date.UTC(2024, 0, 8, 0, 0, 0));
  });

  it('compiled cron seeds inclusively at an exact matching minute', () => {
    const c = compileCadence({ kind: 'cron', expression: '0 9 * * *' }, epoch);
    const at0900 = Date.UTC(2024, 0, 1, 9, 0, 0);
    expect(c.firstDueAtOrAfter(at0900)).toBe(at0900);
    expect(c.nextDueAfter(at0900)).toBe(Date.UTC(2024, 0, 2, 9, 0, 0));
  });

  it('returns null for an unsatisfiable expression (Feb 30)', () => {
    const cron = parseCron('0 0 30 2 *');
    expect(nextCronTime(cron, epoch)).toBeNull();
  });

  it('rejects a malformed cron expression', () => {
    expect(() => parseCron('* * * *')).toThrow(InvalidCadenceError); // 4 fields
    expect(() => parseCron('60 * * * *')).toThrow(InvalidCadenceError); // minute out of range
    expect(() => parseCron('* 25 * * *')).toThrow(InvalidCadenceError); // hour out of range
    expect(() => parseCron('*/0 * * * *')).toThrow(InvalidCadenceError); // zero step
    expect(() => compileCadence({ kind: 'cron', expression: 'nonsense' }, 0)).toThrow(
      InvalidCadenceError,
    );
  });
});
