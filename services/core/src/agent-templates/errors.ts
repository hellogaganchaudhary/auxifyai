/**
 * Agent-template domain errors (Req 16.4, 16.5).
 *
 * These make the catalog's not-found and override-validation conditions
 * explicit and testable, and each projects into the platform-wide serializable
 * {@link PlatformError} shape (Req 46.8) so the same wire shape crosses the
 * REST_API, the WebSocket_Gateway, and the SDK:
 *   - {@link UnknownAgentTemplateError} — a referenced template id is not in the
 *     pre-built catalog (Req 16.4). Surfaced as `not_found`.
 *   - {@link InvalidTemplateOverrideError} — a caller supplied an override that
 *     is structurally invalid (blank name/model/prompt, a blank or duplicate
 *     tool id, or a non-positive / over-ceiling safety limit) (Req 16.5).
 *     Surfaced as `validation`.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** Stable machine-readable code for resolving an unknown agent template (Req 16.4). */
export const UNKNOWN_AGENT_TEMPLATE_CODE = 'AGENT_TEMPLATE_NOT_FOUND' as const;

/** Stable machine-readable code for an invalid creation-from-template override (Req 16.5). */
export const INVALID_TEMPLATE_OVERRIDE_CODE = 'INVALID_TEMPLATE_OVERRIDE' as const;

/**
 * Thrown when a template id is looked up that is not in the pre-built catalog
 * (Req 16.4).
 *
 * The unknown id is carried so a caller can report exactly which template was
 * missing. Surfaced as `not_found`.
 */
export class UnknownAgentTemplateError extends Error {
  /** The template id that was not found. */
  readonly templateId: string;

  constructor(templateId: string) {
    super(`No agent template is registered under id "${templateId}"`);
    this.name = 'UnknownAgentTemplateError';
    this.templateId = templateId;
  }

  /**
   * Project into the platform-wide error shape (`not_found`,
   * {@link UNKNOWN_AGENT_TEMPLATE_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: UNKNOWN_AGENT_TEMPLATE_CODE,
      message: this.message,
      correlationId,
      details: { templateId: this.templateId },
    });
  }
}

/**
 * Thrown when a creation-from-template override is structurally invalid
 * (Req 16.5).
 *
 * `field` names the offending override (`name`, `systemPrompt`, `model`,
 * `allowedTools`, or a `safetyLimits.*` key) and `reason` explains the problem,
 * so a caller can map a failure to a specific input. Surfaced as `validation`.
 */
export class InvalidTemplateOverrideError extends Error {
  /** The offending override field (e.g. `name`, `allowedTools`, `safetyLimits.maxSteps`). */
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid override for "${field}": ${reason}`);
    this.name = 'InvalidTemplateOverrideError';
    this.field = field;
  }

  /**
   * Project into the platform-wide error shape (`validation`,
   * {@link INVALID_TEMPLATE_OVERRIDE_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_TEMPLATE_OVERRIDE_CODE,
      message: this.message,
      correlationId,
      details: { field: this.field },
    });
  }
}
