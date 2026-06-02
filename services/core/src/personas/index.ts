/**
 * Persona_Manager (Req 9.1-9.5).
 *
 * Manages the system-prompt personas a user can apply to a conversation so the
 * model answers in a task-appropriate style:
 *   - a built-in **default persona** applied when none is selected (Req 9.1);
 *   - a **categorized predefined catalog** covering at minimum engineering,
 *     sales, product, and marketing (Req 9.2);
 *   - **apply**, which records a persona on a conversation so the Chat_Service
 *     applies its system prompt to subsequent model requests (Req 9.3);
 *   - **custom personas** persisted per user via the owner-scoped
 *     {@link PersonaRepository} (Req 9.4); and
 *   - **variable substitution** of `{{name}}` placeholders before a prompt is
 *     sent to the model (Req 9.5), via a shared core also used by the
 *     Prompt_Library (Property 24, task 9.2).
 *
 * Surface:
 *   - {@link PersonaManager} — the service; one method per acceptance criterion
 *     plus {@link PersonaManager.resolveSystemPrompt} (the Chat_Service seam).
 *   - {@link PersonaRepository} — the owner-scoped persistence over `personas`.
 *   - {@link substituteVariables}, {@link resolveVariableValues},
 *     {@link extractVariableNames}, {@link hasUnresolvedVariables} — the shared
 *     `{{name}}` substitution core (exported cleanly for task 9.2's Property 24).
 *   - the built-in catalog ({@link DEFAULT_PERSONA}, {@link PREDEFINED_PERSONAS},
 *     {@link builtInPersonas}), domain types, and typed errors.
 */

export {
  PersonaManager,
  type PersonaManagerOptions,
  type PersonaIdGenerator,
} from './persona-manager.js';

export { PersonaRepository } from './persona-repository.js';

export {
  substituteVariables,
  resolveVariableValues,
  extractVariableNames,
  hasUnresolvedVariables,
  VARIABLE_NAME_PATTERN,
  type MissingVariablePolicy,
  type SubstituteOptions,
} from './variables.js';

export {
  DEFAULT_PERSONA,
  DEFAULT_PERSONA_ID,
  PREDEFINED_PERSONAS,
  builtInPersonas,
  getDefaultPersona,
  findBuiltInPersona,
  clonePersona,
} from './catalog.js';

export {
  PersonaNotFoundError,
  InvalidPersonaError,
  MissingVariableError,
  PERSONA_NOT_FOUND_CODE,
  INVALID_PERSONA_CODE,
  MISSING_VARIABLE_CODE,
} from './errors.js';

export {
  REQUIRED_PERSONA_CATEGORIES,
  type Persona,
  type PersonaInput,
  type PersonaRecord,
  type PersonaStore,
  type ConversationPersonaStore,
  type RequiredPersonaCategory,
  type VariableDef,
} from './types.js';
