/**
 * Scheduler and workflow-execution domain types and injectable ports
 * (Req 17.1, 17.2, 17.3, 17.4, 17.5).
 *
 * This module is the contract layer for two cooperating-but-decoupled
 * components:
 *
 *  - the **Scheduler** (Req 17.1), which registers a {@link Workflow}'s
 *    {@link Cadence} and, reading an injectable {@link SchedulerClock}, fires a
 *    run through an injectable {@link RunTrigger} when the schedule is due; and
 *  - the **workflow executor** (Req 17.2-17.5), which runs a workflow's ordered
 *    {@link WorkflowStep}s through an injectable {@link WorkflowStepExecutor} —
 *    passing each step's output to the steps that reference it, delivering
 *    delivery-action outputs, halting and recording the failed step on a
 *    failure — and records the run outcome and resource usage through an
 *    injectable {@link WorkflowAnalyticsRecorder}.
 *
 * Both components depend only on the narrow ports defined here, never on the
 * Agent_Runtime's in-flux concrete types (task 15.5). Production wiring
 * satisfies {@link RunTrigger} / {@link WorkflowStepExecutor} with the
 * Agent_Runtime; tests satisfy them with the recording fakes in `./fakes.js`.
 * The {@link Workflow} / {@link WorkflowStep} shapes mirror the design's data
 * model exactly.
 *
 * The injectable clock is surfaced as {@link SchedulerClock} /
 * {@link systemSchedulerClock} (rather than `Clock` / `systemClock`) so the
 * names never collide with the Model_Router's identically-purposed clock in the
 * shared `@auxify/core` barrel — the same disambiguation the Cache_Manager made
 * with `CacheClock`.
 */

import type { PlatformError } from '@auxify/types';

// --- Schedule model (Req 17.1) -------------------------------------------

/** The kind of {@link Cadence} a {@link Workflow} is scheduled on (Req 17.1). */
export type CadenceKind = 'cron' | 'interval' | 'one_shot';

/** All {@link CadenceKind} values, for iteration, validation, and test generators. */
export const CADENCE_KINDS: readonly CadenceKind[] = ['cron', 'interval', 'one_shot'] as const;

/**
 * A cron schedule (Req 17.1): a standard 5-field cron expression
 * (`minute hour day-of-month month day-of-week`) evaluated in UTC.
 *
 * The next due time is the start of the next clock-minute (at or after the
 * reference time, exclusive of the reference minute itself) whose UTC fields all
 * match the expression. Supported per field: `*`, a single value, a comma list
 * (`1,15`), an inclusive range (`9-17`), and a step (`*&#47;15`, `0-30/10`). The
 * expression is parsed once at registration; a malformed expression is rejected
 * with {@link InvalidCadenceError}.
 */
export interface CronCadence {
  /** Discriminant. */
  kind: 'cron';
  /** A 5-field cron expression evaluated in UTC. */
  expression: string;
}

/**
 * A fixed-interval schedule (Req 17.1): fire every {@link intervalMs}
 * milliseconds, on the grid anchored at {@link anchorMs}.
 *
 * The next due time after a reference time `t` is the earliest
 * `anchorMs + k * intervalMs` (integer `k >= 0`) that is strictly greater than
 * `t`, so a schedule never re-fires for the same slot. When {@link anchorMs} is
 * omitted the Scheduler anchors it to the registration time.
 */
export interface IntervalCadence {
  /** Discriminant. */
  kind: 'interval';
  /** The fire interval in milliseconds; must be a positive, finite number. */
  intervalMs: number;
  /** The epoch-ms grid anchor; defaults to the registration time when omitted. */
  anchorMs?: number;
}

/**
 * A one-shot schedule (Req 17.1): fire exactly once at {@link runAtMs}.
 *
 * It is due once the clock reaches {@link runAtMs}; after it has fired it is
 * never due again (its next-due computation returns `null`).
 */
export interface OneShotCadence {
  /** Discriminant. */
  kind: 'one_shot';
  /** The epoch-ms instant the workflow should fire at. */
  runAtMs: number;
}

/** The schedule a {@link Workflow} runs on (Req 17.1). */
export type Cadence = CronCadence | IntervalCadence | OneShotCadence;

// --- Workflow model (Req 17.2, 17.3) -------------------------------------

/**
 * The kind of a {@link WorkflowStep} (Req 17.2, 17.3).
 *
 *  - `agent` — an Agent_Runtime step that produces an output (Req 17.2);
 *  - `delivery` — a delivery action that delivers an upstream step's output
 *    through a configured channel (Req 17.3).
 */
export type WorkflowStepType = 'agent' | 'delivery';

/** All {@link WorkflowStepType} values, for iteration, validation, and tests. */
export const WORKFLOW_STEP_TYPES: readonly WorkflowStepType[] = ['agent', 'delivery'] as const;

/**
 * A single step in a {@link Workflow} (design `WorkflowStep`, Req 17.2, 17.3).
 *
 * Steps run in non-decreasing {@link order}; {@link inputRefs} names the ids of
 * the earlier steps whose outputs this step consumes (the dependency edges the
 * executor resolves and passes forward, Req 17.2). {@link config} is the
 * step-kind-specific, executor-interpreted payload (e.g. the agent run input,
 * or the delivery channel descriptor) and is intentionally opaque here so the
 * executor port owns its shape.
 */
export interface WorkflowStep {
  /** The step's stable unique id (referenced by later steps' {@link inputRefs}). */
  id: string;
  /** The execution order key; steps run by non-decreasing order (Req 17.2). */
  order: number;
  /** Whether this step runs an agent or performs a delivery action (Req 17.2, 17.3). */
  type: WorkflowStepType;
  /** The ids of earlier steps whose outputs feed this step (Req 17.2). */
  inputRefs: string[];
  /** The step-kind-specific, executor-interpreted configuration. */
  config: unknown;
}

/**
 * A schedulable, executable workflow (design `Workflow`, Req 17.1, 17.2).
 *
 * Carries its tenant scope (`organizationId` / `projectId`, Req 1.2) and its
 * ordered {@link steps}; {@link cadence} is present when the workflow is
 * registered with the Scheduler (Req 17.1) and absent for a workflow that is
 * only ever run on demand.
 */
export interface Workflow {
  /** The workflow's stable unique id. */
  id: string;
  /** The Organization that owns the workflow (Req 1.2). */
  organizationId: string;
  /** The Project the workflow is scoped to (Req 1.2). */
  projectId: string;
  /** The ordered steps to execute (Req 17.2). */
  steps: WorkflowStep[];
  /** The schedule the Scheduler fires the workflow on, when scheduled (Req 17.1). */
  cadence?: Cadence;
}

// --- Injectable clock (Req 17.1) -----------------------------------------

/**
 * A clock the Scheduler reads to decide whether a registered schedule is due.
 *
 * Injectable so unit tests can drive scheduling deterministically without real
 * timers: a hand-advanced clock fixes "now" and moves it across a schedule's
 * due boundary. Named {@link SchedulerClock} (not `Clock`) so it never collides
 * with the Model_Router's clock in the shared `@auxify/core` barrel.
 */
export interface SchedulerClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link SchedulerClock}, backed by the global `Date.now`. */
export const systemSchedulerClock: SchedulerClock = { now: () => Date.now() };

// --- Run-trigger port (Req 17.1) -----------------------------------------

/**
 * The context the Scheduler hands the {@link RunTrigger} when a schedule fires.
 *
 * It carries the workflow to run plus the firing metadata — the schedule's
 * computed due time ({@link scheduledForMs}) and the wall-clock time the
 * Scheduler actually fired ({@link firedAtMs}) — so the trigger can correlate
 * and record the run.
 */
export interface TriggerContext {
  /** The workflow whose schedule fired. */
  workflow: Workflow;
  /** The schedule's computed due time that this firing satisfies (epoch ms). */
  scheduledForMs: number;
  /** The clock time at which the Scheduler fired the trigger (epoch ms). */
  firedAtMs: number;
}

/**
 * The narrow port the Scheduler fires a workflow run through (Req 17.1).
 *
 * This is the seam that decouples the Scheduler from the Agent_Runtime
 * (task 15.5): the Scheduler only knows it must "trigger the workflow at the
 * defined cadence" and delegates the actual run to whatever satisfies this
 * port. Production wiring satisfies it with an adapter over the Agent_Runtime /
 * workflow executor; tests satisfy it with a recording fake that captures every
 * firing so "fires when due, and not before" is directly assertable.
 */
export interface RunTrigger {
  /**
   * Fire a workflow run for a due schedule.
   *
   * @param context The workflow plus the firing metadata.
   */
  trigger(context: TriggerContext): Promise<void>;
}

// --- Workflow step-executor port (Req 17.2, 17.3) ------------------------

/**
 * The inputs a {@link WorkflowStepExecutor} receives for a single step.
 *
 * {@link inputs} maps each referenced upstream step id (from
 * {@link WorkflowStep.inputRefs}) to that step's recorded output, so a step
 * sees exactly the outputs of the steps it depends on (Req 17.2). The executor
 * interprets {@link WorkflowStep.config} according to {@link WorkflowStep.type}.
 */
export interface StepExecutionContext {
  /** The workflow the step belongs to (carries tenant scope). */
  workflow: Workflow;
  /** The step to execute. */
  step: WorkflowStep;
  /** The outputs of the steps this step references, keyed by step id (Req 17.2). */
  inputs: Record<string, unknown>;
}

/**
 * The successful outcome of a single {@link WorkflowStep} (Req 17.2, 17.3).
 *
 * {@link output} is the value passed forward to steps that reference this one
 * (Req 17.2). {@link usage} optionally reports the step's resource consumption,
 * which the executor aggregates into the run's totals for Analytics (Req 17.5).
 */
export interface StepResult {
  /** The step's produced output, forwarded to referencing steps (Req 17.2). */
  output: unknown;
  /** Optional per-step resource usage, aggregated for Analytics (Req 17.5). */
  usage?: WorkflowResourceUsage;
  /**
   * For a delivery step, the channel the output was delivered through
   * (Req 17.3). Informational; recorded on the step outcome for observability.
   */
  deliveredVia?: string;
}

/**
 * The narrow port the workflow executor runs each step through (Req 17.2, 17.3).
 *
 * This is the seam that decouples workflow execution from the Agent_Runtime
 * (task 15.5) and the delivery channels (Req 17.3): the executor only sequences
 * steps and routes outputs, delegating the actual agent run / delivery to
 * whatever satisfies this port. An implementation **rejects** (throws) to signal
 * a step failure; the executor converts that into a recorded failed step and
 * halts the workflow (Req 17.4). Production wiring satisfies it with the
 * Agent_Runtime plus the delivery adapters; tests satisfy it with a recording
 * fake.
 */
export interface WorkflowStepExecutor {
  /**
   * Execute a single workflow step and return its result, or reject to signal a
   * failure that must halt the workflow (Req 17.4).
   *
   * @param context The step, its workflow, and its resolved upstream inputs.
   * @returns The step's output and optional usage.
   */
  execute(context: StepExecutionContext): Promise<StepResult>;
}

// --- Run-recording model (Req 17.4, 17.5) --------------------------------

/**
 * The aggregatable resource usage of a step or a whole workflow run (Req 17.5).
 *
 * Fields are additive so the executor can sum per-step usage into the run total
 * that the Analytics_Service records on completion (Req 17.5). All fields are
 * optional and default to `0` when summing, so a step that reports no usage
 * simply contributes nothing.
 */
export interface WorkflowResourceUsage {
  /** Total tokens consumed (input + output). */
  tokens?: number;
  /** Total cost in the platform's billing unit. */
  cost?: number;
  /** Total wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Total number of tool invocations. */
  toolCalls?: number;
}

/** The terminal status of a workflow run (Req 17.4, 17.5). */
export type WorkflowRunStatus = 'completed' | 'failed';

/** The terminal status of a single step within a run (Req 17.2, 17.4). */
export type WorkflowStepStatus = 'succeeded' | 'failed';

/**
 * The recorded outcome of a single executed step (Req 17.2, 17.3, 17.4).
 *
 * Every step the executor *attempts* yields one of these, in execution order.
 * A `succeeded` outcome carries the step's {@link output}; a `failed` outcome
 * carries the projected {@link error} that halted the workflow (Req 17.4). A
 * step ordered after a failure is never attempted and therefore never appears.
 */
export interface WorkflowStepOutcome {
  /** The id of the step this outcome records. */
  stepId: string;
  /** The step's execution order key. */
  order: number;
  /** The step kind that ran. */
  type: WorkflowStepType;
  /** Whether the step succeeded or failed (Req 17.4). */
  status: WorkflowStepStatus;
  /** The step's output when it succeeded; `undefined` for a failed step. */
  output?: unknown;
  /** The channel a successful delivery step delivered through (Req 17.3). */
  deliveredVia?: string;
  /** The step's resource usage, when reported (Req 17.5). */
  usage?: WorkflowResourceUsage;
  /** The projected error for a failed step (Req 17.4); absent when succeeded. */
  error?: PlatformError;
}

/**
 * The structured result of a whole workflow run (Req 17.2, 17.4, 17.5).
 *
 * {@link steps} holds the per-step outcomes in execution order. On a failure,
 * {@link status} is `failed`, {@link failedStepId} names the step that failed,
 * and the last entry in {@link steps} is that step's `failed` outcome with no
 * outcome ordered after it (Req 17.4). {@link usage} is the sum of the executed
 * steps' usage, which the executor hands the Analytics_Service on completion
 * (Req 17.5).
 */
export interface WorkflowRunResult {
  /** The workflow that ran. */
  workflowId: string;
  /** The Organization that owns the run (Req 1.2). */
  organizationId: string;
  /** The Project the run is scoped to (Req 1.2). */
  projectId: string;
  /** The terminal status of the run (Req 17.4, 17.5). */
  status: WorkflowRunStatus;
  /** The per-step outcomes, in execution order (Req 17.2, 17.4). */
  steps: WorkflowStepOutcome[];
  /** The id of the failed step, when {@link status} is `failed` (Req 17.4). */
  failedStepId?: string;
  /** The aggregated resource usage across executed steps (Req 17.5). */
  usage: WorkflowResourceUsage;
}

/**
 * The Analytics record the workflow executor emits on run completion (Req 17.5).
 *
 * Mirrors the design's "record the workflow run outcome and resource usage in
 * Analytics" — the run's terminal {@link status} and the aggregated
 * {@link usage}, carrying the tenant scope so Analytics can attribute it.
 */
export interface WorkflowRunRecord {
  /** The workflow that ran. */
  workflowId: string;
  /** The Organization that owns the run (Req 1.2). */
  organizationId: string;
  /** The Project the run is scoped to (Req 1.2). */
  projectId: string;
  /** The terminal status of the run (Req 17.5). */
  status: WorkflowRunStatus;
  /** The id of the failed step, when the run failed (Req 17.4). */
  failedStepId?: string;
  /** The number of steps that were attempted. */
  stepsAttempted: number;
  /** The aggregated resource usage across executed steps (Req 17.5). */
  usage: WorkflowResourceUsage;
}

/**
 * The narrow port the workflow executor records a completed run through
 * (Req 17.5).
 *
 * This is the seam to the Analytics_Service: the executor only knows it must
 * "record the workflow run outcome and resource usage" and delegates the
 * persistence to whatever satisfies this port. Tests satisfy it with a
 * recording fake so the recorded outcome/usage is directly assertable.
 */
export interface WorkflowAnalyticsRecorder {
  /**
   * Record a completed (succeeded or failed) workflow run's outcome and usage.
   *
   * @param record The run outcome and aggregated resource usage.
   */
  record(record: WorkflowRunRecord): Promise<void>;
}
