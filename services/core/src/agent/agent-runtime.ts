/**
 * The Agent_Runtime (Req 15.1-15.9, 16.2, 16.3).
 *
 * {@link AgentRuntime} executes an agent autonomously over a single task,
 * looping **plan → act → observe → iterate** (Req 15.1):
 *
 *   1. **plan** — call the {@link AgentModelPort} with the agent's model, system
 *      prompt, the task, and every prior {@link AgentObservation}; the model
 *      replies with either a tool call or a final answer;
 *   2. **act** — for a tool call, gate it through the {@link AgentToolDispatcher}
 *      (the Tool_Registry): deny a tool not on the agent's Allow_List (Req 16.3),
 *      reject input that fails the tool's schema (Req 16.2), require human
 *      approval for a destructive tool (Req 15.5), then dispatch it;
 *   3. **observe** — record a complete {@link AgentStepRecord} (step number, tool,
 *      input, output, duration — Req 15.6) and emit it in real time (Req 15.7),
 *      then feed the observation back to the model;
 *   4. **iterate** — repeat until the model returns a final answer (`completed`)
 *      or a safety limit is reached (Req 15.2-15.4).
 *
 * ## Safety limits, checked at the *first* boundary reached (Req 15.2-15.4, Property 34)
 *
 * Before each model turn the runtime checks, in order: cancellation (Req 15.8 →
 * `cancelled`), the elapsed-time bound (Req 15.3 → `stopped_time_limit`), and
 * the step bound (Req 15.2 → `stopped_step_limit`). After a tool step it checks
 * the accumulated cost against the budget cap (Req 15.4 → `stopped_budget_cap`).
 * A run therefore never exceeds 50 steps, 10 minutes, or its budget cap, and its
 * final status names the specific limit that stopped it.
 *
 * ## Non-throwing step outcomes
 *
 * A denied tool, invalid input, an unknown tool, a withheld approval, or a tool
 * handler that throws are all recorded as ordinary steps with the matching
 * {@link AgentStepOutcome} (and `denied: true` for an Allow_List denial,
 * Req 16.3) — never exceptions — so the model can observe the failure and adapt
 * (Req 15.6). Only a structurally invalid run input throws, as a fail-closed
 * {@link InvalidAgentRunError}.
 *
 * ## Reconciled totals (Req 15.9, Property 35)
 *
 * Each tool step carries the tokens, cost, and duration attributed to it; on
 * finish the run's `totalSteps`/`totalTokens`/`totalCost`/`totalDurationMs` are
 * exactly the aggregation over the recorded steps, so the totals always
 * reconcile.
 *
 * Every external effect is an injectable port, so the runtime is fully
 * unit-testable with the fakes in `./fakes.js` — no real model, tools, clock, or
 * transport.
 */

import { InvalidAgentRunError } from './errors.js';
import {
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_MAX_STEPS,
  type AgentApprovalPort,
  type AgentCancellation,
  type AgentClock,
  type AgentDefinition,
  type AgentEventSink,
  type AgentIdGenerator,
  type AgentModelPort,
  type AgentModelResponse,
  type AgentObservation,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunStatus,
  type AgentStepOutcome,
  type AgentStepRecord,
  type AgentToolCall,
  type AgentToolDispatcher,
  type Principal,
  type SafetyLimits,
} from './types.js';

/** The default {@link AgentClock}, backed by the global `Date.now`. */
export const systemAgentClock: AgentClock = { now: () => Date.now() };

/** A monotonically increasing default id generator (`agent-1`, `agent-2`, …) for non-test use. */
function defaultIdGenerator(): AgentIdGenerator {
  let counter = 0;
  return () => `agent-${(counter += 1)}`;
}

/** Construction dependencies for the {@link AgentRuntime}. */
export interface AgentRuntimeOptions {
  /** The model seam that plans each next action (Req 15.1). */
  model: AgentModelPort;
  /** The Tool_Registry surface tools are gated and dispatched through (Req 16.2, 16.3). */
  tools: AgentToolDispatcher;
  /** Clock for step durations and elapsed-time enforcement; defaults to {@link systemAgentClock}. */
  clock?: AgentClock;
  /** Generates run/step ids; defaults to a monotonic generator. */
  idGenerator?: AgentIdGenerator;
  /** Optional real-time event sink (Req 15.7); defaults to a no-op. */
  events?: AgentEventSink;
  /**
   * Optional human-in-the-loop approval gate for destructive actions (Req 15.5).
   * When omitted, every destructive action is denied (fail-closed).
   */
  approval?: AgentApprovalPort;
}

/** Per-run options for {@link AgentRuntime.run}. */
export interface AgentRunOptions {
  /** Optional cooperative cancellation seam (Req 15.8). */
  cancellation?: AgentCancellation;
}

/**
 * Resolve a partial {@link SafetyLimits} into a fully-specified one, applying the
 * defaults for any omitted bound and validating the result (Req 15.2-15.4).
 *
 * @throws {InvalidAgentRunError} when a supplied bound is not a positive number
 *   (`maxSteps`/`maxDurationMs`) or is negative (`budgetCap`).
 */
function resolveLimits(partial: Partial<SafetyLimits> | undefined): SafetyLimits {
  const maxSteps = partial?.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxDurationMs = partial?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const budgetCap = partial?.budgetCap ?? Number.POSITIVE_INFINITY;

  if (!Number.isFinite(maxSteps) || maxSteps <= 0) {
    throw new InvalidAgentRunError(`maxSteps must be a positive number, got ${maxSteps}`);
  }
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new InvalidAgentRunError(
      `maxDurationMs must be a positive number, got ${maxDurationMs}`,
    );
  }
  if (Number.isNaN(budgetCap) || budgetCap < 0) {
    throw new InvalidAgentRunError(`budgetCap must be a non-negative number, got ${budgetCap}`);
  }
  return { maxSteps, maxDurationMs, budgetCap };
}

/** Validate the structural preconditions of a run input (Req 15.1). */
function assertValidInput(input: AgentRunInput): void {
  if (input === null || typeof input !== 'object') {
    throw new InvalidAgentRunError('run input must be an object');
  }
  const agent = input.agent as AgentDefinition | undefined;
  if (agent === null || typeof agent !== 'object') {
    throw new InvalidAgentRunError('run input must carry an agent definition');
  }
  if (typeof agent.id !== 'string' || agent.id.length === 0) {
    throw new InvalidAgentRunError('agent.id must be a non-empty string');
  }
  if (typeof agent.model !== 'string' || agent.model.length === 0) {
    throw new InvalidAgentRunError('agent.model must be a non-empty string');
  }
  if (typeof agent.systemPrompt !== 'string') {
    throw new InvalidAgentRunError('agent.systemPrompt must be a string');
  }
  if (!Array.isArray(agent.allowedTools)) {
    throw new InvalidAgentRunError('agent.allowedTools must be an array of tool ids');
  }
  if (typeof input.task !== 'string' || input.task.length === 0) {
    throw new InvalidAgentRunError('run input must carry a non-empty task');
  }
}

/** Project a recorded step into the observation fed back to the model. */
function toObservation(step: AgentStepRecord): AgentObservation {
  const observation: AgentObservation = {
    stepNumber: step.stepNumber,
    toolId: step.tool,
    input: step.input,
    output: step.output,
    outcome: step.outcome,
  };
  if (step.error !== undefined) {
    observation.error = step.error;
  }
  return observation;
}

/** The model-call usage attributed to a step (total tokens + cost), defaulting to zero. */
function callCost(call: { usage?: { inputTokens: number; outputTokens: number }; cost?: number }): {
  tokens: number;
  cost: number;
} {
  const tokens =
    call.usage !== undefined ? call.usage.inputTokens + call.usage.outputTokens : 0;
  return { tokens, cost: call.cost ?? 0 };
}

/**
 * The Agent_Runtime. Construct once with its ports, then call {@link AgentRuntime.run}
 * with a run input and the acting {@link Principal}.
 */
export class AgentRuntime {
  private readonly model: AgentModelPort;
  private readonly tools: AgentToolDispatcher;
  private readonly clock: AgentClock;
  private readonly newId: AgentIdGenerator;
  private readonly events: AgentEventSink | undefined;
  private readonly approval: AgentApprovalPort | undefined;

  constructor(options: AgentRuntimeOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.clock = options.clock ?? systemAgentClock;
    this.newId = options.idGenerator ?? defaultIdGenerator();
    this.events = options.events;
    this.approval = options.approval;
  }

  /**
   * Execute an agent over a task to completion or the first safety limit
   * (Req 15.1-15.9).
   *
   * Loops plan → act → observe → iterate: each turn asks the model for the next
   * action, dispatches any tool through the Allow_List/schema/approval gates,
   * records a complete step (Req 15.6) emitted in real time (Req 15.7), and
   * feeds the observation back — until the model returns a final answer
   * (`completed`) or cancellation / the time / step / budget bound terminates the
   * run with the matching status (Req 15.2-15.4, 15.8, Property 34). Returns the
   * structured result whose totals reconcile over the recorded steps (Req 15.9,
   * Property 35).
   *
   * @param input The agent definition and task to run.
   * @param principal The authenticated actor the run executes for.
   * @param options Optional per-run cancellation seam (Req 15.8).
   * @returns The completed {@link AgentRunResult}.
   * @throws {InvalidAgentRunError} when the run input is structurally invalid (Req 15.1).
   */
  async run(
    input: AgentRunInput,
    principal: Principal,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    assertValidInput(input);
    const limits = resolveLimits(input.agent.safetyLimits);
    const { agent, task } = input;
    const destructive = new Set(agent.destructiveTools ?? []);

    const runId = this.newId();
    const startedAt = this.clock.now();
    const steps: AgentStepRecord[] = [];
    const observations: AgentObservation[] = [];

    await this.emit({ type: 'run_started', runId, agentId: agent.id });

    let status: AgentRunStatus = 'completed';
    let answer: string | null = null;
    let stoppedReason: string | undefined;
    let accumulatedCost = 0;

    // The loop is bounded by the step limit, but every termination boundary is
    // checked explicitly at the first iteration it could trigger (Property 34).
    for (;;) {
      // Req 15.8: cancellation is honored at the top of every iteration.
      if (options.cancellation?.isCancelled() === true) {
        status = 'cancelled';
        stoppedReason = 'the run was cancelled';
        break;
      }
      // Req 15.3: stop at the time limit before starting another turn.
      if (this.clock.now() - startedAt >= limits.maxDurationMs) {
        status = 'stopped_time_limit';
        stoppedReason = `reached the time limit of ${limits.maxDurationMs}ms`;
        break;
      }
      // Req 15.2: stop at the step limit before starting another turn.
      if (steps.length >= limits.maxSteps) {
        status = 'stopped_step_limit';
        stoppedReason = `reached the step limit of ${limits.maxSteps} steps`;
        break;
      }

      // plan: ask the model for the next action.
      let decision: AgentModelResponse;
      try {
        decision = await this.model.decide({
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          task,
          observations: observations.map((o) => ({ ...o })),
          principal,
        });
      } catch (error) {
        status = 'failed';
        stoppedReason = error instanceof Error ? error.message : String(error);
        break;
      }

      if (decision.kind === 'final') {
        // done: the model returned a terminal answer (Req 15.1).
        status = 'completed';
        answer = decision.answer;
        break;
      }

      // act + observe: dispatch the tool through the gates and record a step.
      const stepNumber = steps.length + 1;
      const step = await this.executeToolStep(runId, stepNumber, decision, agent, destructive, principal);
      steps.push(step);
      observations.push(toObservation(step));
      await this.emit({ type: 'step_recorded', runId, step });

      accumulatedCost += step.cost;
      // Req 15.4: stop at the budget cap once a step has pushed cost to/over it.
      if (accumulatedCost >= limits.budgetCap) {
        status = 'stopped_budget_cap';
        stoppedReason = `reached the budget cap of ${limits.budgetCap}`;
        break;
      }
    }

    const result = this.finalize(runId, agent.id, status, answer, steps, stoppedReason);
    await this.emit({ type: 'run_finished', runId, status, result });
    return result;
  }

  /**
   * Gate and dispatch one tool call, returning the complete step record (Req
   * 15.6, 16.2, 16.3). Never throws: a denial, invalid input, unknown tool,
   * withheld approval, or a handler error is captured as the step's outcome.
   */
  private async executeToolStep(
    runId: string,
    stepNumber: number,
    call: AgentToolCall,
    agent: AgentDefinition,
    destructive: Set<string>,
    principal: Principal,
  ): Promise<AgentStepRecord> {
    const startedAt = this.clock.now();
    const { tokens, cost } = callCost(call);

    const base = {
      id: this.newId(),
      runId,
      stepNumber,
      tool: call.toolId,
      input: call.input,
      tokens,
      cost,
    } as const;

    const finish = (
      outcome: AgentStepOutcome,
      output: unknown,
      denied: boolean,
      error?: string,
    ): AgentStepRecord => {
      const durationMs = Math.max(0, this.clock.now() - startedAt);
      const record: AgentStepRecord = { ...base, output, durationMs, denied, outcome };
      if (error !== undefined) {
        record.error = error;
      }
      return record;
    };

    // Unknown tool: the model named a tool that is not registered.
    if (!this.tools.has(call.toolId)) {
      return finish(
        'unknown_tool',
        { error: 'unknown_tool', toolId: call.toolId },
        false,
        `no tool is registered under id "${call.toolId}"`,
      );
    }

    // Req 16.3: Allow_List gate. A non-allow-listed tool is denied and recorded
    // (denied: true) — it never runs.
    if (!this.tools.isAllowed(call.toolId, agent.allowedTools)) {
      return finish(
        'denied',
        { error: 'tool_not_allowed', toolId: call.toolId },
        true,
        `tool "${call.toolId}" is not on the agent's Allow_List`,
      );
    }

    // Req 16.2: schema validation. Invalid arguments are recorded — the tool
    // never runs.
    const validation = this.tools.validateInput(call.toolId, call.input);
    if (!validation.valid) {
      return finish(
        'invalid_input',
        { error: 'invalid_input', violations: validation.errors },
        false,
        `input for tool "${call.toolId}" failed validation`,
      );
    }

    // Req 15.5: human-in-the-loop approval for destructive actions. Fail-closed:
    // no approval port ⇒ the action is denied.
    if (destructive.has(call.toolId)) {
      const approved =
        this.approval !== undefined &&
        (await this.approval.requestApproval({
          runId,
          stepNumber,
          toolId: call.toolId,
          input: call.input,
        }));
      if (approved !== true) {
        return finish(
          'approval_denied',
          { error: 'approval_denied', toolId: call.toolId },
          false,
          `human approval was not granted for destructive tool "${call.toolId}"`,
        );
      }
    }

    // Dispatch the validated, allow-listed (and, if destructive, approved) tool.
    try {
      const output = await this.tools.invoke(call.toolId, call.input, agent.allowedTools, {
        principal,
        runId,
        stepNumber,
      });
      return finish('ok', output, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finish('error', { error: 'tool_error', message }, false, message);
    }
  }

  /** Build the final {@link AgentRunResult} with totals reconciled over steps (Req 15.9). */
  private finalize(
    runId: string,
    agentId: string,
    status: AgentRunStatus,
    answer: string | null,
    steps: AgentStepRecord[],
    stoppedReason: string | undefined,
  ): AgentRunResult {
    const totals = steps.reduce(
      (acc, step) => {
        acc.tokens += step.tokens;
        acc.cost += step.cost;
        acc.durationMs += step.durationMs;
        return acc;
      },
      { tokens: 0, cost: 0, durationMs: 0 },
    );

    const result: AgentRunResult = {
      runId,
      agentId,
      status,
      answer: status === 'completed' ? answer : null,
      steps,
      totalSteps: steps.length,
      totalTokens: totals.tokens,
      totalCost: totals.cost,
      totalDurationMs: totals.durationMs,
    };
    if (stoppedReason !== undefined) {
      result.stoppedReason = stoppedReason;
    }
    return result;
  }

  /** Emit a run event to the sink when one is configured (Req 15.7); a no-op otherwise. */
  private async emit(event: Parameters<AgentEventSink['emit']>[0]): Promise<void> {
    if (this.events !== undefined) {
      await this.events.emit(event);
    }
  }
}
