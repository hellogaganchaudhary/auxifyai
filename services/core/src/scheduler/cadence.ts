/**
 * Pure next-due-time computation for each schedule kind (Req 17.1).
 *
 * The Scheduler decides whether a registered schedule is due by comparing the
 * injected clock against the schedule's *next due time*. That computation is
 * deliberately a pure function of the {@link Cadence} and a reference epoch-ms
 * time, with no I/O and no timers, so it is exhaustively unit-testable and the
 * Scheduler itself stays a thin policy layer over it:
 *
 *  - **interval** — the next grid point `anchor + k * intervalMs` strictly
 *    after the reference time (Req 17.1);
 *  - **one_shot** — the fixed instant, or `null` once it is in the past
 *    relative to the reference (so it fires exactly once, Req 17.1);
 *  - **cron** — the start of the next UTC minute (strictly after the reference
 *    minute) whose fields all match a 5-field cron expression (Req 17.1).
 *
 * A malformed cadence is rejected at parse time with
 * {@link InvalidCadenceError}; callers parse once at registration and reuse the
 * compiled form.
 */

import { InvalidCadenceError } from './errors.js';
import type { Cadence, CronCadence } from './types.js';

/** Milliseconds in one minute — the cron resolution. */
const MINUTE_MS = 60_000;

/** The inclusive bounds of each of the five cron fields, in field order. */
const CRON_FIELD_BOUNDS: readonly { min: number; max: number }[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
];

/**
 * A parsed, validated cron expression: for each of the five fields, the set of
 * matching values. Built once by {@link parseCron} and reused for every
 * next-due computation.
 */
export interface ParsedCron {
  /** Matching minute values (0-59). */
  minutes: ReadonlySet<number>;
  /** Matching hour values (0-23). */
  hours: ReadonlySet<number>;
  /** Matching day-of-month values (1-31). */
  daysOfMonth: ReadonlySet<number>;
  /** Matching month values (1-12). */
  months: ReadonlySet<number>;
  /** Matching day-of-week values (0-6, 0 = Sunday). */
  daysOfWeek: ReadonlySet<number>;
}

/**
 * Parse a single cron field (`*`, value, list, range, or step) into the set of
 * values it matches within `[min, max]`.
 *
 * Supports `*`, `a`, `a,b,c`, `a-b`, `*&#47;n`, and `a-b/n`. Throws if the field
 * is malformed or names a value outside the field's bounds.
 */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part.length === 0) {
      throw new Error(`empty term in field "${field}"`);
    }
    const [rangePart, stepPart] = part.split('/') as [string, string | undefined];
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`invalid step "${stepPart}" in field "${field}"`);
      }
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [loStr, hiStr] = rangePart.split('-') as [string, string | undefined];
      lo = Number(loStr);
      hi = Number(hiStr);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new Error(`invalid range "${rangePart}" in field "${field}"`);
      }
    } else {
      lo = Number(rangePart);
      hi = lo;
      if (!Number.isInteger(lo)) {
        throw new Error(`invalid value "${rangePart}" in field "${field}"`);
      }
    }

    if (lo < min || hi > max || lo > hi) {
      throw new Error(`value out of bounds [${min}, ${max}] in field "${field}"`);
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
  }
  return values;
}

/**
 * Parse and validate a 5-field cron expression (`minute hour day-of-month month
 * day-of-week`, evaluated in UTC) into a reusable {@link ParsedCron} (Req 17.1).
 *
 * @param expression The 5-field cron expression.
 * @returns The parsed per-field value sets.
 * @throws {InvalidCadenceError} If the expression is not exactly five
 *   whitespace-separated fields or any field is malformed/out of bounds.
 */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCadenceError(
      'cron',
      `expected 5 space-separated fields, received ${fields.length}`,
    );
  }
  try {
    const sets = fields.map((field, i) => {
      const bounds = CRON_FIELD_BOUNDS[i];
      // `bounds` is always defined: `fields.length === 5` matches CRON_FIELD_BOUNDS.
      return parseCronField(field, bounds!.min, bounds!.max);
    });
    return {
      minutes: sets[0]!,
      hours: sets[1]!,
      daysOfMonth: sets[2]!,
      months: sets[3]!,
      daysOfWeek: sets[4]!,
    };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'malformed expression';
    throw new InvalidCadenceError('cron', reason);
  }
}

/** Does the UTC instant `ms` match every field of `cron`? */
function cronMatches(cron: ParsedCron, ms: number): boolean {
  const d = new Date(ms);
  return (
    cron.minutes.has(d.getUTCMinutes()) &&
    cron.hours.has(d.getUTCHours()) &&
    cron.daysOfMonth.has(d.getUTCDate()) &&
    cron.months.has(d.getUTCMonth() + 1) &&
    cron.daysOfWeek.has(d.getUTCDay())
  );
}

/**
 * The next UTC minute strictly after `afterMs` whose fields all match `cron`,
 * or `null` if none occurs within the search horizon (Req 17.1).
 *
 * The search advances minute-by-minute from the minute after `afterMs`, bounded
 * to roughly four years so an unsatisfiable expression (e.g. Feb 30) terminates
 * with `null` rather than looping forever.
 */
export function nextCronTime(cron: ParsedCron, afterMs: number): number | null {
  // Start at the top of the minute strictly after the reference minute.
  let candidate = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const horizon = candidate + 366 * 4 * 24 * 60 * MINUTE_MS;
  for (; candidate <= horizon; candidate += MINUTE_MS) {
    if (cronMatches(cron, candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * A compiled cadence: a validated cadence paired with its pure next-due
 * functions. The Scheduler compiles each registered cadence once (rejecting a
 * malformed one immediately), seeds the first due time with
 * {@link CompiledCadence.firstDueAtOrAfter}, and advances past each firing with
 * {@link CompiledCadence.nextDueAfter} (Req 17.1).
 *
 * The two methods differ only in boundary inclusiveness, which keeps one-shot
 * "fires exactly once" exact: seeding is *inclusive* so a schedule whose due
 * instant equals the seed time still fires, while advancing is *exclusive* so a
 * schedule never re-fires the slot it just fired.
 */
export interface CompiledCadence {
  /** The cadence kind, retained for diagnostics. */
  readonly kind: Cadence['kind'];
  /**
   * The earliest due time at or after `fromMs` (inclusive), or `null` when the
   * schedule will never fire (a one-shot whose instant is already past, or an
   * unsatisfiable cron). Used to seed a schedule's first due time.
   *
   * @param fromMs The reference epoch-ms time to search from, inclusive.
   */
  firstDueAtOrAfter(fromMs: number): number | null;
  /**
   * The earliest due time strictly after `afterMs` (exclusive), or `null` when
   * the schedule will never fire again. Used to advance past a firing.
   *
   * @param afterMs The reference epoch-ms time to search after, exclusive.
   */
  nextDueAfter(afterMs: number): number | null;
}

/**
 * Compile and validate a {@link Cadence} into a reusable {@link CompiledCadence}
 * (Req 17.1).
 *
 * `registrationMs` anchors an {@link IntervalCadence} whose `anchorMs` is
 * omitted, so an interval registered at time T fires at T + interval, T +
 * 2·interval, …. A malformed cadence is rejected here with
 * {@link InvalidCadenceError} so the failure surfaces at registration, never at
 * fire time.
 *
 * @param cadence The schedule to compile.
 * @param registrationMs The epoch-ms registration time (interval anchor default).
 * @returns The compiled, validated cadence.
 * @throws {InvalidCadenceError} If the cadence is malformed.
 */
export function compileCadence(cadence: Cadence, registrationMs: number): CompiledCadence {
  switch (cadence.kind) {
    case 'interval': {
      if (!Number.isFinite(cadence.intervalMs) || cadence.intervalMs <= 0) {
        throw new InvalidCadenceError('interval', `intervalMs must be positive and finite`);
      }
      const anchor = cadence.anchorMs ?? registrationMs;
      if (!Number.isFinite(anchor)) {
        throw new InvalidCadenceError('interval', `anchorMs must be finite`);
      }
      const intervalMs = cadence.intervalMs;
      // Earliest grid point anchor + k*interval strictly after `bound`, for
      // integer k >= 0. An interval is purely periodic — the grid origin (the
      // anchor / registration instant) is the period *start*, not itself a fire
      // point — so an interval registered at T first fires at T + interval, and
      // both seeding and advancing are strictly-after.
      const gridAfter = (bound: number): number => {
        const elapsed = bound - anchor;
        if (elapsed < 0) return anchor;
        const k = Math.floor(elapsed / intervalMs) + 1;
        return anchor + k * intervalMs;
      };
      return {
        kind: 'interval',
        firstDueAtOrAfter: (fromMs: number): number => gridAfter(fromMs),
        nextDueAfter: (afterMs: number): number => gridAfter(afterMs),
      };
    }
    case 'one_shot': {
      if (!Number.isFinite(cadence.runAtMs)) {
        throw new InvalidCadenceError('one_shot', `runAtMs must be finite`);
      }
      const runAtMs = cadence.runAtMs;
      return {
        kind: 'one_shot',
        firstDueAtOrAfter: (fromMs: number): number | null => (runAtMs >= fromMs ? runAtMs : null),
        nextDueAfter: (afterMs: number): number | null => (runAtMs > afterMs ? runAtMs : null),
      };
    }
    case 'cron': {
      const parsed = parseCron((cadence as CronCadence).expression);
      return {
        kind: 'cron',
        // A cron instant is always at second 0 of a minute; searching from one
        // millisecond before `fromMs` makes the boundary inclusive of a matching
        // minute that starts exactly at `fromMs`.
        firstDueAtOrAfter: (fromMs: number): number | null => nextCronTime(parsed, fromMs - 1),
        nextDueAfter: (afterMs: number): number | null => nextCronTime(parsed, afterMs),
      };
    }
    default: {
      // Exhaustiveness: a new CadenceKind must be handled above.
      const exhaustive: never = cadence;
      throw new InvalidCadenceError(
        (exhaustive as Cadence).kind as Cadence['kind'],
        'unsupported cadence kind',
      );
    }
  }
}
