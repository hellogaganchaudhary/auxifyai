/**
 * Prompt_Library domain errors (Req 10).
 *
 * {@link PromptTemplateNotFoundError} surfaces when an operation targets a
 * template that does not exist within the caller's Organization (tenant scoping
 * turns "not in my tenant" into "not found"). {@link MissingPromptVariablesError}
 * guards {@link PromptLibrary.fillVariables}: filling must be complete before the
 * filled text is used (Req 10.4 / Property 24), so an incomplete value map is
 * rejected rather than silently leaving placeholders.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** Stable machine-readable code for a missing prompt template. */
export const PROMPT_TEMPLATE_NOT_FOUND_CODE = 'PROMPT_TEMPLATE_NOT_FOUND' as const;

/** Stable machine-readable code for an incomplete variable map on fill. */
export const MISSING_PROMPT_VARIABLES_CODE = 'MISSING_PROMPT_VARIABLES' as const;

/**
 * Thrown when a prompt template referenced by an operation does not exist
 * within the caller's Organization.
 */
export class PromptTemplateNotFoundError extends Error {
  /** The template id that was looked up. */
  readonly templateId: string;

  constructor(templateId: string) {
    super(`Prompt template "${templateId}" was not found in the current organization`);
    this.name = 'PromptTemplateNotFoundError';
    this.templateId = templateId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: PROMPT_TEMPLATE_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { templateId: this.templateId },
    });
  }
}

/**
 * Thrown when {@link PromptLibrary.fillVariables} is called with a value map
 * that does not cover every variable the template declares (Req 10.4). The
 * unresolved names are carried so the caller can prompt the user for them.
 */
export class MissingPromptVariablesError extends Error {
  /** The template whose variables were being filled. */
  readonly templateId: string;
  /** The declared variable names that had no supplied value. */
  readonly missing: string[];

  constructor(templateId: string, missing: string[]) {
    super(`Prompt template "${templateId}" is missing values for variables: ${missing.join(', ')}`);
    this.name = 'MissingPromptVariablesError';
    this.templateId = templateId;
    this.missing = missing;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: MISSING_PROMPT_VARIABLES_CODE,
      message: this.message,
      correlationId,
      details: { templateId: this.templateId, missing: this.missing },
    });
  }
}
