/**
 * The Persona_Manager (Req 9.1-9.5).
 *
 * Manages the system-prompt personas a user can apply to a conversation so the
 * model answers in a task-appropriate style. It composes injected ports so it is
 * unit-testable without a database:
 *
 *   - a {@link PersonaStore} (satisfied by `PersonaRepository`) — the owner-scoped
 *     persistence for custom personas (Req 9.4); and
 *   - a {@link ConversationPersonaStore} (satisfied by `ConversationRepository`) —
 *     the narrow conversation-update seam used by {@link apply} (Req 9.3).
 *
 * Responsibilities mapped to acceptance criteria:
 *   - {@link getDefault} — returns the built-in default persona applied when no
 *     other is selected (Req 9.1).
 *   - {@link listPredefined} — returns the categorized predefined catalog,
 *     covering at minimum engineering/sales/product/marketing (Req 9.2).
 *   - {@link apply} — sets a conversation's `personaId` so the **Chat_Service**
 *     applies that persona's system prompt to subsequent model requests in the
 *     conversation (Req 9.3). The manager does not itself call the model; it
 *     records the selection on the conversation, and the Chat_Service reads the
 *     persona, substitutes variables, and sends the prompt on the next send.
 *   - {@link createCustom} — validates and persists a custom persona owned by
 *     the acting user (Req 9.4).
 *   - {@link substituteVariables} — substitutes `{{name}}` variables in a system
 *     prompt before it is sent to the model (Req 9.5), via the shared core also
 *     used by the Prompt_Library (Property 24).
 *   - {@link resolveSystemPrompt} — the convenience the Chat_Service uses on a
 *     send: load a persona (built-in or custom) and return its system prompt
 *     with declared variables substituted (Req 9.3 + 9.5).
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import { builtInPersonas, findBuiltInPersona, getDefaultPersona } from './catalog.js';
import { ConversationNotFoundError } from '../conversations/index.js';
import { InvalidPersonaError, PersonaNotFoundError } from './errors.js';
import {
  resolveVariableValues,
  substituteVariables as substituteVariablesCore,
  type SubstituteOptions,
} from './variables.js';
import type {
  ConversationPersonaStore,
  Persona,
  PersonaInput,
  PersonaRecord,
  PersonaStore,
} from './types.js';

/** Generates unique persona ids (injectable for deterministic tests). */
export interface PersonaIdGenerator {
  /** A unique persona id. */
  id(): string;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: PersonaIdGenerator = {
  id: () => randomUUID(),
};

/** Construction dependencies for the {@link PersonaManager}. */
export interface PersonaManagerOptions {
  /** The owner-scoped custom-persona store (tenant-aware `PersonaRepository`). */
  personas: PersonaStore;
  /** The conversation-update seam used by {@link PersonaManager.apply} (Req 9.3). */
  conversations: ConversationPersonaStore;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: PersonaIdGenerator;
  /** Injected clock for deterministic `createdAt` timestamps in tests. */
  now?: () => Date;
}

/** Map a persisted {@link PersonaRecord} to the domain {@link Persona}. */
function recordToPersona(record: PersonaRecord): Persona {
  const persona: Persona = {
    id: record.id,
    name: record.name,
    category: record.category,
    systemPrompt: record.systemPrompt,
    isDefault: record.isDefault,
    variables: record.variables.map((v) => ({ ...v })),
  };
  if (record.ownerId !== null) persona.ownerId = record.ownerId;
  return persona;
}

/**
 * The Persona_Manager service. One method per acceptance criterion (Req 9.1-9.5)
 * plus the {@link resolveSystemPrompt} convenience the Chat_Service uses on send.
 */
export class PersonaManager {
  private readonly personas: PersonaStore;
  private readonly conversations: ConversationPersonaStore;
  private readonly idGenerator: PersonaIdGenerator;
  private readonly now: () => Date;

  constructor(options: PersonaManagerOptions) {
    this.personas = options.personas;
    this.conversations = options.conversations;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The default persona applied when a user selects no other persona (Req 9.1).
   *
   * @returns A fresh clone of the built-in default persona.
   */
  getDefault(): Persona {
    return getDefaultPersona();
  }

  /**
   * The categorized predefined personas (Req 9.2).
   *
   * Covers at minimum engineering, sales, product, and marketing. Excludes the
   * default persona (which {@link getDefault} returns).
   *
   * @returns Fresh clones of the predefined catalog personas.
   */
  listPredefined(): Persona[] {
    return builtInPersonas().filter((persona) => !persona.isDefault);
  }

  /**
   * List the personas available to the acting user: the built-in catalog plus
   * the user's own custom personas (Req 9.2, 9.4).
   *
   * @param ctx The caller's tenant context (scopes custom personas to the user).
   * @returns Built-in personas followed by the user's custom personas.
   */
  async listAvailable(ctx: TenantContext): Promise<Persona[]> {
    const owned = await this.personas.listOwned(ctx);
    return [...builtInPersonas(), ...owned.map(recordToPersona)];
  }

  /**
   * Resolve a persona by id for the acting user: a built-in catalog persona or
   * one the user owns (Req 9.3, 9.4).
   *
   * @param ctx The caller's tenant context.
   * @param personaId The persona id to resolve.
   * @returns The persona.
   * @throws PersonaNotFoundError if no built-in or owned persona matches.
   */
  async getPersona(ctx: TenantContext, personaId: string): Promise<Persona> {
    const builtIn = findBuiltInPersona(personaId);
    if (builtIn !== undefined) return builtIn;
    const owned = await this.personas.findById(ctx, personaId);
    if (owned === null) throw new PersonaNotFoundError(personaId);
    return recordToPersona(owned);
  }

  /**
   * Apply a persona to a conversation (Req 9.3).
   *
   * Verifies the persona exists for the user and the conversation exists within
   * the caller's Organization, then records the selection by setting the
   * conversation's `personaId`. The **Chat_Service** subsequently reads this
   * persona and applies its (variable-substituted) system prompt to every
   * following model request in the conversation — the manager itself performs no
   * model call here.
   *
   * @param ctx The caller's tenant context.
   * @param conversationId The conversation to apply the persona to.
   * @param personaId The persona to apply (built-in or owned).
   * @throws PersonaNotFoundError if the persona does not exist for the user.
   * @throws ConversationNotFoundError if the conversation is not in the tenant.
   */
  async apply(ctx: TenantContext, conversationId: string, personaId: string): Promise<void> {
    // Validate the persona resolves for this user (built-in or owned).
    await this.getPersona(ctx, personaId);

    const conversation = await this.conversations.findById(ctx, conversationId);
    if (conversation === null) throw new ConversationNotFoundError(conversationId);

    const updated = await this.conversations.update(ctx, conversationId, { personaId });
    if (updated === null) throw new ConversationNotFoundError(conversationId);
  }

  /**
   * Create and save a custom persona owned by the acting user (Req 9.4).
   *
   * @param ctx The caller's tenant context (the persona is owned by `ctx.userId`).
   * @param input The custom persona fields (name + systemPrompt required).
   * @returns The persisted custom persona.
   * @throws InvalidPersonaError if a required field is missing/blank.
   */
  async createCustom(ctx: TenantContext, input: PersonaInput): Promise<Persona> {
    const name = input.name?.trim();
    if (name === undefined || name.length === 0) {
      throw new InvalidPersonaError('name');
    }
    if (input.systemPrompt === undefined || input.systemPrompt.length === 0) {
      throw new InvalidPersonaError('systemPrompt');
    }

    const record: PersonaRecord = {
      id: input.id ?? this.idGenerator.id(),
      ownerId: ctx.userId,
      name,
      category: input.category?.trim() === '' ? 'custom' : (input.category ?? 'custom'),
      systemPrompt: input.systemPrompt,
      isDefault: false,
      variables: (input.variables ?? []).map((v) => ({ ...v })),
      createdAt: this.now().toISOString(),
    };

    const saved = await this.personas.create(ctx, record);
    return recordToPersona(saved);
  }

  /**
   * Substitute declared `{{name}}` variables in a system prompt before it is sent
   * to the model (Req 9.5).
   *
   * Delegates to the shared substitution core also used by the Prompt_Library
   * (Property 24), so behavior is identical across both. By default unknown
   * placeholders are left intact; pass `onMissing` to change that.
   *
   * @param prompt The system prompt containing `{{name}}` placeholders.
   * @param vars The variable values, keyed by name.
   * @param options Optional missing-value behavior (defaults to `leave`).
   * @returns The prompt with all resolvable placeholders substituted.
   */
  substituteVariables(
    prompt: string,
    vars: Record<string, string>,
    options?: SubstituteOptions,
  ): string {
    return substituteVariablesCore(prompt, vars, options);
  }

  /**
   * Resolve the system prompt the Chat_Service should send for a persona on the
   * next message (Req 9.3 + 9.5).
   *
   * Loads the persona (built-in or owned), layers the caller-provided values
   * over each declared variable's default (so every declared variable resolves),
   * and substitutes them into the persona's system prompt. This is the single
   * call the Chat_Service makes to turn a conversation's `personaId` into a
   * ready-to-send system prompt.
   *
   * @param ctx The caller's tenant context.
   * @param personaId The persona to resolve.
   * @param vars Caller-supplied variable values (override declared defaults).
   * @returns The fully-substituted system prompt.
   * @throws PersonaNotFoundError if the persona does not exist for the user.
   * @throws MissingVariableError if a required variable has no value or default.
   */
  async resolveSystemPrompt(
    ctx: TenantContext,
    personaId: string,
    vars: Record<string, string> = {},
  ): Promise<string> {
    const persona = await this.getPersona(ctx, personaId);
    const values = resolveVariableValues(persona.variables, vars);
    return substituteVariablesCore(persona.systemPrompt, values, { onMissing: 'leave' });
  }
}
