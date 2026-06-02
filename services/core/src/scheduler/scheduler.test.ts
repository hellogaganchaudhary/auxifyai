/**
 * Unit tests for the Scheduler (Req 17.1).
 *
 * Drives the Scheduler with a hand-advanced clock and a recording trigger so
 * scheduling is deterministic and timer-free. Covers: a schedule fires when due
 * and NOT before, for each cadence kind (interval / one-shot / cron); a
 * one-shot fires exactly once; an interval re-arms for its next slot; duplicate
 * registration and malformed-cadence rejection; and unschedule.
 */

import { describe, expect, it } from 'vitest';

import { DuplicateScheduleError, InvalidCadenceError } from './errors.js';
import { MutableSchedulerClock, RecordingRunTrigger } from './fakes.js';
import { Scheduler } from './scheduler.js';
import type { Workflow } from './types.js';

const HOUR = 60 * 60 * 1000;

function workflow(id: string): Workflow {
  return { id, organizationId: 'org-1', projectId: 'proj-1', steps: [] };
}

function build(startMs = 0): {
  scheduler: Scheduler;
  clock: MutableSchedulerClock;
  trigger: RecordingRunTrigger;
} {
  const clock = new MutableSchedulerClock(startMs);
  const trigger = new RecordingRunTrigger();
  const scheduler = new Scheduler({ trigger, clock });
  return { scheduler, clock, trigger };
}

describe('Scheduler interval cadence (Req 17.1)', () => {
  it('does not fire before the first due time, fires when due, and re-arms', async () => {
    const { scheduler, clock, trigger } = build(0);
    await scheduler.schedule(workflow('wf-1'), { kind: 'interval', intervalMs: HOUR });

    // Before the first interval elapses: not due.
    clock.set(HOUR - 1);
    expect(await scheduler.tick()).toEqual([]);
    expect(trigger.firings).toHaveLength(0);

    // At the first interval boundary: fires once.
    clock.set(HOUR);
    expect(await scheduler.tick()).toEqual(['wf-1']);
    expect(trigger.firings).toHaveLength(1);
    expect(trigger.firings[0]?.scheduledForMs).toBe(HOUR);
    expect(trigger.firings[0]?.firedAtMs).toBe(HOUR);

    // Immediately after firing, the slot does not re-fire.
    expect(await scheduler.tick()).toEqual([]);
    expect(trigger.firings).toHaveLength(1);

    // The next slot fires after another interval.
    clock.set(2 * HOUR);
    expect(await scheduler.tick()).toEqual(['wf-1']);
    expect(trigger.firings).toHaveLength(2);
    expect(trigger.firings[1]?.scheduledForMs).toBe(2 * HOUR);
  });

  it('fires at most once per tick even when several slots have elapsed', async () => {
    const { scheduler, clock, trigger } = build(0);
    await scheduler.schedule(workflow('wf-1'), { kind: 'interval', intervalMs: HOUR });

    // Jump far ahead: three slots have passed, but a single tick fires once.
    clock.set(3 * HOUR + 5);
    expect(await scheduler.tick()).toEqual(['wf-1']);
    expect(trigger.firings).toHaveLength(1);
    expect(trigger.firings[0]?.scheduledForMs).toBe(HOUR);

    // The next slot is picked up on the following tick.
    expect(await scheduler.tick()).toEqual(['wf-1']);
    expect(trigger.firings[1]?.scheduledForMs).toBe(2 * HOUR);
  });
});

describe('Scheduler one-shot cadence (Req 17.1)', () => {
  it('fires exactly once at runAtMs and never again', async () => {
    const { scheduler, clock, trigger } = build(0);
    await scheduler.schedule(workflow('wf-1'), { kind: 'one_shot', runAtMs: 5_000 });

    // Before the instant: not due.
    clock.set(4_999);
    expect(await scheduler.tick()).toEqual([]);

    // At the instant: fires once.
    clock.set(5_000);
    expect(await scheduler.tick()).toEqual(['wf-1']);
    expect(trigger.firings).toHaveLength(1);
    expect(trigger.firings[0]?.scheduledForMs).toBe(5_000);

    // Retired thereafter, even far in the future.
    clock.set(1_000_000);
    expect(await scheduler.tick()).toEqual([]);
    expect(trigger.firings).toHaveLength(1);
    expect(scheduler.peek('wf-1')?.nextDueMs).toBeNull();
  });
});

describe('Scheduler cron cadence (Req 17.1)', () => {
  it('fires at the next matching minute and not before', async () => {
    const epoch = Date.UTC(2024, 0, 1, 0, 0, 0);
    const { scheduler, clock, trigger } = build(epoch);
    // Every day at 09:00 UTC.
    await scheduler.schedule(workflow('wf-1'), { kind: 'cron', expression: '0 9 * * *' });

    const at0900 = Date.UTC(2024, 0, 1, 9, 0, 0);
    // One minute before: not due.
    clock.set(at0900 - 60_000);
    expect(await scheduler.tick()).toEqual([]);

    // At 09:00: fires.
    clock.set(at0900);
    expect(await scheduler.tick()).toEqual(['wf-1']);
    expect(trigger.firings[0]?.scheduledForMs).toBe(at0900);

    // Re-armed for the next day.
    expect(scheduler.peek('wf-1')?.nextDueMs).toBe(Date.UTC(2024, 0, 2, 9, 0, 0));
  });
});

describe('Scheduler registration (Req 17.1)', () => {
  it('rejects scheduling the same workflow twice', async () => {
    const { scheduler } = build(0);
    await scheduler.schedule(workflow('wf-1'), { kind: 'interval', intervalMs: HOUR });
    await expect(
      scheduler.schedule(workflow('wf-1'), { kind: 'interval', intervalMs: HOUR }),
    ).rejects.toBeInstanceOf(DuplicateScheduleError);
  });

  it('rejects a malformed cadence at registration time', async () => {
    const { scheduler } = build(0);
    await expect(
      scheduler.schedule(workflow('wf-1'), { kind: 'cron', expression: 'bad' }),
    ).rejects.toBeInstanceOf(InvalidCadenceError);
    await expect(
      scheduler.schedule(workflow('wf-2'), { kind: 'interval', intervalMs: 0 }),
    ).rejects.toBeInstanceOf(InvalidCadenceError);
    // Neither failed registration left a schedule behind.
    expect(scheduler.size).toBe(0);
  });

  it('unschedule removes a registered schedule so it no longer fires', async () => {
    const { scheduler, clock, trigger } = build(0);
    await scheduler.schedule(workflow('wf-1'), { kind: 'one_shot', runAtMs: 1_000 });
    expect(scheduler.unschedule('wf-1')).toBe(true);
    expect(scheduler.unschedule('wf-1')).toBe(false);

    clock.set(1_000);
    expect(await scheduler.tick()).toEqual([]);
    expect(trigger.firings).toHaveLength(0);
  });

  it('fires multiple due schedules in one tick', async () => {
    const { scheduler, clock, trigger } = build(0);
    await scheduler.schedule(workflow('wf-1'), { kind: 'one_shot', runAtMs: 1_000 });
    await scheduler.schedule(workflow('wf-2'), { kind: 'one_shot', runAtMs: 1_000 });

    clock.set(1_000);
    const fired = await scheduler.tick();
    expect(fired.sort()).toEqual(['wf-1', 'wf-2']);
    expect(trigger.firedWorkflowIds.sort()).toEqual(['wf-1', 'wf-2']);
  });
});
