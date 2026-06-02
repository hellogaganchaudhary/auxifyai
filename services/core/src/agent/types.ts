/**
 * Domain types and injected ports for the Agent_Runtime (Req 15.1-15.9, 16.3).
 *
 * The Agent_Runtime executes an agent autonomously: it loops
 * **plan → act → observe → iterate** (Req 15.1) — calling the model to decide
 * the next action, dispatching any requested tool through the Tool_Registry,
 * recording the result as a step, and feeding that observation back to the
 * model — until the model returns a terminal answer or a safety limit is
 * reached (Req 15.2-15.4). Every step records its number, the tool used, the
 * tool input, the tool output, and its duration (Req 15.6); on finish the run
 * records a final status plus totals that reconcile over the recorded steps
 * (Req 15.9).
 *
 * This module is the type/contract surface; {@link import('./agent-runtime.js').AgentRuntime}
 * is the implementation. Every external effect the runtime needs is a narrow,
 * injectable port so the runtime is fully unit-testable with fakes and has no
 * runtime coupling beyond `@auxify/types` and the Tool_Registry:
 *
 *   - {@link AgentModelPort} — the model seam that plans the next action,
 *     returning either an {@link AgentToolCall} or an {@link AgentFinalAnswer}.
 *   - {@link AgentToolDispatcher} — the read/gate/dispatch surface of the
 *     Tool_Registry the runtime composes (`ToolRegistry` satisfies it
 *     structurally): `has`/`isAllowed`/`validateInput`/`invoke` (Req 16.2, 16.3).
 *   - {@link AgentClock} / {@link AgentIdGenerator} — the deterministic time and
 *     id seams (renamed from the Model_Router's `Clock`/`systemClock` so the
 *     package barrel never collides).
 *   - {@link AgentEventSink} — the optional real-time step-event seam (Req 15.7).
 *   - {@link AgentCancellation} — the optional cooperative cancel seam (Req 15.8).
 *   - {@link AgentApprovalPort} — the optional human-in-the-loop gate for
 *     destructive actions (Req 15.5).
 */

import type { Principal, TokenUsage } from '@auxify/types';

import type { ToolInvocationContext, ToolValidationResult } from '../tools/index.js';

/**
 * The default per-run safety limits (Req 15.2, 15.3).
 *
 * A run stops at 50 tool steps (Req 15.2) and at 10 minutes of execution
 * (Req 15.3). The budget cap has no universal default — it is a per-agent
 * configuration (Req 15.4) — so when unspecified it defaults to
 * {@link Number.POSITIVE_INFINITY} (no budget limit).
 */
export const DEFAULT_MAX_STEPS = 50 as const;
/** The default maximum wall-clock duration of a run: 10 minutes (Req 15.3). */
export const DEFAULT_MAX_DURATION_MS = 600_000 as const;

/**
 * The per-run safety limits enforced by the {@link import('./agent-runtime.js').AgentRuntime}
 * (Req 15.2, 15.3, 15.4).
 *
 * Each bound, when reached, terminates the run with a status that names the
 * specific limit (Property 34): {@link maxSteps} → `stopped_step_limit`,
 * {@link maxDurationMs} → `stopped_time_limit`, {@link budgetCap} →
 * `stopped_budget_cap`.
 */
export interface SafetyLimits {
  /** Maximum number of tool steps before the run stops at the step limit (Req 15.2). */
  maxSteps: number;
  /** Maximum wall-clock duration in milliseconds before the run stops at the time limit (Req 15.3). */
  maxDurationMs: number;
  /** Maximum accumulated cost before the run stops at the budget cap (Req 15.4). */
  budgetCap: number;
}

/**
 * The configuration of the agent a run executes (the runtime's view of the
 * design's `Agent`, Req 16.4, 16.5).
 *
 * `allowedTools` is the Allow_List the runtime gates every tool invocation
 * against (Req 16.3); `destructiveTools` is the subset whose invocation must be
 * approved by a human before it runs (Req 15.5). `safetyLimits` may be partially
 * specified — the runtime fills in {@link DEFAULT_MAX_STEPS} /
 * {@link DEFAULT_MAX_DURATION_MS} / an infinite budget for any omitted bound.
 */
export interface AgentDefinition {
  /** The agent's stable id, recorded on the run. */
  id: string;
  /** The system prompt prepended to every model call (the agent's instructions). */
  systemPrompt: string;
  /** The Allow_List of tool ids the agent may invoke (Req 16.3). */
  allowedTools: string[];
  /** The model id the runtime asks {@link AgentModelPort} to plan with. */
  model: string;
  /** The per-run safety limits; omitted bounds fall back to the defaults (Req 15.2-15.4). */
  safetyLimits?: Partial<SafetyLimits>;
  /**
   * The subset of {@link allowedTools} considered destructive: invoking one
   * pauses for human approval through the {@link AgentApprovalPort} before it
   * runs (Req 15.5). Tools not listed here run without approval.
   */
  destructiveTools?: string[];
}

/**
 * A single task submitted to the runtime for an agent to accomplish (Req 15.1).
 *
 * `task` is the natural-language goal handed to the model as the first thing to
 * act on; the runtime carries it on every model call so the model always sees
 * the objective alongside the accumulated {@link AgentObservation}s.
 */
export interface AgentRunInput {
  /** The agent configuration to execute. */
  agent: AgentDefinition;
  /** The task/goal the agent should accomplish. */
  task: string;
}

/**
 * The model's decision for the next action: invoke a tool (Req 15.1, act).
 *
 * `toolId`/`input` name the tool to call and its arguments (validated and
 * Allow_List-gated by the runtime before dispatch, Req 16.2/16.3). `usage`/`cost`
 * are the model call's reported consumption; the runtime attributes them to the
 * step this decision produces so the run totals reconcile over steps (Req 15.9,
 * Property 35).
 */
export interface AgentToolCall {
  /** Discriminant: the model wants to call a tool. */
  kind: 'tool_call';
  /** The id of the tool to invoke. */
  toolId: string;
  /** The arguments to pass to the tool (validated before dispatch, Req 16.2). */
  input: unknown;
  /** Token usage of the model call that produced this decision, when reported. */
  usage?: TokenUsage;
  /** Cost of the model call that produced this decision, when reported. */
  cost?: number;
}

/**
 * The model's decision to terminate with a final answer (Req 15.1).
 *
 * Returning this ends the loop with a `completed` status and the `answer` as the
 * run's result. A final answer does not produce a tool step, so its `usage`/`cost`
 * (when reported) are surfaced on the result for observability but are not part
 * of the step-reconciled run totals (Req 15.9, Property 35).
 */
export interface AgentFinalAnswer {
  /** Discriminant: the model is done and is returning the final answer. */
  kind: 'final';
  /** The terminal answer to the task. */
  answer: string;
  /** Token usage of the final model call, when reported. */
  usage?: TokenUsage;
  /** Cost of the final model call, when reported. */
  cost?: number;
}

/** The model's next-action decision: a tool call (act) or a final answer (done). */
export type AgentModelResponse = AgentToolCall | AgentFinalAnswer;

/**
 * The request handed to the {@link AgentModelPort} on each planning turn.
 *
 * It carries the agent's `model` and `systemPrompt`, the `task`, and the ordered
 * {@link AgentObservation}s accumulated so far — the observations are how the
 * loop "feeds the result back" to the model (Req 15.1, observe → iterate) so the
 * next decision can build on prior tool outputs.
 */
export interface AgentModelRequest {
  /** The model id to plan with (from the agent definition). */
  model: string;
  /** The agent's system prompt / instructions. */
  systemPrompt: string;
  /** The task/goal being accomplished. */
  task: string;
  /** The ordered observations from prior steps, fed back to the model. */
  observations: AgentObservation[];
  /** The authenticated actor the run executes for (a production model port routes with it). */
  principal: Principal;
}

/**
 * The model seam the runtime calls each turn to plan the next action (Req 15.1).
 *
 * A production implementation wraps the Model_Router (composing the agent's
 * model, system prompt, task, and observations into a {@link ChatRequest} and
 * mapping the model's tool-call / final-answer reply onto {@link AgentModelResponse}).
 * A fake returns scripted decisions so the loop is unit-testable without a real
 * provider.
 */
export interface AgentModelPort {
  /**
   * Decide the next action given the conversation so far.
   *
   * @param request The model, prompt, task, and accumulated observations.
   * @returns A tool call to dispatch, or the final answer that ends the run.
   */
  decide(request: AgentModelRequest): AgentModelResponse | Promise<AgentModelResponse>;
}

/**
 * The Tool_Registry surface the runtime composes to gate and dispatch tools
 * (Req 16.2, 16.3).
 *
 * `ToolRegistry` satisfies this structurally; tests substitute the same
 * registry preloaded with sample tools. The runtime uses the four operations to
 * implement its own fine-grained step recording: {@link has} to detect an
 * unknown tool, {@link isAllowed} to gate on the agent's Allow_List (Req 16.3),
 * {@link validateInput} to validate arguments (Req 16.2), and {@link invoke} to
 * dispatch an allow-listed, valid call.
 */
export interface AgentToolDispatcher {
  /** Whether a tool is registered under `toolId`. */
  has(toolId: string): boolean;
  /** Whether `toolId` is permitted by `allowList` (fail-closed, Req 16.3). */
  isAllowed(toolId: string, allowList: readonly string[]): boolean;
  /** Validate an invocation's input against the tool's schema (Req 16.2). */
  validateInput(toolId: string, input: unknown): ToolValidationResult;
  /**
   * Dispatch a validated, allow-listed invocation (Req 16.2, 16.3).
   *
   * @returns The tool handler's result.
   */
  invoke(
    toolId: string,
    input: unknown,
    allowList: readonly string[],
    context?: ToolInvocationContext,
  ): Promise<unknown>;
}

/**
 * A monotonic wall clock, injectable so step durations and the run's elapsed
 * time are deterministic in tests (Req 15.3, 15.6).
 *
 * Named distinctly from the Model_Router's `Clock` so both can be re-exported
 * from the package barrel without colliding.
 */
export interface AgentClock {
  /** The current time in milliseconds (epoch or any consistent origin). */
  now(): number;
}

/** Generates unique ids for the run and its steps; injectable for deterministic tests. */
export type AgentIdGenerator = () => string;

/**
 * The terminal status of an agent run (the design's `AgentRun.status` minus the
 * transient `running`, Req 15.2-15.4, 15.8, 15.9).
 *
 * `completed` — the model returned a final answer. `cancelled` — the caller
 * cancelled the run (Req 15.8). The three `stopped_*` statuses each name the
 * specific safety limit that terminated the run (Property 34): the step limit
 * (Req 15.2), the time limit (Req 15.3), or the budget cap (Req 15.4). `failed`
 * — the model port raised an unexpected error.
 */
export type AgentRunStatus =
  | 'completed'
  | 'cancelled'
  | 'stopped_step_limit'
  | 'stopped_time_limit'
  | 'stopped_budget_cap'
  | 'failed';

/**
 * The outcome of a single tool step (Req 16.2, 16.3).
 *
 *  - `ok` — the tool was allow-listed, its input was valid, and it executed.
 *  - `denied` — the tool was not on the agent's Allow_List; it never ran and the
 *    denial is recorded (Req 16.3). The step's {@link AgentStepRecord.denied} is
 *    `true` exactly for this outcome.
 *  - `invalid_input` — the input failed the tool's schema; it never ran (Req 16.2).
 *  - `unknown_tool` — the model named a tool that is not registered; it never ran.
 *  - `approval_denied` — a destructive tool's human approval was withheld (Req 15.5);
 *    it never ran.
 *  - `error` — the tool was dispatched but its handler threw.
 */
export type AgentStepOutcome =
  | 'ok'
  | 'denied'
  | 'invalid_input'
  | 'unknown_tool'
  | 'approval_denied'
  | 'error';

/**
 * A complete record of one executed (or attempted) tool step (Req 15.6, 16.3).
 *
 * Records exactly the facts Req 15.6 enumerates — `stepNumber`, the `tool` used,
 * the tool `input`, the tool `output`, and the step `durationMs` — plus the
 * {@link AgentStepOutcome} and the model-call `tokens`/`cost` that produced the
 * step, so the run totals reconcile as the sum over steps (Req 15.9,
 * Property 35). `denied` is the design's `AgentStep.denied`, set `true` only for
 * an Allow_List denial (Req 16.3).
 */
export interface AgentStepRecord {
  /** The step's unique id. */
  id: string;
  /** The run this step belongs to. */
  runId: string;
  /** The 1-based position of the step within the run (Req 15.6). */
  stepNumber: number;
  /** The tool the step invoked (or attempted to invoke) (Req 15.6). */
  tool: string;
  /** The tool input the model supplied (Req 15.6). */
  input: unknown;
  /** The tool output, or a structured denial/validation/error payload (Req 15.6). */
  output: unknown;
  /** The step's duration in milliseconds (Req 15.6). */
  durationMs: number;
  /** Whether the step was an Allow_List denial (Req 16.3). */
  denied: boolean;
  /** The step's outcome classification. */
  outcome: AgentStepOutcome;
  /** Total model-call tokens attributed to this step (for reconciliation, Req 15.9). */
  tokens: number;
  /** Cost attributed to this step (for reconciliation and budget enforcement, Req 15.9, 15.4). */
  cost: number;
  /** A human-readable failure detail, present for `invalid_input`/`unknown_tool`/`error`. */
  error?: string;
}

/**
 * An observation fed back to the model after a step (Req 15.1, observe).
 *
 * Mirrors the salient fields of the {@link AgentStepRecord} the model needs to
 * decide its next action: which tool ran, with what input, what it produced, and
 * how it turned out.
 */
export interface AgentObservation {
  /** The step number this observation came from. */
  stepNumber: number;
  /** The tool that was invoked (or attempted). */
  toolId: string;
  /** The input that was supplied. */
  input: unknown;
  /** The tool output, or the denial/validation/error payload. */
  output: unknown;
  /** The outcome of the step. */
  outcome: AgentStepOutcome;
  /** A failure detail, when the step did not succeed. */
  error?: string;
}

/**
 * The structured result of a completed agent run (Req 15.9).
 *
 * Carries the terminal {@link AgentRunStatus}, the final `answer` (present only
 * when `completed`), the ordered {@link steps}, and the reconciled totals: the
 * total step count, total tokens, total cost, and total duration — each the
 * aggregation over {@link steps} (Req 15.9, Property 35). `stoppedReason` is a
 * human-readable explanation when the run did not complete normally.
 */
export interface AgentRunResult {
  /** The run's unique id. */
  runId: string;
  /** The agent that was executed. */
  agentId: string;
  /** The terminal status of the run. */
  status: AgentRunStatus;
  /** The final answer when `status === 'completed'`, otherwise `null`. */
  answer: string | null;
  /** The ordered steps the run recorded (Req 15.6). */
  steps: AgentStepRecord[];
  /** The total number of recorded steps (Req 15.9). */
  totalSteps: number;
  /** The sum of every step's tokens (Req 15.9, reconciles over steps). */
  totalTokens: number;
  /** The sum of every step's cost (Req 15.9, reconciles over steps). */
  totalCost: number;
  /** The sum of every step's duration in milliseconds (Req 15.9, reconciles over steps). */
  totalDurationMs: number;
  /** A human-readable reason when the run was stopped/cancelled/failed. */
  stoppedReason?: string;
}

/**
 * A real-time event emitted by the runtime as a run progresses (Req 15.7).
 *
 * The runtime emits `run_started` once, a `step_recorded` event as each step is
 * recorded (the in-progress, real-time signal of Req 15.7), and `run_finished`
 * once with the terminal status and full {@link AgentRunResult}.
 */
export type AgentRunEvent =
  | { type: 'run_started'; runId: string; agentId: string }
  | { type: 'step_recorded'; runId: string; step: AgentStepRecord }
  | { type: 'run_finished'; runId: string; status: AgentRunStatus; result: AgentRunResult };

/**
 * The optional sink the runtime emits {@link AgentRunEvent}s to in real time
 * (Req 15.7).
 *
 * A transport adapter (the WebSocket_Gateway, task 24.x) implements this to
 * relay step events to the requesting client; in tests a capturing sink records
 * them. Defaults to a no-op when not supplied.
 */
export interface AgentEventSink {
  /** Emit one run event; may be async (the runtime awaits it). */
  emit(event: AgentRunEvent): void | Promise<void>;
}

/**
 * The optional cooperative cancellation seam (Req 15.8).
 *
 * The runtime checks {@link isCancelled} at the top of every loop iteration; a
 * `true` reading stops the run and reports it as `cancelled` (Req 15.8). This
 * models the design's `AgentRuntime.cancel(runId)` for the synchronous
 * run-to-completion path.
 */
export interface AgentCancellation {
  /** Whether the run has been requested to cancel. */
  isCancelled(): boolean;
}

/** The request handed to the {@link AgentApprovalPort} for a destructive action (Req 15.5). */
export interface AgentApprovalRequest {
  /** The run requesting approval. */
  runId: string;
  /** The step number the destructive action would occupy. */
  stepNumber: number;
  /** The destructive tool to be invoked. */
  toolId: string;
  /** The arguments the tool would be invoked with. */
  input: unknown;
}

/**
 * The optional human-in-the-loop approval seam for destructive actions
 * (Req 15.5).
 *
 * When the model requests a tool listed in the agent's `destructiveTools`, the
 * runtime pauses and asks this port; a `false` (or rejected) result withholds
 * approval, so the tool never runs and the step is recorded as `approval_denied`.
 * Defaults to denying every destructive action (fail-closed) when no port is
 * supplied.
 */
export interface AgentApprovalPort {
  /**
   * Decide whether a destructive action may proceed (Req 15.5).
   *
   * @param request The destructive tool and the arguments it would run with.
   * @returns `true` to allow the action, `false` to withhold approval.
   */
  requestApproval(request: AgentApprovalRequest): boolean | Promise<boolean>;
}

/** Re-exported acting-principal type so callers can type the {@link import('./agent-runtime.js').AgentRuntime.run} argument. */
export type { Principal };
