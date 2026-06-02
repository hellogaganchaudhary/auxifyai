/**
 * The Scheduler — triggers workflow runs at their defined cadence (Req 17.1).
 *
 * {@link Scheduler.schedule} registers a {@link Workflow} with a {@link Cadence}
 * (cron / interval / one-shot), compiling and validating the cadence once and
 * seeding its first due time from the injectable {@link SchedulerClock}. Driving
 * the Scheduler is deliberately *pull-based* and timer-free:
 * {@link Scheduler.tick} reads the clock and, for every registered schedule
 * whose due time has been reached, fires the run exactly once through the
 * injectable {@link RunTrigger} and advances the schedule to its next due time.
 *
 * Modelling the clock and the run-trigger as injectable ports is what makes the
 * Scheduler unit-testable without real timers: a test advances a hand-controlled
 * clock and calls `tick()` to assert a schedule fires when due — and *not*
 * before. In production a thin timer loop (BullMQ / `setInterval`) calls `tick()`
 * periodically and the trigger is an adapter over the Agent_Runtime / workflow
 * executor (task 15.5); the Scheduler itself takes no dependency on those
 * in-flux concrete types.
 */

import { compileCadence, type CompiledCadence } from './cadence.js';
import { DuplicateScheduleError } from './errors.js';
import {
  systemSchedulerClock,
  type Cadence,
  type RunTrigger,
  type SchedulerClock,
  type Workflow,
} from './types.js';

/** Construction options for {@link Scheduler}. */
export interface SchedulerOptions {
  /** The port each due schedule fires its run through (Req 17.1). Required. */
  trigger: RunTrigger;
  /** Clock used to decide whether a schedule is due; defaults to {@link systemSchedulerClock}. */
  clock?: SchedulerClock;
}

/** A registered schedule: its workflow, compiled cadence, and pending due time. */
interface RegisteredSchedule {
  /** The workflow this schedule fires. */
  workflow: Workflow;
  /** The compiled, validated cadence. */
  compiled: CompiledCadence;
  /**
   * The next epoch-ms instant the schedule is due, or `null` once it will never
   * fire again (a fired one-shot, or an exhausted cron).
   */
  nextDueMs: number | null;
}

/** A snapshot of a registered schedule, returned for inspection/observability. */
export interface ScheduleSnapshot {
  /** The id of the scheduled workflow. */
  workflowId: string;
  /** The compiled cadence kind. */
  cadenceKind: Cadence['kind'];
  /** The next due time (epoch ms), or `null` if the schedule will never fire again. */
  nextDueMs: number | null;
}

/**
 * The Scheduler (design `Scheduler`): registers workflow schedules and fires due
 * runs through an injectable trigger (Req 17.1).
 */
export class Scheduler {
  private readonly trigger: RunTrigger;
  private readonly clock: SchedulerClock;
  /** Registered schedules keyed by workflow id. */
  private readonly schedules = new Map<string, RegisteredSchedule>();

  constructor(options: SchedulerOptions) {
    this.trigger = options.trigger;
    this.clock = options.clock ?? systemSchedulerClock;
  }

  /**
   * Register a workflow to fire at the given cadence (Req 17.1).
   *
   * Compiles and validates the cadence immediately (a malformed cadence rejects
   * here, never at fire time) and seeds the first due time from the current
   * clock so a schedule due exactly now fires on the next {@link tick}.
   *
   * @param workflow The workflow to run when the schedule fires.
   * @param cadence The schedule (cron / interval / one-shot).
   * @throws {InvalidCadenceError} If the cadence is malformed.
   * @throws {DuplicateScheduleError} If the workflow is already scheduled.
   */
  async schedule(workflow: Workflow, cadence: Cadence): Promise<void> {
    if (this.schedules.has(workflow.id)) {
      throw new DuplicateScheduleError(workflow.id);
    }
    const now = this.clock.now();
    const compiled = compileCadence(cadence, now);
    this.schedules.set(workflow.id, {
      workflow,
      compiled,
      nextDueMs: compiled.firstDueAtOrAfter(now),
    });
  }

  /**
   * Remove a registered schedule. Returns `true` if one was removed.
   *
   * @param workflowId The id of the scheduled workflow.
   */
  unschedule(workflowId: string): boolean {
    return this.schedules.delete(workflowId);
  }

  /** The number of currently registered schedules. */
  get size(): number {
    return this.schedules.size;
  }

  /**
   * Inspect a registered schedule's pending state, or `undefined` if absent.
   *
   * @param workflowId The id of the scheduled workflow.
   */
  peek(workflowId: string): ScheduleSnapshot | undefined {
    const entry = this.schedules.get(workflowId);
    if (entry === undefined) {
      return undefined;
    }
    return {
      workflowId,
      cadenceKind: entry.compiled.kind,
      nextDueMs: entry.nextDueMs,
    };
  }

  /**
   * Fire every schedule whose due time has been reached as of the current clock
   * (Req 17.1).
   *
   * For each due schedule this reads `now` once, fires the run through the
   * {@link RunTrigger} with the satisfied due time and the firing time, and then
   * advances the schedule to its next due time strictly after the one that just
   * fired — so a schedule fires exactly once per due slot and a one-shot is
   * retired after firing. A schedule whose due time is still in the future does
   * **not** fire (the "and not before" half of Req 17.1).
   *
   * A schedule can fire **at most once per `tick`**, even if several due slots
   * have elapsed since the last tick; the next slot is picked up on the
   * following tick. This keeps a long gap between ticks from issuing a burst of
   * catch-up runs.
   *
   * @returns The ids of the workflows fired on this tick, in registration order.
   */
  async tick(): Promise<string[]> {
    const now = this.clock.now();
    const fired: string[] = [];
    for (const [workflowId, entry] of this.schedules) {
      if (entry.nextDueMs === null || entry.nextDueMs > now) {
        continue;
      }
      const scheduledForMs = entry.nextDueMs;
      // Advance before awaiting the trigger so a re-entrant tick cannot double-fire
      // the same slot.
      entry.nextDueMs = entry.compiled.nextDueAfter(scheduledForMs);
      await this.trigger.trigger({
        workflow: entry.workflow,
        scheduledForMs,
        firedAtMs: now,
      });
      fired.push(workflowId);
    }
    return fired;
  }
}
