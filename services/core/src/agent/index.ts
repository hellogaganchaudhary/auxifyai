/**
 * Agent_Runtime (Req 15.1-15.9, 16.2, 16.3).
 *
 * The Agent_Runtime executes an agent autonomously over a task, looping
 * **plan → act → observe → iterate** (Req 15.1): it calls the model to decide
 * the next action, dispatches any requested tool through the Tool_Registry —
 * denying a tool not on the agent's Allow_List (Req 16.3) and rejecting input
 * that fails the tool's schema (Req 16.2) — records a complete step for every
 * attempt (step number, tool, input, output, duration — Req 15.6) and emits it
 * in real time (Req 15.7), feeds the observation back to the model, and repeats
 * until the model returns a final answer or a safety limit is reached. The run
 * terminates at the *first* boundary hit — 50 steps (Req 15.2), 10 minutes
 * (Req 15.3), the budget cap (Req 15.4), or a cancellation (Req 15.8) — with a
 * status that names it (Property 34), and destructive actions pause for human
 * approval (Req 15.5). On finish the run's totals reconcile as the aggregation
 * over its recorded steps (Req 15.9, Property 35).
 *
 * It composes the {@link import('../tools/index.js').ToolRegistry} (structurally
 * the {@link AgentToolDispatcher}) for tool gating and dispatch, and reaches the
 * model only through the narrow injectable {@link AgentModelPort} (a production
 * adapter wraps the Model_Router), so the runtime is fully unit-testable with
 * the fakes in `./fakes.js` — no real model, tools, clock, or transport.
 *
 * Surface:
 *   - {@link AgentRuntime} — the runtime (`run`), plus {@link systemAgentClock},
 *     {@link AgentRuntimeOptions}, {@link AgentRunOptions}.
 *   - {@link AgentModelPort} / {@link AgentToolDispatcher} / {@link AgentClock} /
 *     {@link AgentIdGenerator} / {@link AgentEventSink} / {@link AgentCancellation} /
 *     {@link AgentApprovalPort} — the injectable ports it composes.
 *   - {@link AgentDefinition} / {@link AgentRunInput} / {@link SafetyLimits} /
 *     {@link AgentModelRequest} / {@link AgentModelResponse} / {@link AgentToolCall} /
 *     {@link AgentFinalAnswer} — the run input and model-decision shapes.
 *   - {@link AgentStepRecord} / {@link AgentObservation} / {@link AgentRunResult} /
 *     {@link AgentRunEvent} / {@link AgentRunStatus} / {@link AgentStepOutcome} —
 *     the recorded-step, observation, result, and event shapes.
 *   - {@link DEFAULT_MAX_STEPS} / {@link DEFAULT_MAX_DURATION_MS} — the default
 *     safety bounds (Req 15.2, 15.3).
 *   - {@link InvalidAgentRunError} / {@link INVALID_AGENT_RUN_CODE} — the sole
 *     thrown error (a structurally invalid run input), projectable to a
 *     {@link import('@auxify/types').PlatformError} (Req 46.8).
 *
 * Port names are deliberately `Agent`-prefixed ({@link AgentClock},
 * {@link AgentIdGenerator}, …) so they never collide with the Model_Router's
 * `Clock`/`systemClock` at the package barrel.
 */

export {
  AgentRuntime,
  systemAgentClock,
  type AgentRuntimeOptions,
  type AgentRunOptions,
} from './agent-runtime.js';

export {
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_DURATION_MS,
  type SafetyLimits,
  type AgentDefinition,
  type AgentRunInput,
  type AgentToolCall,
  type AgentFinalAnswer,
  type AgentModelResponse,
  type AgentModelRequest,
  type AgentModelPort,
  type AgentToolDispatcher,
  type AgentClock,
  type AgentIdGenerator,
  type AgentRunStatus,
  type AgentStepOutcome,
  type AgentStepRecord,
  type AgentObservation,
  type AgentRunResult,
  type AgentRunEvent,
  type AgentEventSink,
  type AgentCancellation,
  type AgentApprovalRequest,
  type AgentApprovalPort,
} from './types.js';

export { InvalidAgentRunError, INVALID_AGENT_RUN_CODE } from './errors.js';
