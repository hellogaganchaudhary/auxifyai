/**
 * The Tool_Registry (Req 16.1, 16.2, 16.3).
 *
 * {@link ToolRegistry} is the in-memory catalog the Agent_Runtime reads to
 * discover, gate, and dispatch agent tools. It:
 *
 *   - registers {@link ToolDefinition}s across the web/data/code/communication/
 *     document/integration categories (Req 16.1), rejecting a structurally
 *     invalid descriptor ({@link InvalidToolDefinitionError}) or a duplicate id
 *     ({@link DuplicateToolError});
 *   - lists/discovers the registered tools as handler-free {@link ToolDescriptor}s,
 *     optionally filtered by category and/or an Allow_List so an agent sees only
 *     the tools it may invoke (Req 16.1, 16.3);
 *   - resolves a tool by id ({@link UnknownToolError} when absent);
 *   - validates an invocation's arguments against the tool's parameter schema
 *     before dispatch (Req 16.2), via the self-contained {@link validateAgainstSchema};
 *   - exposes an Allow_List gate (`isAllowed`) the Agent_Runtime uses to deny —
 *     and record — a tool that is not on the agent's Allow_List (Req 16.3); and
 *   - dispatches a validated, allow-listed invocation through `invoke`,
 *     enforcing both the Allow_List ({@link ToolNotAllowedError}) and the schema
 *     ({@link ToolInputValidationError}) as fail-closed preconditions.
 *
 * The registry has no external dependency beyond `@auxify/types`; its schema
 * validation is the local subset implemented in `./schema.js`. Insertion order
 * is preserved so listings are deterministic.
 */

import {
  DuplicateToolError,
  InvalidToolDefinitionError,
  ToolInputValidationError,
  ToolNotAllowedError,
  UnknownToolError,
} from './errors.js';
import { validateAgainstSchema } from './schema.js';
import {
  TOOL_CATEGORIES,
  type ToolCategory,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolInvocationContext,
  type ToolListOptions,
  type ToolRegistryContract,
  type ToolValidationResult,
} from './types.js';

/** The set of valid categories, for O(1) membership checks during registration. */
const VALID_CATEGORIES = new Set<ToolCategory>(TOOL_CATEGORIES);

/**
 * Validate a {@link ToolDefinition}'s structure, throwing on the first problem.
 *
 * Guards the invariants the registry relies on: a non-empty string id, present
 * human-readable fields, a known {@link ToolCategory} (Req 16.1), an object
 * `parameters` schema (Req 16.2), and an invokable handler.
 */
function assertValidDefinition(tool: ToolDefinition): void {
  if (tool === null || typeof tool !== 'object') {
    throw new InvalidToolDefinitionError('tool must be an object');
  }
  if (typeof tool.id !== 'string' || tool.id.length === 0) {
    throw new InvalidToolDefinitionError('tool.id must be a non-empty string');
  }
  if (typeof tool.displayName !== 'string' || tool.displayName.length === 0) {
    throw new InvalidToolDefinitionError(`tool "${tool.id}" must have a non-empty displayName`);
  }
  if (typeof tool.description !== 'string') {
    throw new InvalidToolDefinitionError(`tool "${tool.id}" must have a string description`);
  }
  if (!VALID_CATEGORIES.has(tool.category)) {
    throw new InvalidToolDefinitionError(
      `tool "${tool.id}" has an invalid category "${String(tool.category)}"`,
    );
  }
  if (tool.parameters === null || typeof tool.parameters !== 'object') {
    throw new InvalidToolDefinitionError(`tool "${tool.id}" must have an object parameters schema`);
  }
  if (typeof tool.handler !== 'function') {
    throw new InvalidToolDefinitionError(`tool "${tool.id}" must have a callable handler`);
  }
}

/** Project a {@link ToolDefinition} into its handler-free {@link ToolDescriptor}. */
function toDescriptor(tool: ToolDefinition): ToolDescriptor {
  return {
    id: tool.id,
    displayName: tool.displayName,
    description: tool.description,
    category: tool.category,
    parameters: tool.parameters,
  };
}

/**
 * In-memory {@link ToolRegistryContract} (Req 16.1, 16.2, 16.3).
 *
 * Tools are stored in a `Map` keyed by id, preserving registration order for
 * deterministic listings. The registry never exposes its internal handler
 * references through {@link ToolRegistry.list} (only {@link ToolDescriptor}s),
 * so a discovery caller cannot invoke a tool by holding a listing entry.
 */
export class ToolRegistry implements ToolRegistryContract {
  /** Registered tools keyed by id; a Map preserves insertion order for `list()`. */
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * Construct an empty registry, or one preloaded with `tools`.
   *
   * @param tools Optional initial tools to {@link ToolRegistry.register}.
   */
  constructor(tools?: readonly ToolDefinition[]) {
    if (tools !== undefined) {
      for (const tool of tools) {
        this.register(tool);
      }
    }
  }

  /**
   * Register a tool (Req 16.1).
   *
   * @throws {InvalidToolDefinitionError} when the descriptor is structurally invalid.
   * @throws {DuplicateToolError} when a tool is already registered under the id.
   */
  register(tool: ToolDefinition): void {
    assertValidDefinition(tool);
    if (this.tools.has(tool.id)) {
      throw new DuplicateToolError(tool.id);
    }
    this.tools.set(tool.id, tool);
  }

  /**
   * List the registered tools as handler-free {@link ToolDescriptor}s, in
   * registration order (Req 16.1).
   *
   * With no options, every tool is returned. {@link ToolListOptions.category}
   * restricts to one category (Req 16.1); {@link ToolListOptions.allowList}
   * restricts to tools whose id is on the Allow_List — permission-filtered
   * discovery so an agent only sees what it may invoke (Req 16.3). Both filters
   * compose (intersection) when supplied together.
   */
  list(options: ToolListOptions = {}): ToolDescriptor[] {
    const allowed = options.allowList !== undefined ? new Set(options.allowList) : undefined;
    const descriptors: ToolDescriptor[] = [];
    for (const tool of this.tools.values()) {
      if (options.category !== undefined && tool.category !== options.category) continue;
      if (allowed !== undefined && !allowed.has(tool.id)) continue;
      descriptors.push(toDescriptor(tool));
    }
    return descriptors;
  }

  /**
   * Resolve a tool by id for dispatch.
   *
   * @throws {UnknownToolError} when no tool is registered under `toolId`.
   */
  resolve(toolId: string): ToolDefinition {
    const tool = this.tools.get(toolId);
    if (tool === undefined) {
      throw new UnknownToolError(toolId);
    }
    return tool;
  }

  /** Whether a tool is registered under `toolId`. */
  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  /**
   * Validate an invocation's `input` against the tool's parameter schema
   * (Req 16.2).
   *
   * Returns a {@link ToolValidationResult} listing every violation; it does not
   * throw on invalid input (so a caller can inspect the violations) but it
   * *does* throw {@link UnknownToolError} when the tool itself is not
   * registered, since there is no schema to validate against.
   *
   * @throws {UnknownToolError} when no tool is registered under `toolId`.
   */
  validateInput(toolId: string, input: unknown): ToolValidationResult {
    const tool = this.resolve(toolId);
    return validateAgainstSchema(input, tool.parameters);
  }

  /**
   * Whether `toolId` is permitted by `allowList` (Req 16.3).
   *
   * Fail-closed: an empty or missing Allow_List permits nothing, so a tool is
   * allowed iff its id is explicitly present.
   */
  isAllowed(toolId: string, allowList: readonly string[]): boolean {
    return allowList.includes(toolId);
  }

  /**
   * Dispatch a tool invocation, enforcing the Allow_List then the parameter
   * schema as fail-closed preconditions (Req 16.2, 16.3).
   *
   * Order matters: the Allow_List gate runs first (Req 16.3) so a tool the
   * agent may not use is denied before its arguments are even inspected; then
   * the arguments are schema-validated (Req 16.2); only then is the handler
   * invoked with the validated input and the {@link ToolInvocationContext}.
   *
   * @param toolId The tool to invoke.
   * @param input The raw invocation arguments (validated before dispatch).
   * @param allowList The agent's Allow_List of permitted tool ids (Req 16.3).
   * @param context Optional invocation context handed to the handler.
   * @returns The handler's result.
   * @throws {UnknownToolError} when no tool is registered under `toolId`.
   * @throws {ToolNotAllowedError} when `toolId` is not on `allowList` (Req 16.3).
   * @throws {ToolInputValidationError} when `input` fails the schema (Req 16.2).
   */
  async invoke(
    toolId: string,
    input: unknown,
    allowList: readonly string[],
    context: ToolInvocationContext = {},
  ): Promise<unknown> {
    const tool = this.resolve(toolId);
    if (!this.isAllowed(toolId, allowList)) {
      throw new ToolNotAllowedError(toolId);
    }
    const validation = validateAgainstSchema(input, tool.parameters);
    if (!validation.valid) {
      throw new ToolInputValidationError(toolId, validation.errors);
    }
    return tool.handler(input, context);
  }
}
