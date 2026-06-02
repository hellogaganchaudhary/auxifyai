/**
 * Persona_Manager domain errors (Req 9.1-9.5).
 *
 * These make the manager's not-found, validation, and strict-substitution
 * conditions explicit and testable, and each projects into the platform-wide
 * serializable {@link PlatformError} shape (Req 46.8):
 *   - {@link PersonaNotFoundError} — a referenced persona does not exist for the
 *     acting user (neither a built-in catalog persona nor one the user owns).
 *   - {@link InvalidPersonaError} — a custom persona create was missing a
 *     required field (Req 9.4).
 *   - {@link MissingVariableError} — strict variable substitution found a
 *     declared/required variable with no value (Req 9.5).
 *
 * The "conversation not found" condition of {@link apply} reuses the canonical
 * {@link import('../conversations/index.js').ConversationNotFoundError} from the
 * Conversation_Manager rather than redefining it, so there is a single
 * conversation-not-found error package-wide.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** Stable machine-readable code for a missing persona. */
export const PERSONA_NOT_FOUND_CODE = 'PERSONA_NOT_FOUND' as const;

/** Stable machine-readable code for an invalid custom persona. */
export const INVALID_PERSONA_CODE = 'INVALID_PERSONA' as const;

/** Stable machine-readable code for a missing required variable value. */
export const MISSING_VARIABLE_CODE = 'MISSING_VARIABLE' as const;

/**
 * Thrown when a referenced persona is neither a built-in catalog persona nor a
 * custom persona owned by the acting user.
 */
export class PersonaNotFoundError extends Error {
  /** The persona id that was looked up. */
  readonly personaId: string;

  constructor(personaId: string) {
    super(`Persona "${personaId}" was not found for the current user`);
    this.name = 'PersonaNotFoundError';
    this.personaId = personaId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: PERSONA_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { personaId: this.personaId },
    });
  }
}

/** Thrown when a custom persona create is missing a required field (Req 9.4). */
export class InvalidPersonaError extends Error {
  /** The offending field (e.g. `name`, `systemPrompt`). */
  readonly field: string;

  constructor(field: string, message?: string) {
    super(message ?? `Custom persona is missing a required field: "${field}"`);
    this.name = 'InvalidPersonaError';
    this.field = field;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_PERSONA_CODE,
      message: this.message,
      correlationId,
      details: { field: this.field },
    });
  }
}

/**
 * Thrown by strict variable substitution when a referenced or declared/required
 * variable has no provided value or default (Req 9.5).
 */
export class MissingVariableError extends Error {
  /** The variable name that had no value. */
  readonly variableName: string;

  constructor(variableName: string) {
    super(`No value provided for required variable "${variableName}"`);
    this.name = 'MissingVariableError';
    this.variableName = variableName;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: MISSING_VARIABLE_CODE,
      message: this.message,
      correlationId,
      details: { variableName: this.variableName },
    });
  }
}
