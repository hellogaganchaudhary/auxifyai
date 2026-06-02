/**
 * Unit tests for the WorkflowExecutor (Req 17.2-17.5).
 *
 * Covers: a multi-step workflow runs its steps in dependency order; each step's
 * output is passed to the steps that reference it (Req 17.2); a delivery step
 * reports its channel (Req 17.3); a failing step halts the workflow with no
 * later step running and the failed step + error recorded (Req 17.4); and the
 * run outcome + aggregated resource usage are recorded in Analytics (Req 17.5).
 * Also covers ill-formed-graph rejection.
 */

import { describe, expect, it } from 'vitest';

import { InvalidWorkflowError } from './errors.js';
import {
  RecordingAnalyticsRecorder,
  RecordingStepExecutor,
  type SeededStep,
} from './fakes.js';
import { WorkflowExecutor } from './workflow-executor.js';
import type { Workflow, WorkflowStep } from './types.js';

function step(id: string, order: number, inputRefs: string[] = [], type: WorkflowStep['type'] = 'agent'): WorkflowStep {
  return { id, order, type, inputRefs, config: {} };
}

function workflow(steps: WorkflowStep[]): Workflow {
  return { id: 'wf-1', organizationId: 'org-1', projectId: 'proj-1', steps };
}

function buildExecutor(seed: Record<string, SeededStep> = {}): {
  executor: WorkflowExecutor;
  stepExecutor: RecordingStepExecutor;
  analytics: RecordingAnalyticsRecorder;
} {
  const stepExecutor = new RecordingStepExecutor(seed);
  const analytics = new RecordingAnalyticsRecorder();
  const executor = new WorkflowExecutor({ stepExecutor, analytics });
  return { executor, stepExecutor, analytics };
}

describe('WorkflowExecutor ordered execution and output passing (Req 17.2)', () => {
  it('runs steps in defined order regardless of array order', async () => {
    const { executor, stepExecutor } = buildExecutor();
    // Provided out of order; should run by `order`.
    const wf = workflow([step('c', 3), step('a', 1), step('b', 2)]);

    const result = await executor.run(wf);

    expect(result.status).toBe('completed');
    expect(stepExecutor.executedStepIds).toEqual(['a', 'b', 'c']);
    expect(result.steps.map((s) => s.stepId)).toEqual(['a', 'b', 'c']);
    expect(result.steps.every((s) => s.status === 'succeeded')).toBe(true);
  });

  it("passes each step's output to the steps that reference it", async () => {
    const { executor, stepExecutor } = buildExecutor({
      a: { output: 'A-out' },
      b: { output: 'B-out' },
    });
    // c references a and b; b references a.
    const wf = workflow([
      step('a', 1),
      step('b', 2, ['a']),
      step('c', 3, ['a', 'b']),
    ]);

    await executor.run(wf);

    const byId = Object.fromEntries(stepExecutor.executions.map((e) => [e.stepId, e.inputs]));
    expect(byId['a']).toEqual({});
    expect(byId['b']).toEqual({ a: 'A-out' });
    expect(byId['c']).toEqual({ a: 'A-out', b: 'B-out' });
  });
});

describe('WorkflowExecutor delivery action (Req 17.3)', () => {
  it('records the channel a delivery step delivered through', async () => {
    const { executor } = buildExecutor({
      deliver: { deliveredVia: 'email:reports@auxify.test' },
    });
    const wf = workflow([
      step('agent', 1),
      step('deliver', 2, ['agent'], 'delivery'),
    ]);

    const result = await executor.run(wf);

    const deliveryOutcome = result.steps.find((s) => s.stepId === 'deliver');
    expect(deliveryOutcome?.deliveredVia).toBe('email:reports@auxify.test');
  });
});

describe('WorkflowExecutor halt on failure (Req 17.4)', () => {
  it('halts at the first failing step; no later step runs; failed step and error recorded', async () => {
    const { executor, stepExecutor } = buildExecutor({
      b: { failWith: new Error('step b boom') },
    });
    const wf = workflow([step('a', 1), step('b', 2, ['a']), step('c', 3, ['b'])]);

    const result = await executor.run(wf);

    expect(result.status).toBe('failed');
    expect(result.failedStepId).toBe('b');
    // c never ran.
    expect(stepExecutor.executedStepIds).toEqual(['a', 'b']);
    expect(result.steps.map((s) => s.stepId)).toEqual(['a', 'b']);

    const failed = result.steps[result.steps.length - 1];
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.message).toBe('step b boom');
    expect(failed?.error?.code).toBeDefined();
  });

  it('projects a typed error via its toPlatformError when a step throws one', async () => {
    const typed = new InvalidWorkflowError('inner', 'boom', ['x']);
    const { executor } = buildExecutor({ a: { failWith: typed } });
    const wf = workflow([step('a', 1)]);

    const result = await executor.run(wf);
    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error?.code).toBe('SCHEDULER_INVALID_WORKFLOW');
  });
});

describe('WorkflowExecutor analytics recording (Req 17.5)', () => {
  it('records the run outcome and aggregated resource usage on completion', async () => {
    const { executor, analytics } = buildExecutor({
      a: { usage: { tokens: 100, cost: 0.5, durationMs: 1_000, toolCalls: 1 } },
      b: { usage: { tokens: 50, cost: 0.25, durationMs: 500, toolCalls: 2 } },
    });
    const wf = workflow([step('a', 1), step('b', 2, ['a'])]);

    const result = await executor.run(wf);

    expect(result.usage).toEqual({ tokens: 150, cost: 0.75, durationMs: 1_500, toolCalls: 3 });
    expect(analytics.records).toHaveLength(1);
    expect(analytics.last).toMatchObject({
      workflowId: 'wf-1',
      organizationId: 'org-1',
      projectId: 'proj-1',
      status: 'completed',
      stepsAttempted: 2,
      usage: { tokens: 150, cost: 0.75, durationMs: 1_500, toolCalls: 3 },
    });
  });

  it('records a failed run with the failed step id and partial usage', async () => {
    const { executor, analytics } = buildExecutor({
      a: { usage: { tokens: 100 } },
      b: { failWith: new Error('boom') },
    });
    const wf = workflow([step('a', 1), step('b', 2, ['a'])]);

    await executor.run(wf);

    expect(analytics.last).toMatchObject({
      status: 'failed',
      failedStepId: 'b',
      stepsAttempted: 2,
      usage: { tokens: 100 },
    });
  });
});

describe('WorkflowExecutor graph validation (Req 17.2)', () => {
  it('rejects a forward reference', async () => {
    const { executor } = buildExecutor();
    // a references b, but b is ordered after a.
    const wf = workflow([step('a', 1, ['b']), step('b', 2)]);
    await expect(executor.run(wf)).rejects.toBeInstanceOf(InvalidWorkflowError);
  });

  it('rejects a duplicate step id', async () => {
    const { executor } = buildExecutor();
    const wf = workflow([step('a', 1), step('a', 2)]);
    await expect(executor.run(wf)).rejects.toBeInstanceOf(InvalidWorkflowError);
  });

  it('rejects an unknown reference', async () => {
    const { executor } = buildExecutor();
    const wf = workflow([step('a', 1, ['missing'])]);
    await expect(executor.run(wf)).rejects.toBeInstanceOf(InvalidWorkflowError);
  });
});
