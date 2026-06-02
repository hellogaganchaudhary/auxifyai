/**
 * The workflow executor — runs an ordered, multi-step workflow (Req 17.2-17.5).
 *
 * {@link WorkflowExecutor.run} executes a {@link Workflow}'s steps in their
 * defined order, resolving each step's {@link WorkflowStep.inputRefs} to the
 * recorded outputs of the steps it references and passing them forward
 * (Req 17.2). Each step runs through the injectable {@link WorkflowStepExecutor}
 * port; a delivery-action step's output is delivered through the configured
 * channel by that same port (Req 17.3). If a step fails (the port rejects), the
 * executor **halts**: no step ordered after it runs, and the failed step plus
 * its projected error are recorded on the result (Req 17.4). On completion —
 * success or failure — the run's outcome and aggregated resource usage are
 * recorded through the injectable {@link WorkflowAnalyticsRecorder} (Req 17.5).
 *
 * Both effectful collaborators are injectable ports, so the executor's
 * sequencing/branching/aggregation logic is fully unit-testable with the
 * recording fakes in `./fakes.js`, without the Agent_Runtime (task 15.5), real
 * delivery channels, or a real Analytics backend.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import { InvalidWorkflowError } from './errors.js';
import { validateWorkflowGraph } from './workflow-graph.js';
import {
  type Workflow,
  type WorkflowAnalyticsRecorder,
  type WorkflowResourceUsage,
  type WorkflowRunResult,
  type WorkflowStep,
  type WorkflowStepExecutor,
  type WorkflowStepOutcome,
} from './types.js';

/** Construction options for {@link WorkflowExecutor}. */
export interface WorkflowExecutorOptions {
  /** The port each step runs through (agent run / delivery, Req 17.2, 17.3). Required. */
  stepExecutor: WorkflowStepExecutor;
  /** Optional Analytics sink the completed run is recorded through (Req 17.5). */
  analytics?: WorkflowAnalyticsRecorder;
  /**
   * Correlation id factory for projecting a step failure into a
   * {@link PlatformError} (Req 17.4, 46.7). Defaults to a per-run constant.
   */
  correlationId?: () => string;
}

/** The stable code a non-typed step failure is projected under (Req 17.4). */
export const WORKFLOW_STEP_FAILED_CODE = 'WORKFLOW_STEP_FAILED' as const;

/** Add two optional usage records field-by-field, treating absent fields as 0. */
function addUsage(
  total: WorkflowResourceUsage,
  step: WorkflowResourceUsage | undefined,
): WorkflowResourceUsage {
  if (step === undefined) {
    return total;
  }
  return {
    tokens: (total.tokens ?? 0) + (step.tokens ?? 0),
    cost: (total.cost ?? 0) + (step.cost ?? 0),
    durationMs: (total.durationMs ?? 0) + (step.durationMs ?? 0),
    toolCalls: (total.toolCalls ?? 0) + (step.toolCalls ?? 0),
  };
}

/**
 * Project an arbitrary thrown step failure into the platform-wide serializable
 * {@link PlatformError} (Req 17.4, 46.8).
 *
 * An error that already carries a `toPlatformError(correlationId)` projection
 * (every typed domain error does) is used verbatim; anything else becomes a
 * safe, secret-free `internal` error so an unexpected throw never leaks
 * internals (Req 34.7).
 */
function projectStepError(cause: unknown, stepId: string, correlationId: string): PlatformError {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'toPlatformError' in cause &&
    typeof (cause as { toPlatformError: unknown }).toPlatformError === 'function'
  ) {
    return (cause as { toPlatformError(id: string): PlatformError }).toPlatformError(correlationId);
  }
  const message = cause instanceof Error ? cause.message : 'Workflow step failed';
  return createPlatformError({
    category: 'internal',
    code: WORKFLOW_STEP_FAILED_CODE,
    message,
    correlationId,
    details: { stepId },
  });
}

/**
 * The workflow executor: ordered multi-step execution with output passing,
 * halt-on-failure, and Analytics recording (Req 17.2-17.5).
 */
export class WorkflowExecutor {
  private readonly stepExecutor: WorkflowStepExecutor;
  private readonly analytics: WorkflowAnalyticsRecorder | undefined;
  private readonly correlationId: () => string;

  constructor(options: WorkflowExecutorOptions) {
    this.stepExecutor = options.stepExecutor;
    this.analytics = options.analytics;
    this.correlationId = options.correlationId ?? ((): string => 'workflow-run');
  }

  /**
   * Execute a workflow end-to-end and return its structured result
   * (Req 17.2-17.5).
   *
   * Steps run in non-decreasing {@link WorkflowStep.order}; each step receives
   * the recorded outputs of the steps it references (Req 17.2). The first
   * failing step halts the run — no later step executes — and is recorded with
   * its projected error (Req 17.4). The completed run's outcome and aggregated
   * usage are recorded through the Analytics port (Req 17.5).
   *
   * @param workflow The workflow to execute.
   * @returns The per-step outcomes, terminal status, and aggregated usage.
   * @throws {InvalidWorkflowError} If the workflow's step graph is ill-formed.
   */
  async run(workflow: Workflow): Promise<WorkflowRunResult> {
    const ordered = validateWorkflowGraph(workflow);
    const correlationId = this.correlationId();

    const outputs = new Map<string, unknown>();
    const outcomes: WorkflowStepOutcome[] = [];
    let usage: WorkflowResourceUsage = {};
    let failedStepId: string | undefined;

    for (const step of ordered) {
      const inputs = this.resolveInputs(workflow, step, outputs);
      try {
        const result = await this.stepExecutor.execute({ workflow, step, inputs });
        outputs.set(step.id, result.output);
        usage = addUsage(usage, result.usage);
        const outcome: WorkflowStepOutcome = {
          stepId: step.id,
          order: step.order,
          type: step.type,
          status: 'succeeded',
          output: result.output,
        };
        if (result.deliveredVia !== undefined) {
          outcome.deliveredVia = result.deliveredVia;
        }
        if (result.usage !== undefined) {
          outcome.usage = result.usage;
        }
        outcomes.push(outcome);
      } catch (cause) {
        // A step failure halts the workflow and is recorded (Req 17.4).
        failedStepId = step.id;
        outcomes.push({
          stepId: step.id,
          order: step.order,
          type: step.type,
          status: 'failed',
          error: projectStepError(cause, step.id, correlationId),
        });
        break;
      }
    }

    const status = failedStepId === undefined ? 'completed' : 'failed';
    const result: WorkflowRunResult = {
      workflowId: workflow.id,
      organizationId: workflow.organizationId,
      projectId: workflow.projectId,
      status,
      steps: outcomes,
      usage,
    };
    if (failedStepId !== undefined) {
      result.failedStepId = failedStepId;
    }

    await this.recordAnalytics(result);
    return result;
  }

  /**
   * Resolve a step's referenced inputs to the recorded outputs of the steps it
   * depends on (Req 17.2). {@link validateWorkflowGraph} has already guaranteed
   * every referenced id is an earlier, executed step, so each lookup is present.
   */
  private resolveInputs(
    workflow: Workflow,
    step: WorkflowStep,
    outputs: Map<string, unknown>,
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const ref of step.inputRefs) {
      if (!outputs.has(ref)) {
        // Defensive: the graph validator forbids this, but never trust silently.
        throw new InvalidWorkflowError(
          workflow.id,
          `step "${step.id}" references "${ref}" which has no recorded output`,
          [step.id, ref],
        );
      }
      inputs[ref] = outputs.get(ref);
    }
    return inputs;
  }

  /** Record the completed run's outcome and aggregated usage in Analytics (Req 17.5). */
  private async recordAnalytics(result: WorkflowRunResult): Promise<void> {
    if (this.analytics === undefined) {
      return;
    }
    await this.analytics.record({
      workflowId: result.workflowId,
      organizationId: result.organizationId,
      projectId: result.projectId,
      status: result.status,
      ...(result.failedStepId !== undefined ? { failedStepId: result.failedStepId } : {}),
      stepsAttempted: result.steps.length,
      usage: result.usage,
    });
  }
}
