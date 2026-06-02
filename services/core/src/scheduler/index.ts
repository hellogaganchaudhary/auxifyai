/**
 * Scheduler and workflow execution (Req 17.1-17.5): the components behind
 * "Scheduled Agent Workflows".
 *
 * Two cooperating-but-decoupled pieces live here:
 *
 *  - **{@link Scheduler}** (Req 17.1) — registers a {@link Workflow}'s
 *    {@link Cadence} (cron / interval / one-shot), computes the next due time
 *    from an injectable {@link SchedulerClock} via the pure
 *    {@link compileCadence} core, and fires a run through an injectable
 *    {@link RunTrigger} when — and only when — a schedule is due. Driving it is
 *    pull-based and timer-free ({@link Scheduler.tick}), so production uses a
 *    thin timer loop while tests advance a hand-controlled clock.
 *  - **{@link WorkflowExecutor}** (Req 17.2-17.5) — runs a workflow's steps in
 *    their defined dependency order ({@link validateWorkflowGraph}), passing
 *    each step's output to the steps that reference it (Req 17.2), delivering a
 *    delivery-action step's output through the configured channel (Req 17.3),
 *    halting and recording the failed step + its error on a failure (Req 17.4),
 *    and recording the run's outcome and aggregated resource usage through an
 *    injectable {@link WorkflowAnalyticsRecorder} on completion (Req 17.5). Each
 *    step runs through the injectable {@link WorkflowStepExecutor} port.
 *
 * Neither piece depends on the Agent_Runtime's in-flux concrete types
 * (task 15.5): the Agent_Runtime, the delivery channels, and the
 * Analytics_Service are reached only through the narrow {@link RunTrigger},
 * {@link WorkflowStepExecutor}, and {@link WorkflowAnalyticsRecorder} ports that
 * production wiring satisfies. Typed errors ({@link InvalidCadenceError},
 * {@link InvalidWorkflowError}, {@link DuplicateScheduleError}) project into the
 * platform-wide serializable {@link import('@auxify/types').PlatformError}
 * (Req 46.8). In-memory fakes for unit tests live in `./fakes.js`.
 *
 * The injectable clock is exported as {@link SchedulerClock} /
 * {@link systemSchedulerClock} (rather than `Clock` / `systemClock`) so the
 * names never collide with the Model_Router's identically-purposed clock in the
 * shared `@auxify/core` barrel — the same disambiguation the Cache_Manager made
 * with `CacheClock`.
 */

export { Scheduler, type SchedulerOptions, type ScheduleSnapshot } from './scheduler.js';

export {
  WorkflowExecutor,
  type WorkflowExecutorOptions,
  WORKFLOW_STEP_FAILED_CODE,
} from './workflow-executor.js';

export {
  compileCadence,
  parseCron,
  nextCronTime,
  type CompiledCadence,
  type ParsedCron,
} from './cadence.js';

export { validateWorkflowGraph } from './workflow-graph.js';

export {
  InvalidCadenceError,
  InvalidWorkflowError,
  DuplicateScheduleError,
  INVALID_CADENCE_CODE,
  INVALID_WORKFLOW_CODE,
  DUPLICATE_SCHEDULE_CODE,
} from './errors.js';

export {
  systemSchedulerClock,
  CADENCE_KINDS,
  WORKFLOW_STEP_TYPES,
  type SchedulerClock,
  type Cadence,
  type CadenceKind,
  type CronCadence,
  type IntervalCadence,
  type OneShotCadence,
  type Workflow,
  type WorkflowStep,
  type WorkflowStepType,
  type RunTrigger,
  type TriggerContext,
  type WorkflowStepExecutor,
  type StepExecutionContext,
  type StepResult,
  type WorkflowAnalyticsRecorder,
  type WorkflowRunRecord,
  type WorkflowRunResult,
  type WorkflowRunStatus,
  type WorkflowStepOutcome,
  type WorkflowStepStatus,
  type WorkflowResourceUsage,
} from './types.js';
