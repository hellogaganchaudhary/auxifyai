/**
 * Property-based test for **Property 35: Agent step records are complete and run
 * totals reconcile** (design "Property 35"; Req 15.6, 15.9).
 *
 * Validates: Requirements 15.6, 15.9
 *
 * Property 35 (design): _For any_ agent run, each executed step records its step
 * number, tool used, tool input, tool output, and duration, and on completion
 * the run's total steps, total tokens, total cost, and total duration equal the
 * aggregation over its recorded steps. Requirement 15.6 makes the Agent_Runtime
 * record, per completed step, the step number, the tool used, the tool input,
 * the tool output, and the step duration; Requirement 15.9 makes the finished
 * run record the final status, total steps, total tokens, total cost, and total
 * duration.
 *
 * This file drives the *real* {@link AgentRuntime} from `./agent-runtime.js`
 * (task 15.5) over the *real* {@link ToolRegistry} (task 15.3), wired to the
 * in-memory fakes in `./fakes.js`:
 *
 *   - a {@link ScriptedModelPort} replays a generated sequence of tool-call
 *     decisions — each carrying its own generated `usage`/`cost` — then a final
 *     answer, so an arbitrary number of attempted steps is produced exactly;
 *   - the tools under test are permissive echo tools (any object input is
 *     schema-valid), all on the agent's Allow_List, so every attempted step
 *     succeeds (`ok`) and its output is the deterministic `{ echoed: input }`;
 *   - a {@link SteppingAgentClock} and {@link sequentialAgentIdGenerator} make
 *     durations and ids deterministic.
 *
 * The independent oracle is the generated script itself: from the generated
 * `(toolId, input, usage, cost)` per step we know exactly what each recorded
 * step must contain and what the field-wise sums must be, so the test never
 * re-derives totals from the runtime's own output when checking record
 * completeness. The reconciliation invariant is additionally cross-checked
 * directly: the run-level totals must equal the field-wise aggregation over the
 * runtime's *own* recorded steps.
 *
 * Two facets of the one property are asserted across arbitrary runs:
 *   1. exactly one complete, correctly-numbered step is recorded per attempted
 *      tool call (in order, no gaps, no duplicates), each carrying its expected
 *      tool/input/output/usage, and the run totals reconcile over those steps;
 *   2. every recorded step is fed back to the model as an in-order observation,
 *      so what the run records is exactly what the loop observed.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AgentRuntime } from './agent-runtime.js';
import {
  ScriptedModelPort,
  SteppingAgentClock,
  ToolRegistry,
  makeAgent,
  makePrincipal,
  makeTool,
  sequentialAgentIdGenerator,
} from './fakes.js';
import type { AgentModelResponse, AgentToolCall } from './types.js';
import type { JsonSchema } from '../tools/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

/**
 * The ids of the permissive echo tools the runtime is driven over. A small pool
 * so generated scripts revisit the same tools and Allow_List coverage is total.
 */
const TOOL_IDS = ['tool_a', 'tool_b', 'tool_c'] as const;

/** Property-name pool for generated tool inputs (fixed keys avoid prototype-key pitfalls). */
const KEY_POOL = ['a', 'b', 'c', 'd'] as const;

/** A permissive object schema: any plain object input is valid, so steps succeed (`ok`). */
const PERMISSIVE_SCHEMA: JsonSchema = { type: 'object', additionalProperties: true };

const PRINCIPAL = makePrincipal();

// ---------------------------------------------------------------------------
// Generated step model
// ---------------------------------------------------------------------------

/** One generated attempted step: which tool, what input, and its model-call usage/cost. */
interface StepSpec {
  toolId: string;
  input: Record<string, unknown>;
  usage?: { inputTokens: number; outputTokens: number };
  cost?: number;
}

/** A small JSON-ish object input; permissive schema accepts any shape. */
const inputArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.constantFrom(...KEY_POOL),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { maxKeys: KEY_POOL.length },
);

/** Reported token usage of the model call that produced the step. */
const usageArb = fc.record({
  inputTokens: fc.nat({ max: 10_000 }),
  outputTokens: fc.nat({ max: 10_000 }),
});

/** Reported cost of the model call (kept well below any default budget cap). */
const costArb = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });

/**
 * A single attempted step. `usage`/`cost` are independently present-or-absent so
 * the default-to-zero attribution path (Req 15.9) is also exercised.
 */
const stepSpecArb: fc.Arbitrary<StepSpec> = fc
  .record({
    toolId: fc.constantFrom(...TOOL_IDS),
    input: inputArb,
    usage: fc.option(usageArb, { nil: undefined }),
    cost: fc.option(costArb, { nil: undefined }),
  })
  .map((r) => {
    const spec: StepSpec = { toolId: r.toolId, input: r.input };
    if (r.usage !== undefined) spec.usage = r.usage;
    if (r.cost !== undefined) spec.cost = r.cost;
    return spec;
  });

/**
 * 0..12 attempted steps — fewer than the 50-step default limit so the run always
 * completes via the final answer rather than a safety stop (the safety-limit
 * behavior is Property 34's concern, not this one).
 */
const scriptArb: fc.Arbitrary<StepSpec[]> = fc.array(stepSpecArb, { minLength: 0, maxLength: 12 });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Build the model tool-call decision for a generated step. */
function toToolCall(spec: StepSpec): AgentToolCall {
  const call: AgentToolCall = { kind: 'tool_call', toolId: spec.toolId, input: spec.input };
  if (spec.usage !== undefined) call.usage = spec.usage;
  if (spec.cost !== undefined) call.cost = spec.cost;
  return call;
}

/** The tokens (combined) the runtime attributes to a step, per its `callCost` rule. */
function expectedTokens(spec: StepSpec): number {
  return spec.usage !== undefined ? spec.usage.inputTokens + spec.usage.outputTokens : 0;
}

/** The cost the runtime attributes to a step (absent ⇒ 0). */
function expectedCost(spec: StepSpec): number {
  return spec.cost ?? 0;
}

/** Sum a list of numbers left-to-right from 0 (the runtime's own reduction order). */
function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/**
 * Assemble a real {@link AgentRuntime} over a real {@link ToolRegistry} of
 * permissive echo tools, driven by a {@link ScriptedModelPort} that replays
 * `specs` as tool calls then a terminal `final` answer.
 */
function runScript(specs: readonly StepSpec[]): {
  runtime: AgentRuntime;
  model: ScriptedModelPort;
} {
  const tools = new ToolRegistry(
    TOOL_IDS.map((id) => makeTool({ id, parameters: PERMISSIVE_SCHEMA })),
  );
  const script: AgentModelResponse[] = specs.map(toToolCall);
  // Once the scripted tool calls are exhausted, the model returns the final answer.
  const model = new ScriptedModelPort(script, { kind: 'final', answer: 'done' });
  const runtime = new AgentRuntime({
    model,
    tools,
    clock: new SteppingAgentClock(0, 1),
    idGenerator: sequentialAgentIdGenerator(),
  });
  return { runtime, model };
}

// ---------------------------------------------------------------------------
// Property 35
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 35: Agent step records are complete and run totals reconcile', () => {
  it('records exactly one complete step per attempted tool call, in order, and reconciles run totals over the recorded steps (Validates: Requirements 15.6, 15.9)', async () => {
    await fc.assert(
      fc.asyncProperty(scriptArb, async (specs) => {
        const agent = makeAgent({ allowedTools: [...TOOL_IDS] });
        const { runtime } = runScript(specs);

        const result = await runtime.run({ agent, task: 'reconcile' }, PRINCIPAL);

        // The run completed normally (no safety stop) with the scripted answer.
        expect(result.status).toBe('completed');
        expect(result.answer).toBe('done');

        // Exactly one step per attempted tool call — none missing, none extra.
        expect(result.steps).toHaveLength(specs.length);
        expect(result.totalSteps).toBe(specs.length);

        // Steps are numbered 1..N in attempt order, with unique ids (no duplicates).
        expect(result.steps.map((s) => s.stepNumber)).toEqual(
          specs.map((_, i) => i + 1),
        );
        const stepIds = result.steps.map((s) => s.id);
        expect(new Set(stepIds).size).toBe(stepIds.length);

        // Req 15.6: each step records the tool, input, output, usage, and a duration.
        result.steps.forEach((step, i) => {
          const spec = specs[i]!;
          expect(step.tool).toBe(spec.toolId);
          expect(step.input).toEqual(spec.input);
          expect(step.outcome).toBe('ok');
          expect(step.denied).toBe(false);
          // The permissive echo tool returns { echoed: input } — the recorded observation.
          expect(step.output).toEqual({ echoed: spec.input });
          expect(step.tokens).toBe(expectedTokens(spec));
          expect(step.cost).toBe(expectedCost(spec));
          expect(step.durationMs).toBeGreaterThanOrEqual(0);
        });

        // Req 15.9 — independent oracle: totals equal the field-wise sum over the
        // generated steps.
        expect(result.totalTokens).toBe(sum(specs.map(expectedTokens)));
        expect(result.totalCost).toBeCloseTo(sum(specs.map(expectedCost)), 10);

        // Req 15.9 — reconciliation invariant: totals equal the aggregation over the
        // runtime's *own* recorded steps (tokens/cost/duration/count all reconcile).
        expect(result.totalTokens).toBe(sum(result.steps.map((s) => s.tokens)));
        expect(result.totalCost).toBeCloseTo(sum(result.steps.map((s) => s.cost)), 10);
        expect(result.totalDurationMs).toBe(sum(result.steps.map((s) => s.durationMs)));
        expect(result.totalSteps).toBe(result.steps.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('feeds every recorded step back to the model as an in-order observation, with no gaps or duplicates (Validates: Requirements 15.6)', async () => {
    await fc.assert(
      fc.asyncProperty(scriptArb, async (specs) => {
        const agent = makeAgent({ allowedTools: [...TOOL_IDS] });
        const { runtime, model } = runScript(specs);

        const result = await runtime.run({ agent, task: 'observe' }, PRINCIPAL);

        // The model was consulted once per attempted step, plus once for the final answer.
        expect(model.callCount).toBe(specs.length + 1);

        // The final turn (the last request) saw every recorded step as an observation.
        const finalRequest = model.requests[model.requests.length - 1]!;
        expect(finalRequest.observations).toHaveLength(result.steps.length);

        // Each observation corresponds 1:1 and in order to a recorded step (Req 15.6),
        // confirming what the run records is exactly what the loop observed.
        finalRequest.observations.forEach((observation, i) => {
          const step = result.steps[i]!;
          expect(observation.stepNumber).toBe(step.stepNumber);
          expect(observation.toolId).toBe(step.tool);
          expect(observation.input).toEqual(step.input);
          expect(observation.output).toEqual(step.output);
          expect(observation.outcome).toBe(step.outcome);
        });

        // Observation step numbers are exactly 1..N — no gaps, no duplicates.
        expect(finalRequest.observations.map((o) => o.stepNumber)).toEqual(
          result.steps.map((_, i) => i + 1),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
