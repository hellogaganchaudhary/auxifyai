/**
 * Tool_Registry (Req 16.1, 16.2, 16.3).
 *
 * The catalog the Agent_Runtime reads to discover, gate, and dispatch the tools
 * an agent may call. Onboarding a tool is a {@link ToolRegistry.register} call
 * with a {@link ToolDefinition}; the registry owns validation and Allow_List
 * gating so the Agent_Runtime (task 15.5) composes one consistent surface.
 *
 * Surface:
 *   - {@link ToolRegistry} — the in-memory registry: registers tools across the
 *     web/data/code/communication/document/integration categories (Req 16.1),
 *     lists/discovers them (optionally filtered by category and/or an
 *     Allow_List), resolves a tool by id, validates an invocation's arguments
 *     against the tool's parameter schema before dispatch (Req 16.2), gates on
 *     the agent's Allow_List (Req 16.3), and dispatches a validated, allow-listed
 *     call through {@link ToolRegistry.invoke}.
 *   - {@link ToolDefinition} / {@link ToolDescriptor} / {@link ToolHandler} /
 *     {@link ToolInvocationContext} / {@link ToolCategory} / {@link TOOL_CATEGORIES} /
 *     {@link ToolListOptions} / {@link ToolRegistryContract} — the tool descriptor
 *     model and the registry contract.
 *   - {@link JsonSchema} / {@link JsonSchemaType} / {@link JSON_SCHEMA_TYPES} /
 *     {@link SchemaViolation} / {@link ToolValidationResult} — the self-contained
 *     JSON-schema subset used to describe and validate tool parameters (Req 16.2),
 *     and {@link validateAgainstSchema}, its pure validator.
 *   - {@link DuplicateToolError} / {@link UnknownToolError} /
 *     {@link InvalidToolDefinitionError} / {@link ToolInputValidationError} /
 *     {@link ToolNotAllowedError} — the typed errors, each projecting to a
 *     {@link import('@auxify/types').PlatformError} (Req 46.8).
 *
 * The Allow_List enforcement here is the fail-closed gate the Agent_Runtime uses
 * to deny — and record in the run steps — a tool that is not on the agent's
 * Allow_List (Req 16.3).
 */

export { ToolRegistry } from './tool-registry.js';

export { validateAgainstSchema } from './schema.js';

export {
  TOOL_CATEGORIES,
  JSON_SCHEMA_TYPES,
  type ToolCategory,
  type JsonSchema,
  type JsonSchemaType,
  type SchemaViolation,
  type ToolValidationResult,
  type ToolInvocationContext,
  type ToolHandler,
  type ToolDefinition,
  type ToolDescriptor,
  type ToolListOptions,
  type ToolRegistryContract,
} from './types.js';

export {
  DuplicateToolError,
  UnknownToolError,
  InvalidToolDefinitionError,
  ToolInputValidationError,
  ToolNotAllowedError,
  DUPLICATE_TOOL_CODE,
  UNKNOWN_TOOL_CODE,
  INVALID_TOOL_DEFINITION_CODE,
  TOOL_INPUT_INVALID_CODE,
  TOOL_NOT_ALLOWED_CODE,
} from './errors.js';
