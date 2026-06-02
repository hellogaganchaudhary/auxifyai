/**
 * Property-based test for **Property 38: Workflows execute in dependency order
 * and halt on failure** (design "Property 38"; Req 17.2, 17.4).
 *
 * **Validates: Requirements 17.2, 17.4**
 *
 * Property 38 (design): _For any_ workflow, steps execute in their defined order
 * with each step's output delivered to the steps that reference it; if a step
 * fails, no step ordered after it executes and the failed step and its error are
 * recorded. Requirement 17.2 makes the runtime execute steps "in their defined
 * order" and "pass each step's output to subsequent steps that reference it";
 * Requirement 17.4 makes a step failure halt the workflow and record the failed
 * step and error. Req 17.5 (run outcome + aggregated usage in Analytics) rides
 * along as the completion side effect the executor performs.
 *
 * This file drives the real {@link WorkflowExecutor} from `./workflow-executor.js`
 * (built in task 15.10) with the recording fakes from `./fakes.js` — a
 * {@link RecordingStepExecutor} seeded with a deterministic output and usage per
 * step (and a forced failure for one chosen step) and a
 * {@link RecordingAnalyticsRecorder}. It never re-uses the executor's own
 * `validateWorkflowGraph`: the expected execution order is computed by an
 * independent oracle ({@link expectedExecutionOrder}, the documented stable sort
 * by non-decreasing `order` with ties broken by original array position) and the
 * expected aggregated usage by an independent field-wise sum ({@link sumUsage}).
 *
 * Generated workflows are always *valid*: each step's `inputRefs` references only
 * distinct steps that the oracle orders strictly earlier, so the graph validator
 * never rejects and every reference resolves to a step that has already run. A
 * separate "which step fails (or none)" choice selects a position in the
 * execution order to fail, so both the completed and halted branches are covered.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { RecordingAnalyticsRecorder, RecordingStepExecutor, type SeededStep } from './fakes.js';
import {
  type Workflow,
  type WorkflowResourceUsage,
  type WorkflowStep,
  type WorkflowStepType,
} from './types.js';
import { WORKFLOW_STEP_FAILED_CODE, WorkflowExecutor } from './workflow-executor.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 300;

// ---------------------------------------------------------------------------
// Independent oracles (never call the executor's own graph validator)
// ---------------------------------------------------------------------------

/** A fully-populated, additive usage record (all four fields present). */
interface Usage {
  tokens: number;
  cost: number;
  durationMs: number;
  toolCalls: number;
}

/**
 * The expected execution order: a stable sort by non-decreasing `order`, with
 * ties broken by original array position (the documented contract of Req 17.2).
 * This is an independent reimplementation, not a call to `validateWorkflowGraph`.
 */
function expectedExecutionOrder(steps: readonly { id: string; order: number }[]): string[] {
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.order - b.step.order || a.index - b.index)
    .map(({ step }) => step.id);
}

/**
 * The expected aggregated usage: a field-wise sum over the given per-step usage
 * records. Mirrors the executor's "absent contributes 0" rule — with no records
 * the total is the empty object, matching an aggregation that never summed.
 */
function sumUsage(usages: readonly (Usage | undefined)[]): WorkflowResourceUsage {
  const present = usages.filter((u): u is Usage => u !== undefined);
  if (present.length === 0) {
    return {};
  }
  return present.reduce<Usage>(
    (acc, u) => ({
      tokens: acc.tokens + u.tokens,
      cost: acc.cost + u.cost,
      durationMs: acc.durationMs + u.durationMs,
      toolCalls: acc.toolCalls + u.toolCalls,
    }),
    { tokens: 0, cost: 0, durationMs: 0, toolCalls: 0 },
  );
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** All-integer usage so the field-wise sum is exact (no float drift). */
const usageArb: fc.Arbitrary<Usage> = fc.record({
  tokens: fc.nat({ max: 10_000 }),
  cost: fc.nat({ max: 10_000 }),
  durationMs: fc.nat({ max: 10_000 }),
  toolCalls: fc.nat({ max: 100 }),
});

/** A generated step skeleton before its dependency edges are chosen. */
interface Skeleton {
  id: string;
  order: number;
  type: WorkflowStepType;
  usage: Usage;
}

/**
 * 1..6 steps with unique ids (`step-0`..`step-n`), small `order` keys (so ties
 * exercise the deterministic tie-break), a step kind, and a usage record.
 */
const skeletonArb: fc.Arbitrary<Skeleton[]> = fc.integer({ min: 1, max: 6 }).chain((n) =>
  fc.tuple(
    ...Array.from({ length: n }, (_unused, i) =>
      fc
        .record({
          order: fc.integer({ min: 0, max: 5 }),
          type: fc.constantFrom<WorkflowStepType>('agent', 'delivery'),
          usage: usageArb,
        })
        .map(
          (r): Skeleton => ({ id: `step-${i}`, order: r.order, type: r.type, usage: r.usage }),
        ),
    ),
  ),
);

/** A complete generated scenario: a valid workflow plus the failure choice. */
interface Scenario {
  workflow: Workflow;
  /** The oracle execution order (all step ids). */
  execOrderIds: string[];
  /** Per-step seeded output, keyed by step id. */
  outputById: Map<string, unknown>;
  /** Per-step seeded usage, keyed by step id. */
  usageById: Map<string, Usage>;
  /** Each step's `inputRefs`, keyed by step id. */
  refsById: Map<string, string[]>;
  /** The execution-order position to fail, or `null` to let the run complete. */
  failPosition: number | null;
}

/**
 * A valid workflow (every `inputRefs` entry references a distinct, strictly
 * earlier step in the oracle order) plus a "which step fails (or none)" choice.
 */
const scenarioArb: fc.Arbitrary<Scenario> = skeletonArb.chain((skeleton) => {
  const execOrderIds = expectedExecutionOrder(skeleton);
  const positionById = new Map(execOrderIds.map((id, position) => [id, position] as const));

  // Each step may reference any subset of the steps ordered strictly before it.
  const refArbs = skeleton.map((s) => {
    const position = positionById.get(s.id) ?? 0;
    const earlier = execOrderIds.slice(0, position);
    return earlier.length === 0 ? fc.constant<string[]>([]) : fc.subarray(earlier);
  });

  // Fail a chosen position in the execution order, or complete the whole run.
  const failArb = fc.oneof(
    fc.constant<number | null>(null),
    fc.integer({ min: 0, max: execOrderIds.length - 1 }),
  );

  return fc.tuple(fc.tuple(...refArbs), failArb).map(([refsPerStep, failPosition]) => {
    const steps: WorkflowStep[] = skeleton.map((s, i) => ({
      id: s.id,
      order: s.order,
      type: s.type,
      inputRefs: refsPerStep[i] ?? [],
      config: {},
    }));
    const workflow: Workflow = {
      id: 'wf-prop',
      organizationId: 'org-prop',
      projectId: 'proj-prop',
      steps,
    };
    return {
      workflow,
      execOrderIds,
      outputById: new Map(skeleton.map((s) => [s.id, `out:${s.id}`] as const)),
      usageById: new Map(skeleton.map((s) => [s.id, s.usage] as const)),
      refsById: new Map(steps.map((s) => [s.id, s.inputRefs] as const)),
      failPosition,
    };
  });
});

// ---------------------------------------------------------------------------
// Property 38
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 38: Workflows execute in dependency order and halt on failure', () => {
  it('executes steps in dependency order, passes referenced outputs forward, halts on failure, and records the run (Validates: Requirements 17.2, 17.4)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { workflow, execOrderIds, outputById, usageById, refsById, failPosition } = scenario;

        const failedId = failPosition === null ? null : (execOrderIds[failPosition] ?? null);
        const failMessage = failedId === null ? '' : `boom:${failedId}`;

        // Seed a deterministic output + usage per step; force the chosen failure.
        const seed: Record<string, SeededStep> = {};
        for (const id of execOrderIds) {
          const seeded: SeededStep = { output: outputById.get(id), usage: usageById.get(id) };
          if (id === failedId) {
            seeded.failWith = new Error(failMessage);
          }
          seed[id] = seeded;
        }

        const stepExecutor = new RecordingStepExecutor(seed);
        const analytics = new RecordingAnalyticsRecorder();
        const executor = new WorkflowExecutor({ stepExecutor, analytics });

        const result = await executor.run(workflow);

        // Oracle expectations for the executed prefix and the succeeded prefix.
        const expectedExecuted =
          failPosition === null ? execOrderIds : execOrderIds.slice(0, failPosition + 1);
        const expectedSucceeded =
          failPosition === null ? execOrderIds : execOrderIds.slice(0, failPosition);

        // (Req 17.2) Steps execute in the deterministic dependency order, and on
        // failure no step ordered after the failed one runs (Req 17.4).
        expect(stepExecutor.executedStepIds).toEqual(expectedExecuted);
        expect(result.steps.map((o) => o.stepId)).toEqual(expectedExecuted);

        // (Req 17.2) The executed order is non-decreasing in `order` — the
        // "defined order" is honored independent of the id-level oracle.
        const orderById = new Map(workflow.steps.map((s) => [s.id, s.order] as const));
        const executedOrders = stepExecutor.executedStepIds.map((id) => orderById.get(id) ?? 0);
        for (let k = 1; k < executedOrders.length; k += 1) {
          expect((executedOrders[k] ?? 0) >= (executedOrders[k - 1] ?? 0)).toBe(true);
        }

        // (Req 17.2) Each step received exactly the outputs of the steps it
        // references — no more, no fewer.
        for (const execution of stepExecutor.executions) {
          const refs = refsById.get(execution.stepId) ?? [];
          const expectedInputs: Record<string, unknown> = {};
          for (const ref of refs) {
            expectedInputs[ref] = outputById.get(ref);
          }
          expect(execution.inputs).toEqual(expectedInputs);
        }

        if (failPosition === null) {
          // (Req 17.2/17.5) Completed: every step succeeded and carries its output.
          expect(result.status).toBe('completed');
          expect(result.failedStepId).toBeUndefined();
          expect(result.steps.every((o) => o.status === 'succeeded')).toBe(true);
          for (const outcome of result.steps) {
            expect(outcome.output).toBe(outputById.get(outcome.stepId));
          }
        } else {
          // (Req 17.4) Halted: status failed, the failed step is named, the steps
          // before it succeeded, and the failed outcome carries the projected error.
          expect(result.status).toBe('failed');
          expect(result.failedStepId).toBe(failedId);

          const succeededOutcomes = result.steps.slice(0, failPosition);
          expect(succeededOutcomes.every((o) => o.status === 'succeeded')).toBe(true);

          const failedOutcome = result.steps[failPosition];
          expect(failedOutcome?.stepId).toBe(failedId);
          expect(failedOutcome?.status).toBe('failed');
          expect(failedOutcome?.output).toBeUndefined();
          // A plain thrown Error is projected into a safe internal PlatformError.
          expect(failedOutcome?.error?.code).toBe(WORKFLOW_STEP_FAILED_CODE);
          expect(failedOutcome?.error?.category).toBe('internal');
          expect(failedOutcome?.error?.message).toBe(failMessage);
          expect((failedOutcome?.error?.details as { stepId?: string } | undefined)?.stepId).toBe(
            failedId,
          );
        }

        // (Req 17.5) The aggregated usage equals the field-wise sum of the usage
        // of exactly the steps that succeeded.
        const expectedUsage = sumUsage(expectedSucceeded.map((id) => usageById.get(id)));
        expect(result.usage).toEqual(expectedUsage);

        // (Req 17.5) Analytics recorded the run outcome + usage exactly once.
        expect(analytics.records).toHaveLength(1);
        const record = analytics.last;
        expect(record?.status).toBe(result.status);
        expect(record?.usage).toEqual(expectedUsage);
        expect(record?.stepsAttempted).toBe(expectedExecuted.length);
        expect(record?.workflowId).toBe(workflow.id);
        expect(record?.organizationId).toBe(workflow.organizationId);
        expect(record?.projectId).toBe(workflow.projectId);
        if (failPosition === null) {
          expect(record?.failedStepId).toBeUndefined();
        } else {
          expect(record?.failedStepId).toBe(failedId);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
