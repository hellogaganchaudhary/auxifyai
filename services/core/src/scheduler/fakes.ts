/**
 * Test fakes for the Scheduler and workflow executor (Req 17.1-17.5).
 *
 * The only things the Scheduler and workflow executor cannot do purely are
 * reading time, firing a run, executing a step, and recording analytics — so
 * those are exactly what these fakes stand in for. Everything here is
 * deterministic and in-memory; nothing touches a real timer, the Agent_Runtime,
 * a delivery channel, or an Analytics backend.
 *
 *  - {@link MutableSchedulerClock} — a hand-advanced {@link SchedulerClock} so a
 *    test can fix "now" and move it across a schedule's due boundary to assert
 *    "fires when due, and not before" (Req 17.1).
 *  - {@link RecordingRunTrigger} — a {@link RunTrigger} that records every firing
 *    so a test can assert exactly which workflows fired, when, and for which due
 *    slot (Req 17.1).
 *  - {@link RecordingStepExecutor} — a {@link WorkflowStepExecutor} that records
 *    every step it runs (in order, with its resolved inputs) and returns seeded
 *    outputs/usage or fails a designated step on cue, so ordered execution,
 *    output passing, and halt-on-failure are directly assertable (Req 17.2-17.4).
 *  - {@link RecordingAnalyticsRecorder} — a {@link WorkflowAnalyticsRecorder}
 *    that captures the recorded run outcome and usage (Req 17.5).
 *
 * Tests import these fakes directly from `./fakes.js`, never from a package
 * barrel.
 */

import type {
  RunTrigger,
  SchedulerClock,
  StepExecutionContext,
  StepResult,
  TriggerContext,
  WorkflowAnalyticsRecorder,
  WorkflowResourceUsage,
  WorkflowRunRecord,
  WorkflowStepExecutor,
} from './types.js';

/**
 * A hand-advanced {@link SchedulerClock} for deterministic scheduling tests.
 *
 * Construct it at a fixed epoch-ms origin (default `0`); read "now" with
 * {@link MutableSchedulerClock.now}; move time forward with
 * {@link MutableSchedulerClock.advance} (milliseconds) or set it absolutely with
 * {@link MutableSchedulerClock.set}.
 */
export class MutableSchedulerClock implements SchedulerClock {
  private current: number;

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.current += ms;
  }

  /** Set the clock to an absolute epoch-ms time. */
  set(ms: number): void {
    this.current = ms;
  }
}

/**
 * A {@link RunTrigger} that records every firing instead of running anything.
 *
 * Each {@link RecordingRunTrigger.trigger} call appends the full
 * {@link TriggerContext} to {@link firings}, so a test can assert which
 * workflows fired, the due slot each firing satisfied, and the clock time it
 * fired at — the basis for "fires when due, and not before" (Req 17.1).
 */
export class RecordingRunTrigger implements RunTrigger {
  /** Every firing, in order. */
  readonly firings: TriggerContext[] = [];

  async trigger(context: TriggerContext): Promise<void> {
    this.firings.push(context);
  }

  /** The ids of the workflows fired, in order (duplicates kept). */
  get firedWorkflowIds(): string[] {
    return this.firings.map((f) => f.workflow.id);
  }
}

/** A seeded behaviour for a single step the {@link RecordingStepExecutor} runs. */
export interface SeededStep {
  /** The output to return (defaults to a deterministic stub keyed by step id). */
  output?: unknown;
  /** Optional per-step usage to report (Req 17.5). */
  usage?: WorkflowResourceUsage;
  /** For a delivery step, the channel to report delivery through (Req 17.3). */
  deliveredVia?: string;
  /** When set, the step fails with this error, halting the workflow (Req 17.4). */
  failWith?: Error;
}

/** A record of a single step the {@link RecordingStepExecutor} was asked to run. */
export interface RecordedStepExecution {
  /** The id of the step that ran. */
  stepId: string;
  /** The step's execution order key. */
  order: number;
  /** The resolved inputs the step received (Req 17.2). */
  inputs: Record<string, unknown>;
}

/**
 * A {@link WorkflowStepExecutor} that records every step it runs and returns
 * seeded outputs, or fails a designated step on cue.
 *
 * It records each {@link StepExecutionContext} (step id, order, and the resolved
 * inputs it received) in {@link executions}, in execution order, so a test can
 * assert steps ran in dependency order and each saw exactly its referenced
 * upstream outputs (Req 17.2). Seed a step with {@link seed} (or in the
 * constructor) to control its output / usage / delivery channel, or to make it
 * fail so the executor must halt (Req 17.4). An unseeded step returns a
 * deterministic stub output keyed by its id.
 */
export class RecordingStepExecutor implements WorkflowStepExecutor {
  /** Every step run, in order, with the inputs it received. */
  readonly executions: RecordedStepExecution[] = [];

  private readonly seeds = new Map<string, SeededStep>();

  constructor(seed: Record<string, SeededStep> = {}) {
    for (const [stepId, seeded] of Object.entries(seed)) {
      this.seeds.set(stepId, seeded);
    }
  }

  /** Seed (or replace) the behaviour for the step with id `stepId`. */
  seed(stepId: string, seeded: SeededStep): this {
    this.seeds.set(stepId, seeded);
    return this;
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    const { step } = context;
    this.executions.push({
      stepId: step.id,
      order: step.order,
      inputs: { ...context.inputs },
    });

    const seeded = this.seeds.get(step.id);
    if (seeded?.failWith !== undefined) {
      throw seeded.failWith;
    }

    const result: StepResult = {
      output: seeded?.output ?? `output:${step.id}`,
    };
    if (seeded?.usage !== undefined) {
      result.usage = seeded.usage;
    }
    // A delivery step reports the channel it delivered through (Req 17.3).
    if (seeded?.deliveredVia !== undefined) {
      result.deliveredVia = seeded.deliveredVia;
    } else if (step.type === 'delivery') {
      result.deliveredVia = 'fake-channel';
    }
    return result;
  }

  /** The ids of the steps that ran, in execution order. */
  get executedStepIds(): string[] {
    return this.executions.map((e) => e.stepId);
  }
}

/**
 * A {@link WorkflowAnalyticsRecorder} that captures every recorded run outcome
 * and usage so a test can assert the Analytics recording (Req 17.5).
 */
export class RecordingAnalyticsRecorder implements WorkflowAnalyticsRecorder {
  /** Every recorded run, in order. */
  readonly records: WorkflowRunRecord[] = [];

  async record(record: WorkflowRunRecord): Promise<void> {
    this.records.push(record);
  }

  /** The most recently recorded run, or `undefined` if none. */
  get last(): WorkflowRunRecord | undefined {
    return this.records[this.records.length - 1];
  }
}
