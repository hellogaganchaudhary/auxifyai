/**
 * Unit tests for the Agent_Runtime (Req 15.1-15.9, 16.2, 16.3).
 *
 * These example-based tests cover the runtime's discrete behaviors and edge
 * cases against the *real* {@link AgentRuntime} wired to the in-memory fakes in
 * `./fakes.js` (a scripted model, a real Tool_Registry over the sample tools, a
 * deterministic clock and id generator):
 *
 *   - a no-tool direct answer (`completed`, no steps) (Req 15.1);
 *   - a single tool-call then answer, with a complete step record (Req 15.6);
 *   - a denied (non-allow-listed) tool call recorded as a denial (Req 16.3);
 *   - an invalid-args tool call recorded without dispatch (Req 16.2);
 *   - hitting the iteration (step) limit (Req 15.2);
 *   - step recording order and run-total reconciliation (Req 15.6, 15.9);
 *   - the time limit (Req 15.3) and budget cap (Req 15.4);
 *   - destructive-action approval (Req 15.5), cancellation (Req 15.8), and
 *     real-time step events (Req 15.7); and
 *   - the structurally-invalid-input guard.
 */

import { describe, expect, it } from 'vitest';

import { AgentRuntime } from './agent-runtime.js';
import { InvalidAgentRunError } from './errors.js';
import {
  CapturingAgentEventSink,
  FixedApprovalPort,
  FixedCancellation,
  LoopingToolModelPort,
  ScriptedModelPort,
  SteppingAgentClock,
  ToolRegistry,
  makeAgent,
  makePrincipal,
  makeTool,
  sampleAgentRegistry,
  sequentialAgentIdGenerator,
} from './fakes.js';
import type { AgentModelResponse } from './types.js';

const PRINCIPAL = makePrincipal();

/** Assemble a runtime over fresh fakes; returns the runtime and its collaborators. */
function setup(
  script: readonly AgentModelResponse[],
  options: {
    fallback?: AgentModelResponse;
    clock?: SteppingAgentClock;
    events?: CapturingAgentEventSink;
    approval?: FixedApprovalPort;
  } = {},
): {
  runtime: AgentRuntime;
  model: ScriptedModelPort;
  tools: ReturnType<typeof sampleAgentRegistry>;
  events?: CapturingAgentEventSink;
} {
  const model =
    options.fallback !== undefined
      ? new ScriptedModelPort(script, options.fallback)
      : new ScriptedModelPort(script);
  const tools = sampleAgentRegistry();
  const runtime = new AgentRuntime({
    model,
    tools,
    clock: options.clock ?? new SteppingAgentClock(0, 1),
    idGenerator: sequentialAgentIdGenerator(),
    ...(options.events !== undefined ? { events: options.events } : {}),
    ...(options.approval !== undefined ? { approval: options.approval } : {}),
  });
  return { runtime, model, tools, ...(options.events !== undefined ? { events: options.events } : {}) };
}

describe('AgentRuntime no-tool direct answer (Req 15.1)', () => {
  it('completes immediately with the final answer and no steps', async () => {
    const { runtime, model } = setup([{ kind: 'final', answer: '42' }]);

    const result = await runtime.run({ agent: makeAgent(), task: 'What is 6 x 7?' }, PRINCIPAL);

    expect(result.status).toBe('completed');
    expect(result.answer).toBe('42');
    expect(result.steps).toEqual([]);
    expect(result.totalSteps).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.totalCost).toBe(0);
    // The model was consulted exactly once.
    expect(model.callCount).toBe(1);
  });
});

describe('AgentRuntime single tool-call then answer (Req 15.1, 15.6)', () => {
  it('dispatches the tool, records a complete step, then finishes', async () => {
    const { runtime, model } = setup([
      {
        kind: 'tool_call',
        toolId: 'web_search',
        input: { query: 'auxify' },
        usage: { inputTokens: 5, outputTokens: 7 },
        cost: 0.5,
      },
      { kind: 'final', answer: 'found it' },
    ]);

    const result = await runtime.run({ agent: makeAgent(), task: 'search' }, PRINCIPAL);

    expect(result.status).toBe('completed');
    expect(result.answer).toBe('found it');
    expect(result.steps).toHaveLength(1);

    const step = result.steps[0]!;
    expect(step.stepNumber).toBe(1);
    expect(step.tool).toBe('web_search');
    expect(step.input).toEqual({ query: 'auxify' });
    expect(step.output).toEqual({ echoed: { query: 'auxify' } });
    expect(step.denied).toBe(false);
    expect(step.outcome).toBe('ok');
    expect(step.tokens).toBe(12);
    expect(step.cost).toBe(0.5);
    expect(step.durationMs).toBeGreaterThanOrEqual(0);

    // The model saw the tool result fed back on its second turn (observe).
    expect(model.requests[1]?.observations).toHaveLength(1);
    expect(model.requests[1]?.observations[0]?.outcome).toBe('ok');
  });
});

describe('AgentRuntime Allow_List denial (Req 16.3)', () => {
  it('records a denied step (denied: true) and never dispatches the tool', async () => {
    // The agent may only use web_search; the model asks for sql_query.
    const agent = makeAgent({ allowedTools: ['web_search'] });
    const { runtime } = setup([
      { kind: 'tool_call', toolId: 'sql_query', input: { sql: 'SELECT 1' } },
      { kind: 'final', answer: 'gave up' },
    ]);

    const result = await runtime.run({ agent, task: 'query' }, PRINCIPAL);

    expect(result.status).toBe('completed');
    expect(result.steps).toHaveLength(1);
    const step = result.steps[0]!;
    expect(step.tool).toBe('sql_query');
    expect(step.denied).toBe(true);
    expect(step.outcome).toBe('denied');
    expect(step.output).toMatchObject({ error: 'tool_not_allowed' });
  });
});

describe('AgentRuntime invalid tool input (Req 16.2)', () => {
  it('records an invalid_input step and never dispatches the tool', async () => {
    // web_search requires a string `query`; supply the wrong type.
    const { runtime } = setup([
      { kind: 'tool_call', toolId: 'web_search', input: { query: 123 } },
      { kind: 'final', answer: 'done' },
    ]);

    const result = await runtime.run({ agent: makeAgent(), task: 'search' }, PRINCIPAL);

    expect(result.steps).toHaveLength(1);
    const step = result.steps[0]!;
    expect(step.outcome).toBe('invalid_input');
    expect(step.denied).toBe(false);
    expect(step.output).toMatchObject({ error: 'invalid_input' });
    expect((step.output as { violations: unknown[] }).violations.length).toBeGreaterThan(0);
  });

  it('records an unknown_tool step when the model names an unregistered tool', async () => {
    const agent = makeAgent({ allowedTools: ['ghost_tool'] });
    const { runtime } = setup([
      { kind: 'tool_call', toolId: 'ghost_tool', input: {} },
      { kind: 'final', answer: 'done' },
    ]);

    const result = await runtime.run({ agent, task: 'x' }, PRINCIPAL);

    expect(result.steps[0]?.outcome).toBe('unknown_tool');
    expect(result.steps[0]?.denied).toBe(false);
  });
});

describe('AgentRuntime iteration/step limit (Req 15.2)', () => {
  it('stops at the configured step limit with stopped_step_limit and never exceeds it', async () => {
    const agent = makeAgent({ safetyLimits: { maxSteps: 3 } });
    // A model that always asks for the same valid tool — it never finishes on
    // its own, so only the step limit can stop it.
    const model = new LoopingToolModelPort('web_search', { query: 'loop' });
    const runtime = new AgentRuntime({
      model,
      tools: sampleAgentRegistry(),
      clock: new SteppingAgentClock(0, 1),
      idGenerator: sequentialAgentIdGenerator(),
    });

    const result = await runtime.run({ agent, task: 'loop forever' }, PRINCIPAL);

    expect(result.status).toBe('stopped_step_limit');
    expect(result.totalSteps).toBe(3);
    expect(result.steps).toHaveLength(3);
    expect(result.answer).toBeNull();
    expect(result.stoppedReason).toContain('step limit');
  });
});

describe('AgentRuntime step recording order and total reconciliation (Req 15.6, 15.9)', () => {
  it('numbers steps 1..N in order and reconciles run totals over steps', async () => {
    const { runtime } = setup([
      {
        kind: 'tool_call',
        toolId: 'web_search',
        input: { query: 'a' },
        usage: { inputTokens: 1, outputTokens: 2 },
        cost: 0.1,
      },
      {
        kind: 'tool_call',
        toolId: 'sql_query',
        input: { sql: 'SELECT 1' },
        usage: { inputTokens: 3, outputTokens: 4 },
        cost: 0.2,
      },
      { kind: 'final', answer: 'done' },
    ]);

    const result = await runtime.run({ agent: makeAgent(), task: 'multi' }, PRINCIPAL);

    expect(result.steps.map((s) => s.stepNumber)).toEqual([1, 2]);
    expect(result.steps.map((s) => s.tool)).toEqual(['web_search', 'sql_query']);

    // Totals equal the aggregation over the recorded steps (Property 35).
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
    expect(result.totalSteps).toBe(result.steps.length);
    expect(result.totalTokens).toBe(sum(result.steps.map((s) => s.tokens)));
    expect(result.totalCost).toBeCloseTo(sum(result.steps.map((s) => s.cost)), 10);
    expect(result.totalDurationMs).toBe(sum(result.steps.map((s) => s.durationMs)));
  });
});

describe('AgentRuntime time limit (Req 15.3)', () => {
  it('stops at the time limit with stopped_time_limit before the next turn', async () => {
    // Clock advances by 100ms per read; with a 50ms limit the very first
    // pre-turn time check (after run start) exceeds it.
    const agent = makeAgent({ safetyLimits: { maxDurationMs: 50 } });
    const model = new LoopingToolModelPort('web_search', { query: 'x' });
    const runtime = new AgentRuntime({
      model,
      tools: sampleAgentRegistry(),
      clock: new SteppingAgentClock(0, 100),
      idGenerator: sequentialAgentIdGenerator(),
    });

    const result = await runtime.run({ agent, task: 'slow' }, PRINCIPAL);

    expect(result.status).toBe('stopped_time_limit');
    expect(result.stoppedReason).toContain('time limit');
  });
});

describe('AgentRuntime budget cap (Req 15.4)', () => {
  it('stops at the budget cap once accumulated step cost reaches it', async () => {
    const agent = makeAgent({ safetyLimits: { budgetCap: 1 } });
    // Each step costs 0.6; after two steps cost is 1.2 >= 1.0.
    const model = new LoopingToolModelPort('web_search', { query: 'x' }, 0.6);
    const runtime = new AgentRuntime({
      model,
      tools: sampleAgentRegistry(),
      clock: new SteppingAgentClock(0, 1),
      idGenerator: sequentialAgentIdGenerator(),
    });

    const result = await runtime.run({ agent, task: 'spend' }, PRINCIPAL);

    expect(result.status).toBe('stopped_budget_cap');
    expect(result.totalCost).toBeGreaterThanOrEqual(1);
    expect(result.stoppedReason).toContain('budget cap');
  });
});

describe('AgentRuntime destructive-action approval (Req 15.5)', () => {
  it('runs a destructive tool only when approval is granted', async () => {
    const agent = makeAgent({ destructiveTools: ['github_issue'] });
    const approval = new FixedApprovalPort(true);
    const { runtime } = setup(
      [
        { kind: 'tool_call', toolId: 'github_issue', input: { repo: 'a/b', title: 't' } },
        { kind: 'final', answer: 'opened' },
      ],
      { approval },
    );

    const result = await runtime.run({ agent, task: 'open issue' }, PRINCIPAL);

    expect(approval.requests).toHaveLength(1);
    expect(result.steps[0]?.outcome).toBe('ok');
  });

  it('records approval_denied and never runs the tool when approval is withheld', async () => {
    const agent = makeAgent({ destructiveTools: ['github_issue'] });
    const approval = new FixedApprovalPort(false);
    const { runtime } = setup(
      [
        { kind: 'tool_call', toolId: 'github_issue', input: { repo: 'a/b', title: 't' } },
        { kind: 'final', answer: 'blocked' },
      ],
      { approval },
    );

    const result = await runtime.run({ agent, task: 'open issue' }, PRINCIPAL);

    expect(result.steps[0]?.outcome).toBe('approval_denied');
  });

  it('denies a destructive action fail-closed when no approval port is configured', async () => {
    const agent = makeAgent({ destructiveTools: ['github_issue'] });
    const { runtime } = setup([
      { kind: 'tool_call', toolId: 'github_issue', input: { repo: 'a/b', title: 't' } },
      { kind: 'final', answer: 'blocked' },
    ]);

    const result = await runtime.run({ agent, task: 'open issue' }, PRINCIPAL);

    expect(result.steps[0]?.outcome).toBe('approval_denied');
  });
});

describe('AgentRuntime cancellation (Req 15.8)', () => {
  it('reports the run as cancelled when the cancel signal is set', async () => {
    const model = new LoopingToolModelPort('web_search', { query: 'x' });
    const runtime = new AgentRuntime({
      model,
      tools: sampleAgentRegistry(),
      clock: new SteppingAgentClock(0, 1),
      idGenerator: sequentialAgentIdGenerator(),
    });
    // Cancel after one loop iteration (one step recorded), then stop.
    const cancellation = new FixedCancellation(1);

    const result = await runtime.run({ agent: makeAgent(), task: 'cancel me' }, PRINCIPAL, {
      cancellation,
    });

    expect(result.status).toBe('cancelled');
    expect(result.stoppedReason).toContain('cancelled');
    expect(result.totalSteps).toBe(1);
  });
});

describe('AgentRuntime real-time step events (Req 15.7)', () => {
  it('emits run_started, a step_recorded per step, and run_finished in order', async () => {
    const events = new CapturingAgentEventSink();
    const { runtime } = setup(
      [
        { kind: 'tool_call', toolId: 'web_search', input: { query: 'a' } },
        { kind: 'final', answer: 'done' },
      ],
      { events },
    );

    const result = await runtime.run({ agent: makeAgent(), task: 'emit' }, PRINCIPAL);

    expect(events.events[0]?.type).toBe('run_started');
    expect(events.ofType('step_recorded')).toHaveLength(1);
    const finished = events.ofType('run_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.status).toBe('completed');
    expect(finished[0]?.result).toEqual(result);
  });
});

describe('AgentRuntime tool handler error (Req 15.6)', () => {
  it('records an error step when the tool handler throws and keeps running', async () => {
    // Register a tool whose handler throws.
    const failing = new ToolRegistry([
      makeTool({
        id: 'boom',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
        handler: () => {
          throw new Error('handler exploded');
        },
      }),
    ]);
    const agent = makeAgent({ allowedTools: ['boom'] });
    const model = new ScriptedModelPort([
      { kind: 'tool_call', toolId: 'boom', input: {} },
      { kind: 'final', answer: 'recovered' },
    ]);
    const runtime = new AgentRuntime({
      model,
      tools: failing,
      clock: new SteppingAgentClock(0, 1),
      idGenerator: sequentialAgentIdGenerator(),
    });

    const result = await runtime.run({ agent, task: 'fail' }, PRINCIPAL);

    expect(result.status).toBe('completed');
    expect(result.steps[0]?.outcome).toBe('error');
    expect(result.steps[0]?.error).toContain('handler exploded');
  });
});

describe('AgentRuntime invalid run input (Req 15.1)', () => {
  it('throws InvalidAgentRunError for a missing task', async () => {
    const { runtime } = setup([{ kind: 'final', answer: 'x' }]);
    await expect(
      runtime.run({ agent: makeAgent(), task: '' }, PRINCIPAL),
    ).rejects.toBeInstanceOf(InvalidAgentRunError);
  });

  it('throws InvalidAgentRunError for a non-positive maxSteps', async () => {
    const { runtime } = setup([{ kind: 'final', answer: 'x' }]);
    await expect(
      runtime.run(
        { agent: makeAgent({ safetyLimits: { maxSteps: 0 } }), task: 'go' },
        PRINCIPAL,
      ),
    ).rejects.toBeInstanceOf(InvalidAgentRunError);
  });

  it('projects InvalidAgentRunError to a validation PlatformError', () => {
    const platform = new InvalidAgentRunError('bad').toPlatformError('corr-1');
    expect(platform.category).toBe('validation');
    expect(platform.code).toBe('INVALID_AGENT_RUN');
  });
});
