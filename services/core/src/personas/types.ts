/**
 * Persona_Manager domain types and injected ports (Req 9.1-9.5).
 *
 * The Persona_Manager owns the system-prompt "personas" a user can apply to a
 * conversation so the model answers in a task-appropriate style. It exposes a
 * built-in catalog (a default persona, Req 9.1, and categorized predefined
 * personas, Req 9.2), lets a user save custom personas (Req 9.4), applies a
 * persona to a conversation (Req 9.3), and substitutes declared variables in a
 * persona's system prompt before it is sent to the model (Req 9.5).
 *
 * Two facts about the persistence model shape these types:
 *   - The `personas` table (migration 0004) is **user-owned**: it carries a
 *     nullable `owner_id` (NULL for built-in/system personas) and has *no*
 *     `organization_id` column. Custom personas are therefore scoped by owner
 *     rather than by Organization — see {@link PersonaStore} and the
 *     `PersonaRepository`.
 *   - Built-in personas (default + predefined) live in a constant catalog
 *     (`catalog.ts`), not the database, so they are always available without a
 *     seed step.
 *
 * Every effect the manager needs is an injected port so it is unit-testable with
 * in-memory fakes, with no database:
 *   - {@link PersonaStore} — the owner-scoped custom-persona persistence
 *     (satisfied structurally by `PersonaRepository`); and
 *   - {@link ConversationPersonaStore} — the narrow conversation-update seam used
 *     by {@link apply} to set a conversation's `personaId` (satisfied
 *     structurally by `ConversationRepository`).
 */

import type { TenantContext } from '@auxify/types';

import type { ConversationRecord, UpdateConversationInput } from '../repositories/index.js';

/**
 * A declared variable in a persona (or prompt-template) system prompt (Req 9.5).
 *
 * A variable is referenced in the prompt with the `{{name}}` placeholder syntax
 * (see {@link import('./variables.js').substituteVariables}). `defaultValue`
 * supplies a value when the caller provides none; a `required` variable with no
 * value and no default is a {@link import('./errors.js').MissingVariableError}
 * during strict resolution.
 */
export interface VariableDef {
  /** The variable name, as it appears inside `{{ }}` (e.g. `name`, `tone`). */
  name: string;
  /** Optional human-readable description for UI prompting. */
  description?: string;
  /** Whether a value must be supplied (no default ⇒ strict resolution throws). */
  required?: boolean;
  /** A value used when the caller supplies none. */
  defaultValue?: string;
}

/**
 * A persona: a named, categorized system prompt with declared variables
 * (design "Personas, Prompts, Artifacts"; Req 9.1-9.5).
 *
 * Built-in personas (the default and predefined catalog) have no `ownerId`;
 * custom personas are owned by the user that created them (Req 9.4).
 */
export interface Persona {
  /** Stable unique id. Built-in personas use stable `persona-*` ids. */
  id: string;
  /** The owning user for custom personas; `undefined` for built-in personas. */
  ownerId?: string;
  /** Display name. */
  name: string;
  /** Category (e.g. `engineering`, `sales`, `product`, `marketing`). */
  category: string;
  /** The system prompt applied ahead of the conversation history (Req 9.3). */
  systemPrompt: string;
  /** Whether this is the default persona applied when none is selected (Req 9.1). */
  isDefault: boolean;
  /** Declared variables substituted before sending the prompt (Req 9.5). */
  variables: VariableDef[];
}

/**
 * A persisted custom persona row mapped from the `personas` table.
 *
 * `ownerId` is `null` only for built-in/system rows; the repository scopes every
 * read and write to the acting user, so it never returns another user's rows.
 */
export interface PersonaRecord {
  id: string;
  ownerId: string | null;
  name: string;
  category: string;
  systemPrompt: string;
  isDefault: boolean;
  variables: VariableDef[];
  createdAt: string;
}

/** The fields a caller supplies to create a custom persona (Req 9.4). */
export interface PersonaInput {
  /** Display name (required). */
  name: string;
  /** The system prompt (required). */
  systemPrompt: string;
  /** Category; defaults to `custom`. */
  category?: string;
  /** Declared variables; defaults to an empty list. */
  variables?: VariableDef[];
  /** Optional explicit id; one is generated when omitted. */
  id?: string;
}

/**
 * The four categories every predefined catalog must cover, at minimum (Req 9.2).
 *
 * The catalog may add more, but these are guaranteed present.
 */
export const REQUIRED_PERSONA_CATEGORIES = [
  'engineering',
  'sales',
  'product',
  'marketing',
] as const;

/** A category guaranteed to exist in the predefined catalog (Req 9.2). */
export type RequiredPersonaCategory = (typeof REQUIRED_PERSONA_CATEGORIES)[number];

/**
 * The owner-scoped persistence port for custom personas (Req 9.4).
 *
 * `PersonaRepository` satisfies this structurally; tests substitute an in-memory
 * fake. Every method requires a {@link TenantContext} and is scoped to the
 * acting user (`ctx.userId`), so a user can neither read nor write another
 * user's custom personas.
 */
export interface PersonaStore {
  /** Persist a custom persona owned by the acting user (Req 9.4). */
  create(ctx: TenantContext, record: PersonaRecord): Promise<PersonaRecord>;
  /** Fetch one of the acting user's custom personas by id, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<PersonaRecord | null>;
  /** List the acting user's custom personas (most recently created first). */
  listOwned(ctx: TenantContext): Promise<PersonaRecord[]>;
}

/**
 * The narrow conversation-update seam used by {@link apply} (Req 9.3).
 *
 * Reuses the repository's `ConversationRecord`/`UpdateConversationInput` shapes
 * so `ConversationRepository` satisfies it structurally. The manager only needs
 * to verify a conversation exists in the tenant and to set its `personaId`; the
 * Chat_Service then applies the persona's system prompt on subsequent sends.
 */
export interface ConversationPersonaStore {
  /** Fetch a conversation by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<ConversationRecord | null>;
  /** Update a conversation by id within the caller's Organization, or `null`. */
  update(
    ctx: TenantContext,
    id: string,
    input: UpdateConversationInput,
  ): Promise<ConversationRecord | null>;
}
