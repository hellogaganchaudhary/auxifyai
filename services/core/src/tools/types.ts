/**
 * Domain types for the Tool_Registry (Req 16.1, 16.2, 16.3).
 *
 * The Tool_Registry is the catalog the Agent_Runtime reads to discover, gate,
 * and dispatch the tools an agent may call. Every tool is described by a
 * {@link ToolDefinition}: a stable id, a human-readable name/description, a
 * {@link ToolCategory} (web/data/code/communication/document/integration —
 * Req 16.1), a {@link JsonSchema} describing its input parameters (validated
 * before execution — Req 16.2), and an invokable {@link ToolHandler}.
 *
 * The registry validates an invocation's arguments against the tool's
 * parameter schema before dispatch (Req 16.2) and exposes an Allow_List gate so
 * the Agent_Runtime can deny — and record — a tool that is not on the agent's
 * Allow_List (Req 16.3). The schema and validation shapes here are deliberately
 * self-contained (no external JSON-schema dependency) so the registry has no
 * runtime coupling beyond `@auxify/types`.
 */

import type { Principal } from '@auxify/types';

/**
 * The categories a tool may belong to (Req 16.1).
 *
 * The registry registers tools across at least these categories; the union is
 * the single source of truth so the Agent_Runtime and discovery filters never
 * redefine it locally.
 *   - `web` — web search, scraping, browser automation.
 *   - `data` — read-only SQL, dataset, and analytics tools.
 *   - `code` — sandboxed code execution (Python/Node/shell).
 *   - `communication` — channel/DM/email delivery tools.
 *   - `document` — Knowledge Hub / Document Management authoring tools.
 *   - `integration` — GitHub/email/connector-backed tools.
 */
export type ToolCategory = 'web' | 'data' | 'code' | 'communication' | 'document' | 'integration';

/** Every {@link ToolCategory}, for iteration, validation, and test generators. */
export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'web',
  'data',
  'code',
  'communication',
  'document',
  'integration',
] as const;

/** The JSON value kinds a {@link JsonSchema} may constrain. */
export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/** Every {@link JsonSchemaType}, for iteration and validation. */
export const JSON_SCHEMA_TYPES: readonly JsonSchemaType[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
] as const;

/**
 * A pragmatic, self-contained subset of JSON Schema sufficient to describe a
 * tool's input parameters (Req 16.2).
 *
 * Supported keywords: `type` (single type or a list of accepted types),
 * `enum`/`const`; for strings `minLength`/`maxLength`/`pattern`; for
 * numbers/integers `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/
 * `multipleOf`; for arrays `items`/`minItems`/`maxItems`/`uniqueItems`; and for
 * objects `properties`/`required`/`additionalProperties`. Unknown keywords are
 * ignored, so a richer schema still validates against the supported subset.
 *
 * `additionalProperties` follows JSON Schema semantics: when omitted, extra
 * object properties are permitted; set it to `false` to reject any property not
 * declared in `properties`, or to a sub-schema to validate the extras.
 */
export interface JsonSchema {
  /** The accepted JSON type(s). When omitted, any type is accepted. */
  type?: JsonSchemaType | readonly JsonSchemaType[];
  /** An optional human-readable description of the value. */
  description?: string;
  /** The value must equal one of these (deep equality). */
  enum?: readonly unknown[];
  /** The value must deep-equal this constant. */
  const?: unknown;
  /** Minimum string length (inclusive). */
  minLength?: number;
  /** Maximum string length (inclusive). */
  maxLength?: number;
  /** A regular-expression source the string must match (unanchored). */
  pattern?: string;
  /** Minimum numeric value (inclusive). */
  minimum?: number;
  /** Maximum numeric value (inclusive). */
  maximum?: number;
  /** Strict lower bound (exclusive). */
  exclusiveMinimum?: number;
  /** Strict upper bound (exclusive). */
  exclusiveMaximum?: number;
  /** The number must be a multiple of this positive value. */
  multipleOf?: number;
  /** The schema each array element must satisfy. */
  items?: JsonSchema;
  /** Minimum array length (inclusive). */
  minItems?: number;
  /** Maximum array length (inclusive). */
  maxItems?: number;
  /** When `true`, array elements must be mutually distinct (deep equality). */
  uniqueItems?: boolean;
  /** The schema for each named object property. */
  properties?: Record<string, JsonSchema>;
  /** The property names that must be present. */
  required?: readonly string[];
  /**
   * Controls properties not listed in {@link properties}: `true`/omitted permits
   * them, `false` rejects them, a sub-schema validates each extra value.
   */
  additionalProperties?: boolean | JsonSchema;
}

/**
 * A single schema violation produced by {@link import('./schema.js').validateAgainstSchema}.
 *
 * `path` is a JSON-Pointer-style location of the offending value (`""` for the
 * root, `/query`, `/filters/0`), so a caller can map a failure to a specific
 * argument. `message` is a human-readable, secret-free explanation.
 */
export interface SchemaViolation {
  /** JSON-Pointer-style path to the offending value (`""` is the root). */
  path: string;
  /** Human-readable explanation of the violation. */
  message: string;
}

/**
 * The result of validating a value against a {@link JsonSchema} (Req 16.2).
 *
 * `valid` is `true` only when no violation was found; otherwise `errors` lists
 * every violation discovered (validation does not stop at the first one), so a
 * caller can report all argument problems at once.
 */
export interface ToolValidationResult {
  /** Whether the value satisfied the schema. */
  valid: boolean;
  /** Every violation found; empty when `valid` is `true`. */
  errors: SchemaViolation[];
}

/**
 * The context handed to a {@link ToolHandler} when the registry dispatches an
 * invocation.
 *
 * The acting {@link Principal} (when present) lets a tool scope its effects to
 * the caller's tenant; `runId`/`stepNumber` tie a tool call to the Agent_Runtime
 * step that requested it (Req 15.6). All fields are optional so a tool can be
 * exercised directly in tests with no agent run.
 */
export interface ToolInvocationContext {
  /** The acting principal, for tenant-scoped effects. */
  principal?: Principal;
  /** The agent run this invocation belongs to, when dispatched by the runtime. */
  runId?: string;
  /** The 1-based step number within the run, when dispatched by the runtime. */
  stepNumber?: number;
}

/**
 * An invokable tool handler.
 *
 * It receives the already-schema-validated `input` (Req 16.2) and the
 * {@link ToolInvocationContext}, and returns the tool's output (or a promise of
 * it). Handlers should treat `input` as validated but still untrusted data.
 */
export type ToolHandler = (
  input: unknown,
  context: ToolInvocationContext,
) => unknown | Promise<unknown>;

/**
 * A complete tool descriptor plus its invokable handler (Req 16.1, 16.2).
 *
 * `id` is the stable machine name the Agent_Runtime references and the
 * Allow_List gates on (Req 16.3); `displayName`/`description` are for humans;
 * `category` places the tool in one of the {@link TOOL_CATEGORIES} (Req 16.1);
 * `parameters` is the {@link JsonSchema} every invocation's input is validated
 * against before dispatch (Req 16.2); `handler` performs the tool's work.
 */
export interface ToolDefinition {
  /** Stable, unique machine id (also the Allow_List key, Req 16.3). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** The category this tool belongs to (Req 16.1). */
  category: ToolCategory;
  /** JSON-schema for the tool's input parameters, validated before execution (Req 16.2). */
  parameters: JsonSchema;
  /** The invokable handler the registry dispatches to after validation/gating. */
  handler: ToolHandler;
}

/**
 * The handler-free public view of a tool used for discovery/listing.
 *
 * {@link import('./tool-registry.js').ToolRegistry.list} returns these so a
 * client can enumerate available tools (and their parameter schemas) without
 * gaining a reference to the executable handler.
 */
export type ToolDescriptor = Omit<ToolDefinition, 'handler'>;

/** Options narrowing {@link import('./tool-registry.js').ToolRegistry.list}. */
export interface ToolListOptions {
  /** When set, return only tools in this category (Req 16.1). */
  category?: ToolCategory;
  /**
   * When set, return only tools whose id is on this Allow_List — permission-
   * filtered discovery so an agent only sees the tools it may invoke (Req 16.3).
   */
  allowList?: readonly string[];
}

/**
 * The Tool_Registry's public contract (Req 16.1, 16.2, 16.3).
 *
 * {@link import('./tool-registry.js').ToolRegistry} is the concrete
 * implementation; this interface documents the surface the Agent_Runtime
 * depends on. It mirrors the design's `register`/`validateInput`/`isAllowed`
 * and adds the discovery (`list`/`resolve`) and dispatch (`invoke`) operations
 * the runtime needs.
 */
export interface ToolRegistryContract {
  /** Register a tool descriptor + handler (Req 16.1). */
  register(tool: ToolDefinition): void;
  /** List available tools, optionally filtered by category and/or Allow_List. */
  list(options?: ToolListOptions): ToolDescriptor[];
  /** Resolve a tool by id for dispatch. */
  resolve(toolId: string): ToolDefinition;
  /** Whether a tool is registered under `toolId`. */
  has(toolId: string): boolean;
  /** Validate an invocation's input against the tool's schema (Req 16.2). */
  validateInput(toolId: string, input: unknown): ToolValidationResult;
  /** Whether `toolId` is permitted by `allowList` (fail-closed) (Req 16.3). */
  isAllowed(toolId: string, allowList: readonly string[]): boolean;
}
