/**
 * The built-in persona catalog (Req 9.1, 9.2).
 *
 * The default persona (Req 9.1) and the categorized predefined personas
 * (Req 9.2) are shipped as a constant catalog rather than seeded rows, so they
 * are always available without a database migration or seed step. The catalog
 * covers — at minimum — the engineering, sales, product, and marketing
 * categories required by Req 9.2 (see {@link REQUIRED_PERSONA_CATEGORIES}); the
 * Persona_Manager and a deployment may additionally persist these as NULL-owner
 * shared rows, but correctness never depends on that.
 *
 * Built-in personas have no `ownerId` and use stable `persona-*` ids so a
 * conversation's `personaId` (Req 9.3) and any UI references remain stable
 * across deployments. Several include declared `{{variables}}` to exercise the
 * shared substitution core (Req 9.5).
 */

import type { Persona } from './types.js';

/** The stable id of the built-in default persona (Req 9.1). */
export const DEFAULT_PERSONA_ID = 'persona-default' as const;

/**
 * The default persona applied when a user selects no other persona (Req 9.1).
 *
 * It is the single persona with `isDefault: true`. Its prompt declares an
 * optional `{{tone}}` variable (resolved from its default) so the default path
 * still flows through variable substitution (Req 9.5).
 */
export const DEFAULT_PERSONA: Persona = {
  id: DEFAULT_PERSONA_ID,
  name: 'Default Assistant',
  category: 'general',
  systemPrompt:
    'You are Auxify, a helpful, accurate, and concise AI assistant. ' +
    'Respond in a {{tone}} tone, ask for clarification when a request is ambiguous, ' +
    'and clearly state any assumptions you make.',
  isDefault: true,
  variables: [
    {
      name: 'tone',
      description: 'The conversational tone the assistant should adopt.',
      defaultValue: 'professional',
    },
  ],
};

/**
 * The categorized predefined personas (Req 9.2).
 *
 * Covers engineering, sales, product, and marketing (the required minimum) plus
 * a couple of broadly-useful extras. None is the default; exactly the
 * {@link DEFAULT_PERSONA} carries `isDefault: true`.
 */
export const PREDEFINED_PERSONAS: readonly Persona[] = [
  {
    id: 'persona-engineering-senior',
    name: 'Senior Software Engineer',
    category: 'engineering',
    systemPrompt:
      'You are a senior software engineer. Prefer correct, idiomatic, and well-tested ' +
      'code. Explain trade-offs briefly, call out edge cases and failure modes, and ' +
      'follow {{language}} best practices. Default to secure, performant solutions.',
    isDefault: false,
    variables: [
      {
        name: 'language',
        description: 'The primary programming language or stack.',
        defaultValue: 'the project',
      },
    ],
  },
  {
    id: 'persona-engineering-reviewer',
    name: 'Code Reviewer',
    category: 'engineering',
    systemPrompt:
      'You are a meticulous code reviewer. Identify bugs, security issues, and ' +
      'maintainability problems. Be specific and constructive, cite the relevant lines, ' +
      'and suggest concrete fixes rather than vague advice.',
    isDefault: false,
    variables: [],
  },
  {
    id: 'persona-sales-account-exec',
    name: 'Account Executive',
    category: 'sales',
    systemPrompt:
      'You are an experienced B2B account executive. Write persuasive, customer-focused ' +
      'messaging that leads with value, addresses objections, and ends with a clear next ' +
      'step. Adapt tone for {{audience}} and keep it concise.',
    isDefault: false,
    variables: [
      {
        name: 'audience',
        description: 'The target audience or buyer persona.',
        defaultValue: 'a business decision-maker',
      },
    ],
  },
  {
    id: 'persona-product-manager',
    name: 'Product Manager',
    category: 'product',
    systemPrompt:
      'You are a pragmatic product manager. Frame problems in terms of user value and ' +
      'business impact, structure thinking with clear requirements and acceptance ' +
      'criteria, and prioritize ruthlessly. Surface risks and open questions explicitly.',
    isDefault: false,
    variables: [],
  },
  {
    id: 'persona-marketing-content',
    name: 'Content Marketer',
    category: 'marketing',
    systemPrompt:
      'You are a skilled content marketer. Produce clear, engaging, on-brand copy for ' +
      '{{channel}}. Lead with a strong hook, keep paragraphs short, and align tone with ' +
      'the target audience. Avoid hype and unsupported claims.',
    isDefault: false,
    variables: [
      {
        name: 'channel',
        description: 'The marketing channel or format (blog, email, social, etc.).',
        defaultValue: 'a blog post',
      },
    ],
  },
] as const;

/**
 * The built-in default persona, applied when no other is selected (Req 9.1).
 *
 * @returns A fresh clone of the default persona.
 */
export function getDefaultPersona(): Persona {
  return clonePersona(DEFAULT_PERSONA);
}

/**
 * Every built-in persona: the default plus the predefined catalog (Req 9.1, 9.2).
 *
 * Returned as fresh clones so callers can never mutate the shared constants.
 */
export function builtInPersonas(): Persona[] {
  return [DEFAULT_PERSONA, ...PREDEFINED_PERSONAS].map(clonePersona);
}

/** Look up a built-in persona by id, or `undefined` (returns a clone). */
export function findBuiltInPersona(id: string): Persona | undefined {
  const found = [DEFAULT_PERSONA, ...PREDEFINED_PERSONAS].find((p) => p.id === id);
  return found === undefined ? undefined : clonePersona(found);
}

/** Deep-enough clone of a persona so the shared catalog constants stay immutable. */
export function clonePersona(persona: Persona): Persona {
  const clone: Persona = {
    id: persona.id,
    name: persona.name,
    category: persona.category,
    systemPrompt: persona.systemPrompt,
    isDefault: persona.isDefault,
    variables: persona.variables.map((v) => ({ ...v })),
  };
  if (persona.ownerId !== undefined) clone.ownerId = persona.ownerId;
  return clone;
}
