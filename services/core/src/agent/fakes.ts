/**
 * Test fakes, builders, and sample tools for the Agent_Runtime (Req 15.1-15.9,
 * 16.2, 16.3).
 *
 * The runtime composes several injected ports; these in-memory doubles let unit
 * and property tests drive the loop deterministically — with no real model,
 * tools, clock, or transport — and inspect what was planned, dispatched,
 * recorded, and emitted:
 *
 *   - {@link ScriptedModelPort} returns a pre-scripted sequence of
 *     {@link AgentModelResponse}s (tool calls then a final answer), so a test can
 *     drive the no-tool, single-tool, denied, invalid-args, and iteration-limit
 *     scenarios exactly. Every request it received is captured in {@link ScriptedModelPort.requests}.
 *   - {@link makeAgent} builds an {@link AgentDefinition} with sensible defaults
 *     (an Allow_List of all sample tools) overridable field-by-field.
 *   - {@link sampleAgentRegistry} returns a real {@link ToolRegistry} preloaded
 *     with the Tool_Registry's {@link SAMPLE_TOOLS}, which structurally satisfies
 *     {@link AgentToolDispatcher}.
 *   - {@link FakeAgentClock} returns preset timestamps so step durations and the
 *     elapsed-time bound are exact; {@link sequentialAgentIdGenerator} hands out
 *     `id-1`, `id-2`, … for assertion-friendly ids.
 *   - {@link CapturingAgentEventSink} records every emitted {@link AgentRunEvent}
 *     (Req 15.7); {@link FixedApprovalPort} allows/denies every destructive
 *     action (Req 15.5); {@link FixedCancellation} models a cancel signal
 *     (Req 15.8).
 *   - {@link makePrincipal} is re-exported from the Access_Control fakes so the
 *     runtime is tested against the same acting-principal double as the rest of
 *     the suite.
 *
 * Import these directly from `./fakes.js` in tests, never from a package barrel.
 */

import { ToolRegistry } from '../tools/index.js';
import { SAMPLE_TOOLS } from '../tools/fakes.js';

import type {
  AgentApprovalPort,
  AgentApprovalRequest,
  AgentCancellation,
  AgentClock,
  AgentDefinition,
  AgentEventSink,
  AgentIdGenerator,
  AgentModelPort,
  AgentModelRequest,
  AgentModelResponse,
  AgentRunEvent,
  SafetyLimits,
} from './types.js';

export { makePrincipal } from '../access/fakes.js';
export { ToolRegistry } from '../tools/index.js';
export { SAMPLE_TOOLS, makeTool } from '../tools/fakes.js';

/**
 * A {@link AgentModelPort} that replays a fixed script of decisions.
 *
 * Each call to {@link decide} returns the next entry of `script`, in order; once
 * the script is exhausted it returns the configured fallback (a `final` answer
 * by default), so a test never runs off the end. Every request the runtime made
 * is captured in {@link requests}, so a test can assert that prior observations
 * were fed back to the model (Req 15.1, observe → iterate).
 */
export class ScriptedModelPort implements AgentModelPort {
  /** Every request the runtime issued, in order. */
  readonly requests: AgentModelRequest[] = [];
  private index = 0;

  /**
   * @param script The ordered decisions to return on successive calls.
   * @param fallback The decision returned once the script is exhausted
   *   (defaults to a terminal final answer so the loop always ends).
   */
  constructor(
    private readonly script: readonly AgentModelResponse[],
    private readonly fallback: AgentModelResponse = { kind: 'final', answer: 'done' },
  ) {}

  decide(request: AgentModelRequest): AgentModelResponse {
    // Defensive copy of observations so a later mutation cannot rewrite history.
    this.requests.push({ ...request, observations: request.observations.map((o) => ({ ...o })) });
    const next = this.script[this.index];
    this.index += 1;
    return next ?? this.fallback;
  }

  /** The number of times the model was consulted. */
  get callCount(): number {
    return this.requests.length;
  }
}

/**
 * A {@link AgentModelPort} that always asks to call the same tool with the same
 * input — useful for driving the runtime into the step limit (Req 15.2).
 */
export class LoopingToolModelPort implements AgentModelPort {
  /** Every request the runtime issued, in order. */
  readonly requests: AgentModelRequest[] = [];

  constructor(
    private readonly toolId: string,
    private readonly input: unknown,
    private readonly cost = 0,
  ) {}

  decide(request: AgentModelRequest): AgentModelResponse {
    this.requests.push({ ...request, observations: request.observations.map((o) => ({ ...o })) });
    return { kind: 'tool_call', toolId: this.toolId, input: this.input, cost: this.cost };
  }

  /** The number of times the model was consulted. */
  get callCount(): number {
    return this.requests.length;
  }
}

/** Options for {@link makeAgent}; every field overrides a sensible default. */
export interface MakeAgentOptions {
  /** Agent id (defaults to `agent-1`). */
  id?: string;
  /** System prompt (defaults to a generic instruction). */
  systemPrompt?: string;
  /** Allow_List of tool ids (defaults to every {@link SAMPLE_TOOLS} id). */
  allowedTools?: string[];
  /** Model id (defaults to `model-standard`). */
  model?: string;
  /** Partial safety limits (merged over the runtime defaults). */
  safetyLimits?: Partial<SafetyLimits>;
  /** Destructive tool ids requiring approval (defaults to none). */
  destructiveTools?: string[];
}

/** The ids of every Tool_Registry sample tool, for a permissive default Allow_List. */
export const SAMPLE_TOOL_IDS: readonly string[] = SAMPLE_TOOLS.map((t) => t.id);

/**
 * Build an {@link AgentDefinition} with deterministic defaults, overridable
 * field-by-field. By default the agent may use every sample tool.
 */
export function makeAgent(options: MakeAgentOptions = {}): AgentDefinition {
  const agent: AgentDefinition = {
    id: options.id ?? 'agent-1',
    systemPrompt: options.systemPrompt ?? 'You are a helpful autonomous agent.',
    allowedTools: options.allowedTools ?? [...SAMPLE_TOOL_IDS],
    model: options.model ?? 'model-standard',
  };
  if (options.safetyLimits !== undefined) {
    agent.safetyLimits = options.safetyLimits;
  }
  if (options.destructiveTools !== undefined) {
    agent.destructiveTools = options.destructiveTools;
  }
  return agent;
}

/** A real {@link ToolRegistry} preloaded with the Tool_Registry sample tools. */
export function sampleAgentRegistry(): ToolRegistry {
  return new ToolRegistry(SAMPLE_TOOLS);
}

/**
 * A {@link AgentClock} returning preset timestamps (the last value repeats once
 * exhausted), so step durations and the elapsed-time bound are exact, asserted
 * numbers regardless of real elapsed time.
 */
export class FakeAgentClock implements AgentClock {
  private index = 0;

  constructor(private readonly times: number[] = [0]) {}

  now(): number {
    const value = this.times[Math.min(this.index, this.times.length - 1)] ?? 0;
    this.index += 1;
    return value;
  }
}

/**
 * A {@link AgentClock} that advances by a fixed step on every read, starting
 * from `start`. Convenient when a test only needs monotonic, evenly-spaced time
 * without enumerating each tick.
 */
export class SteppingAgentClock implements AgentClock {
  private current: number;

  constructor(
    start = 0,
    private readonly step = 1,
  ) {
    this.current = start;
  }

  now(): number {
    const value = this.current;
    this.current += this.step;
    return value;
  }
}

/** A deterministic id generator handing out `id-1`, `id-2`, … for assertion-friendly tests. */
export function sequentialAgentIdGenerator(): AgentIdGenerator {
  let counter = 0;
  return () => `id-${(counter += 1)}`;
}

/** A capturing {@link AgentEventSink} that records every emitted event (Req 15.7). */
export class CapturingAgentEventSink implements AgentEventSink {
  /** Every emitted event, in order. */
  readonly events: AgentRunEvent[] = [];

  emit(event: AgentRunEvent): void {
    this.events.push(event);
  }

  /** Every event of the given type, in order. */
  ofType<T extends AgentRunEvent['type']>(type: T): Array<Extract<AgentRunEvent, { type: T }>> {
    return this.events.filter((e) => e.type === type) as Array<
      Extract<AgentRunEvent, { type: T }>
    >;
  }
}

/**
 * An {@link AgentApprovalPort} that allows or denies every destructive action
 * with a fixed verdict, recording each request (Req 15.5).
 */
export class FixedApprovalPort implements AgentApprovalPort {
  /** Every approval request received, in order. */
  readonly requests: AgentApprovalRequest[] = [];

  constructor(private readonly verdict: boolean) {}

  requestApproval(request: AgentApprovalRequest): boolean {
    this.requests.push(request);
    return this.verdict;
  }
}

/**
 * An {@link AgentCancellation} that flips to cancelled after a fixed number of
 * checks, so a test can cancel a run mid-flight deterministically (Req 15.8).
 */
export class FixedCancellation implements AgentCancellation {
  private checks = 0;

  /**
   * @param cancelAfter The number of `isCancelled` checks to return `false`
   *   before flipping to `true` (0 cancels immediately).
   */
  constructor(private readonly cancelAfter: number) {}

  isCancelled(): boolean {
    const cancelled = this.checks >= this.cancelAfter;
    this.checks += 1;
    return cancelled;
  }
}
