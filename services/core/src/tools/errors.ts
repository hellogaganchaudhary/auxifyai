/**
 * Tool_Registry typed errors (Req 16.1, 16.2, 16.3).
 *
 * The registry enforces its preconditions with dedicated, typed errors so the
 * Agent_Runtime can branch on the exact failure without parsing messages:
 *
 *  - {@link DuplicateToolError} — a second tool was registered under an id that
 *    is already taken. Registration is the configuration step (Req 16.1), so a
 *    collision is a deployment error surfaced as `conflict`.
 *  - {@link UnknownToolError} — a tool id was resolved/validated/invoked that is
 *    not registered. Surfaced as `not_found`.
 *  - {@link InvalidToolDefinitionError} — a tool descriptor is structurally
 *    invalid (missing id, bad category, …). Surfaced as `validation`.
 *  - {@link ToolInputValidationError} — an invocation's arguments failed the
 *    tool's parameter schema (Req 16.2). Carries every {@link SchemaViolation}
 *    in `details` and is surfaced as `validation`.
 *  - {@link ToolNotAllowedError} — a tool not on the agent's Allow_List was
 *    invoked (Req 16.3). Surfaced as `authorization`; the Agent_Runtime denies
 *    and records the denial in the run steps.
 *
 * Each projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, and carries structured, secret-free `details` (Req 34.7).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { SchemaViolation } from './types.js';

/** Stable machine-readable code for a duplicate tool registration (Req 16.1). */
export const DUPLICATE_TOOL_CODE = 'TOOL_ALREADY_REGISTERED' as const;
/** Stable machine-readable code for resolving/invoking an unregistered tool. */
export const UNKNOWN_TOOL_CODE = 'TOOL_NOT_FOUND' as const;
/** Stable machine-readable code for a structurally invalid tool definition (Req 16.1). */
export const INVALID_TOOL_DEFINITION_CODE = 'INVALID_TOOL_DEFINITION' as const;
/** Stable machine-readable code for input that fails a tool's parameter schema (Req 16.2). */
export const TOOL_INPUT_INVALID_CODE = 'TOOL_INPUT_INVALID' as const;
/** Stable machine-readable code for invoking a tool not on the Allow_List (Req 16.3). */
export const TOOL_NOT_ALLOWED_CODE = 'TOOL_NOT_ALLOWED' as const;

/**
 * Thrown when a tool is registered under an id that is already taken (Req 16.1).
 *
 * Registration is configuration, so a duplicate id is a deployment error. The
 * id is carried so an operator sees exactly which registration collided.
 */
export class DuplicateToolError extends Error {
  /** The id that was already registered. */
  readonly toolId: string;

  constructor(toolId: string) {
    super(`A tool is already registered under id "${toolId}"`);
    this.name = 'DuplicateToolError';
    this.toolId = toolId;
  }

  /**
   * Project into the platform-wide error shape (`conflict`,
   * {@link DUPLICATE_TOOL_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'conflict',
      code: DUPLICATE_TOOL_CODE,
      message: this.message,
      correlationId,
      details: { toolId: this.toolId },
    });
  }
}

/**
 * Thrown when an unregistered tool id is resolved, validated, or invoked.
 *
 * The unknown id is carried so a caller can report exactly which tool was
 * missing. Surfaced as `not_found`.
 */
export class UnknownToolError extends Error {
  /** The id that was not registered. */
  readonly toolId: string;

  constructor(toolId: string) {
    super(`No tool is registered under id "${toolId}"`);
    this.name = 'UnknownToolError';
    this.toolId = toolId;
  }

  /**
   * Project into the platform-wide error shape (`not_found`,
   * {@link UNKNOWN_TOOL_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: UNKNOWN_TOOL_CODE,
      message: this.message,
      correlationId,
      details: { toolId: this.toolId },
    });
  }
}

/**
 * Thrown when a {@link import('./types.js').ToolDefinition} is structurally
 * invalid (Req 16.1).
 *
 * `reason` explains the structural problem (missing id, invalid category, …).
 * Surfaced as `validation`.
 */
export class InvalidToolDefinitionError extends Error {
  constructor(reason: string) {
    super(`Invalid tool definition: ${reason}`);
    this.name = 'InvalidToolDefinitionError';
  }

  /**
   * Project into the platform-wide error shape (`validation`,
   * {@link INVALID_TOOL_DEFINITION_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_TOOL_DEFINITION_CODE,
      message: this.message,
      correlationId,
    });
  }
}

/**
 * Thrown when an invocation's arguments fail the tool's parameter schema
 * (Req 16.2).
 *
 * Every {@link SchemaViolation} is carried in {@link violations} (and in the
 * projected error's `details`) so a caller can report all argument problems at
 * once. Surfaced as `validation`.
 */
export class ToolInputValidationError extends Error {
  /** The tool whose input failed validation. */
  readonly toolId: string;
  /** Every schema violation found. */
  readonly violations: SchemaViolation[];

  constructor(toolId: string, violations: SchemaViolation[]) {
    const summary = violations
      .map((v) => `${v.path === '' ? '(root)' : v.path}: ${v.message}`)
      .join('; ');
    super(`Input for tool "${toolId}" failed validation: ${summary}`);
    this.name = 'ToolInputValidationError';
    this.toolId = toolId;
    this.violations = violations;
  }

  /**
   * Project into the platform-wide error shape (`validation`,
   * {@link TOOL_INPUT_INVALID_CODE}) (Req 16.2, 46.8). The violations travel in
   * `details` so a client can render a precise, secret-free explanation.
   *
   * @param correlationId Ties the error to logs/traces (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: TOOL_INPUT_INVALID_CODE,
      message: this.message,
      correlationId,
      details: { toolId: this.toolId, violations: this.violations },
    });
  }
}

/**
 * Thrown when a tool not on the agent's Allow_List is invoked (Req 16.3).
 *
 * The Agent_Runtime denies the invocation and records the denial in the run
 * steps; this typed error is the fail-closed signal it acts on. Surfaced as
 * `authorization`.
 */
export class ToolNotAllowedError extends Error {
  /** The tool that was denied. */
  readonly toolId: string;

  constructor(toolId: string) {
    super(`Tool "${toolId}" is not on the agent's Allow_List`);
    this.name = 'ToolNotAllowedError';
    this.toolId = toolId;
  }

  /**
   * Project into the platform-wide error shape (`authorization`,
   * {@link TOOL_NOT_ALLOWED_CODE}) (Req 16.3, 46.8).
   *
   * @param correlationId Ties the error to logs/traces (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authorization',
      code: TOOL_NOT_ALLOWED_CODE,
      message: this.message,
      correlationId,
      details: { toolId: this.toolId },
    });
  }
}
