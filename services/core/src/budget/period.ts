/**
 * Period-window helpers for the Budget_Manager (Req 22.3-22.5).
 *
 * A budget's cap and alert threshold are measured over a calendar period — a
 * UTC day or a UTC month — after which the consumed spend resets (Req 22.3,
 * 22.4, 22.5). These pure helpers compute the half-open `[startMs, endMs)`
 * {@link PeriodWindow} that contains a given instant, so the manager counts only
 * the spend in the *current* period toward the cap without ever deleting the
 * retained history (Req 22.6). A "reset" is therefore not a delete — it is
 * simply the window advancing past the old spend.
 */

import type { BudgetPeriod, PeriodWindow } from './types.js';

/**
 * Compute the half-open `[startMs, endMs)` window of the budget period (UTC)
 * that contains the instant `nowMs`.
 *
 *  - `day` — `[00:00:00, next 00:00:00)` of the UTC calendar day.
 *  - `month` — `[day 1 00:00:00, first day of next month 00:00:00)` UTC.
 *
 * Spend whose `createdAt` falls inside the returned window counts toward the
 * current period's cap; once the clock passes `endMs`, the next call returns the
 * following window and consumed spend resets to zero (Req 22.3-22.5).
 *
 * @param period The reset cadence of the budget.
 * @param nowMs The instant to find the containing period for (epoch ms).
 * @returns The period window containing `nowMs`.
 */
export function periodWindow(period: BudgetPeriod, nowMs: number): PeriodWindow {
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (period === 'day') {
    const day = now.getUTCDate();
    const startMs = Date.UTC(year, month, day);
    const endMs = Date.UTC(year, month, day + 1);
    return { startMs, endMs };
  }
  // month
  const startMs = Date.UTC(year, month, 1);
  const endMs = Date.UTC(year, month + 1, 1);
  return { startMs, endMs };
}

/**
 * Compute the half-open `[startMs, endMs)` window of the UTC calendar day that
 * contains `nowMs`, used to count per-model messages "for the remainder of the
 * day" (Req 22.5).
 *
 * @param nowMs The instant to find the containing UTC day for (epoch ms).
 * @returns The day window containing `nowMs`.
 */
export function dayWindow(nowMs: number): PeriodWindow {
  return periodWindow('day', nowMs);
}
