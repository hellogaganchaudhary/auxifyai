/**
 * Test fakes and sample tools for the Tool_Registry (Req 16.1, 16.2, 16.3).
 *
 * The Tool_Registry has a single moving part worth faking: the
 * {@link ToolDefinition}s it stores. These builders and ready-made sample tools
 * let unit and property tests exercise registration, discovery, resolution,
 * schema validation, and Allow_List gating deterministically without any real
 * tool side effects:
 *
 *   - {@link makeTool} builds a {@link ToolDefinition} with sensible defaults
 *     (an echo handler that records its invocations) overridable field-by-field.
 *   - {@link SAMPLE_TOOLS} is a representative tool per {@link TOOL_CATEGORIES}
 *     category (Req 16.1), each with a real parameter schema (Req 16.2), so a
 *     test can register a full catalog and assert category-filtered discovery.
 *   - {@link sampleRegistry} returns a {@link ToolRegistry} preloaded with
 *     {@link SAMPLE_TOOLS}.
 *
 * Import these directly from `./fakes.js` in tests, never from a package barrel.
 */

import { ToolRegistry } from './tool-registry.js';
import {
  TOOL_CATEGORIES,
  type JsonSchema,
  type ToolCategory,
  type ToolDefinition,
  type ToolHandler,
  type ToolInvocationContext,
} from './types.js';

/** A recorded `(input, context)` pair as seen by a {@link RecordingHandler}. */
export interface RecordedInvocation {
  /** The (already-validated) input the handler received. */
  input: unknown;
  /** The invocation context the handler received. */
  context: ToolInvocationContext;
}

/**
 * A {@link ToolHandler} that records every invocation and echoes its input.
 *
 * Lets a test assert a handler was (or was not) reached — proving the registry
 * dispatched only after the Allow_List and schema gates passed — and with what
 * arguments.
 */
export class RecordingHandler {
  /** Every invocation, in order. */
  readonly invocations: RecordedInvocation[] = [];

  /** The bound handler to place on a {@link ToolDefinition}. */
  readonly handler: ToolHandler = (input, context) => {
    this.invocations.push({ input, context });
    return { echoed: input };
  };

  /** The number of times the handler was invoked. */
  get count(): number {
    return this.invocations.length;
  }
}

/** Options for {@link makeTool}; every field overrides a sensible default. */
export interface MakeToolOptions {
  /** Stable tool id (defaults to `tool-1`). */
  id?: string;
  /** Display name (defaults to a name derived from the id). */
  displayName?: string;
  /** Description (defaults to a description derived from the id). */
  description?: string;
  /** Category (defaults to `data`). */
  category?: ToolCategory;
  /** Parameter schema (defaults to a single required string `value`). */
  parameters?: JsonSchema;
  /** Handler (defaults to an echo handler). */
  handler?: ToolHandler;
}

/**
 * Build a {@link ToolDefinition} with deterministic defaults, overridable
 * field-by-field.
 *
 * The default `parameters` requires a single string property `value`, so a test
 * can drive both the validation-success path (`{ value: 'x' }`) and the
 * validation-failure path (`{}` or `{ value: 1 }`) with no setup.
 */
export function makeTool(options: MakeToolOptions = {}): ToolDefinition {
  const id = options.id ?? 'tool-1';
  return {
    id,
    displayName: options.displayName ?? `Tool ${id}`,
    description: options.description ?? `A sample tool with id ${id}`,
    category: options.category ?? 'data',
    parameters:
      options.parameters ??
      ({
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      } satisfies JsonSchema),
    handler: options.handler ?? (((input: unknown) => ({ echoed: input })) as ToolHandler),
  };
}

/**
 * A representative tool for every {@link ToolCategory} (Req 16.1).
 *
 * Each carries a real, distinct parameter schema (Req 16.2) so tests can assert
 * validation success and failure per tool, and so category-filtered discovery
 * returns exactly one tool per category.
 */
export const SAMPLE_TOOLS: readonly ToolDefinition[] = [
  makeTool({
    id: 'web_search',
    displayName: 'Web Search',
    description: 'Search the web for a query.',
    category: 'web',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  }),
  makeTool({
    id: 'sql_query',
    displayName: 'SQL Query',
    description: 'Run a read-only SQL query against staging.',
    category: 'data',
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string', minLength: 1 } },
      required: ['sql'],
      additionalProperties: false,
    },
  }),
  makeTool({
    id: 'run_code',
    displayName: 'Run Code',
    description: 'Execute a code snippet in the sandbox.',
    category: 'code',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'node', 'shell'] },
        source: { type: 'string', minLength: 1 },
      },
      required: ['language', 'source'],
      additionalProperties: false,
    },
  }),
  makeTool({
    id: 'send_message',
    displayName: 'Send Message',
    description: 'Post a message to a channel.',
    category: 'communication',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string', minLength: 1 },
        body: { type: 'string', minLength: 1 },
      },
      required: ['channelId', 'body'],
      additionalProperties: false,
    },
  }),
  makeTool({
    id: 'create_page',
    displayName: 'Create Knowledge Page',
    description: 'Create a Knowledge Hub page.',
    category: 'document',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1 },
        content: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  }),
  makeTool({
    id: 'github_issue',
    displayName: 'Create GitHub Issue',
    description: 'Open an issue on a GitHub repository.',
    category: 'integration',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', pattern: '^[^/]+/[^/]+$' },
        title: { type: 'string', minLength: 1 },
        labels: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      },
      required: ['repo', 'title'],
      additionalProperties: false,
    },
  }),
];

/**
 * Compile-time assertion that {@link SAMPLE_TOOLS} covers every category exactly
 * once (so category-filtered discovery tests stay exhaustive as categories grow).
 */
export const SAMPLE_TOOL_CATEGORIES: readonly ToolCategory[] = SAMPLE_TOOLS.map((t) => t.category);

/** A {@link ToolRegistry} preloaded with {@link SAMPLE_TOOLS}. */
export function sampleRegistry(): ToolRegistry {
  return new ToolRegistry(SAMPLE_TOOLS);
}

/** Every category covered by {@link SAMPLE_TOOLS}, for test iteration. */
export const ALL_CATEGORIES: readonly ToolCategory[] = TOOL_CATEGORIES;
