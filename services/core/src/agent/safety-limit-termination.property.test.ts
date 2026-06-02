/**
 * Property test for Agent_Runtime safety-limit termination (Req 15.2, 15.3, 15.4, 15.8).
 *
 * Feature: auxify-ai-platform, Property 34: Agent runs terminate at the first
 * safety limit reached, with matching status.
 * Validates: Requirements 15.2, 15.3, 15.4 (and exercises cancellation, Req 15.8).
 *
 * For ANY agent whose model loops forever (it always asks to call the same
 * allow-listed, schema-valid tool, so the model never returns a final answer and
 * never throws), the run can only end by hitting a safety boundary. This drives
 * the *real* {@link AgentRuntime} over the in-memory fakes in `./fakes.js` with
 * arbitrary:
 *
 *   - a step limit (`maxSteps`, Req 15.2),
 *   - a duration limit (`maxDurationMs`) against a {@link SteppingAgentClock}
 *     that advances a fixed amount on every read (Req 15.3),
 *   - a budget cap (`budgetCap`) against a fixed per-step cost (Req 15.4), and
 *   - an optional {@link FixedCancellation} that trips after `k` checks (Req 15.8),
 *
 * and asserts the Property-34 invariants:
 *
 *   1. **Always terminates** — every run ends, and because the model loops
 *      forever it ends with exactly one of the four safety statuses
 *      (`stopped_step_limit` / `stopped_time_limit` / `stopped_budget_cap` /
 *      `cancelled`), never `completed` or `failed`, with a `null` answer.
 *   2. **Matching status for the first limit reached** — the terminal status
 *      equals the limit an INDEPENDENT oracle says binds first. The oracle
 *      re-derives the runtime's contract from scratch: at the top of every
 *      iteration it checks cancellation, then elapsed time, then the step count;
 *      after each executed step it checks accumulated cost. It never calls the
 *      module under test.
 *   3. **Never exceeds a bound** — the recorded step count never exceeds
 *      `maxSteps` (Req 15.2); when the budget cap is finite the accumulated cost
 *      never exceeds it by more than a single step's cost (Req 15.4); and no step
 *      ever executes after the elapsed time crossed `maxDurationMs`, so the run
 *      overruns the duration limit by at most one step's granularity (Req 15.3).
 *   4. **Totals reconcile** — the run totals are exactly the aggregation over the
 *      recorded steps.
 *
 * ## How the time oracle stays exact
 *
 * The runtime reads the injected clock in a fixed pattern: once for the run's
 * start time, then per loop iteration once for the pre-turn elapsed-time check
 * and twice inside the tool step (its start and end). With a
 * `SteppingAgentClock(0, d)` — which returns `0, d, 2d, 3d, …` on successive
 * reads — the elapsed time observed at the pre-turn check of iteration `n`
 * (1-based) is therefore `(3n - 2) * d`. The oracle uses exactly this closed
 * form, so it predicts the duration trip point without ever inspecting the
 * runtime.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AgentRuntime } from './agent-runtime.js';
import {
  FixedCancellation,
  LoopingToolModelPort,
  SteppingAgentClock,
  makeAgent,
  makePrincipal,
  sampleAgentRegistry,
  sequentialAgentIdGenerator,
} from './fakes.js';
import type { AgentRunStatus, SafetyLimits } from './types.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 300;

const PRINCIPAL = makePrincipal();

/** The looping tool the model always asks for: allow-listed and schema-valid, so every step is `ok`. */
const LOOP_TOOL = 'web_search';
const LOOP_INPUT = { query: 'loop' } as const;

/** A single generated scenario: the four safety knobs plus the clock/cost the runtime is driven with. */
interface Scenario {
  /** Step limit (Req 15.2); always a positive integer the runtime accepts. */
  maxSteps: number;
  /** Duration limit in ms (Req 15.3); always positive. */
  maxDurationMs: number;
  /** Per-read clock increment for the {@link SteppingAgentClock}; 0 means time never advances. */
  clockStep: number;
  /** Cost attributed to every step. */
  costPerStep: number;
  /** Budget cap (Req 15.4), or `undefined` to leave it unset (an infinite budget). */
  budgetCap: number | undefined;
  /** Cancel after this many `isCancelled` checks (Req 15.8), or `null` for no cancellation seam. */
  cancelAfter: number | null;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  maxSteps: fc.integer({ min: 1, max: 25 }),
  maxDurationMs: fc.integer({ min: 1, max: 60_000 }),
  clockStep: fc.integer({ min: 0, max: 5_000 }),
  costPerStep: fc.integer({ min: 0, max: 50 }),
  budgetCap: fc.option(fc.integer({ min: 0, max: 500 }), { nil: undefined }),
  cancelAfter: fc.option(fc.integer({ min: 0, max: 30 }), { nil: null }),
});

/** The result of the independent oracle: the predicted terminal status and recorded step count. */
interface OracleResult {
  status: AgentRunStatus;
  steps: number;
}

/**
 * Independently re-derive which safety limit terminates a forever-looping run,
 * and how many steps it records, by simulating the runtime's contract directly
 * (Req 15.2-15.4, 15.8). This deliberately does NOT call {@link AgentRuntime}.
 *
 * Mirrors the documented check order: at the top of each 1-based iteration `n`
 * it checks cancellation, then elapsed time `(3n - 2) * clockStep`, then the
 * step count; if all pass, one step runs and accumulated cost is checked against
 * the budget cap. The step limit guarantees termination, so the loop is bounded.
 */
function predict(scenario: Scenario): OracleResult {
  const budgetCap = scenario.budgetCap ?? Number.POSITIVE_INFINITY;
  let steps = 0;
  let cost = 0;
  let cancelChecks = 0;

  for (let iteration = 1; ; iteration += 1) {
    // Top of the loop, in the runtime's order: cancellation (Req 15.8) ...
    if (scenario.cancelAfter !== null) {
      const cancelled = cancelChecks >= scenario.cancelAfter;
      cancelChecks += 1;
      if (cancelled) {
        return { status: 'cancelled', steps };
      }
    }
    // ... then the elapsed-time bound (Req 15.3) ...
    const elapsed = (3 * iteration - 2) * scenario.clockStep;
    if (elapsed >= scenario.maxDurationMs) {
      return { status: 'stopped_time_limit', steps };
    }
    // ... then the step bound (Req 15.2).
    if (steps >= scenario.maxSteps) {
      return { status: 'stopped_step_limit', steps };
    }

    // The model loops forever, so a step always executes here.
    steps += 1;
    cost += scenario.costPerStep;

    // Bottom of the loop: the budget cap (Req 15.4).
    if (cost >= budgetCap) {
      return { status: 'stopped_budget_cap', steps };
    }
  }
}

/** The four statuses a forever-looping run may end with — never `completed`/`failed`. */
const SAFETY_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>([
  'stopped_step_limit',
  'stopped_time_limit',
  'stopped_budget_cap',
  'cancelled',
]);

describe('Feature: auxify-ai-platform, Property 34: Agent runs terminate at the first safety limit reached, with matching status', () => {
  it('terminates a forever-looping run at the first bound with the matching status and never overruns it (Validates: Requirements 15.2, 15.3, 15.4)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const safetyLimits: Partial<SafetyLimits> = {
          maxSteps: scenario.maxSteps,
          maxDurationMs: scenario.maxDurationMs,
        };
        if (scenario.budgetCap !== undefined) {
          safetyLimits.budgetCap = scenario.budgetCap;
        }

        // A model that always re-requests the same valid, allow-listed tool, so
        // ONLY a safety limit can ever stop the run.
        const model = new LoopingToolModelPort(LOOP_TOOL, LOOP_INPUT, scenario.costPerStep);
        const runtime = new AgentRuntime({
          model,
          tools: sampleAgentRegistry(),
          clock: new SteppingAgentClock(0, scenario.clockStep),
          idGenerator: sequentialAgentIdGenerator(),
        });
        const cancellation =
          scenario.cancelAfter !== null ? new FixedCancellation(scenario.cancelAfter) : undefined;

        const result = await runtime.run(
          { agent: makeAgent({ safetyLimits }), task: 'loop forever' },
          PRINCIPAL,
          cancellation !== undefined ? { cancellation } : {},
        );

        const expected = predict(scenario);

        // (1) The run terminated with exactly one safety status (a looping model
        // never completes on its own and never fails), and carries no answer.
        expect(SAFETY_STATUSES.has(result.status)).toBe(true);
        expect(result.answer).toBeNull();

        // (2) The status names the limit the oracle says binds first, and the
        // recorded step count matches the oracle exactly.
        expect(result.status).toBe(expected.status);
        expect(result.totalSteps).toBe(expected.steps);
        expect(result.steps).toHaveLength(expected.steps);

        // (3a) The step count never exceeds maxSteps (Req 15.2).
        expect(result.totalSteps).toBeLessThanOrEqual(scenario.maxSteps);

        // (3b) When the budget is finite, cost never exceeds it by more than one
        // step's cost (Req 15.4).
        if (scenario.budgetCap !== undefined) {
          expect(result.totalCost).toBeLessThanOrEqual(scenario.budgetCap + scenario.costPerStep);
        }

        // (3c) No step ran after the elapsed time crossed maxDurationMs: the
        // pre-turn check of the iteration that recorded the final step still saw
        // elapsed < maxDurationMs, so the run overran the duration limit by at
        // most one step's granularity (Req 15.3).
        if (result.totalSteps >= 1) {
          const elapsedAtFinalStep = (3 * result.totalSteps - 2) * scenario.clockStep;
          expect(elapsedAtFinalStep).toBeLessThan(scenario.maxDurationMs);
        }

        // (4) Run totals reconcile over the recorded steps: every step is an `ok`
        // dispatch of the looping tool with the configured per-step cost.
        expect(result.steps.every((step) => step.outcome === 'ok')).toBe(true);
        expect(result.totalCost).toBe(result.totalSteps * scenario.costPerStep);
        const summedCost = result.steps.reduce((acc, step) => acc + step.cost, 0);
        expect(result.totalCost).toBe(summedCost);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
