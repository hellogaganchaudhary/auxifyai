/**
 * Unit tests for the Persona_Manager (Req 9.1-9.5).
 *
 * These exercise each acceptance criterion with concrete examples and edge
 * cases, against the in-memory {@link InMemoryPersonaStore} and
 * {@link InMemoryConversationPersonaStore} fakes (no database):
 *   - {@link getDefault} returns the single default persona (Req 9.1);
 *   - {@link listPredefined} covers the required categories (Req 9.2);
 *   - {@link apply} records the persona on the conversation and fails closed for
 *     unknown personas/conversations (Req 9.3);
 *   - {@link createCustom} persists an owner-scoped persona and validates input
 *     (Req 9.4); and
 *   - {@link substituteVariables} / {@link resolveSystemPrompt} substitute
 *     declared variables completely (Req 9.5).
 *
 * The exhaustive over-all-inputs completeness guarantee lives in the companion
 * property test (task 9.2, Property 24).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import {
  InvalidPersonaError,
  PersonaManager,
  PersonaNotFoundError,
  REQUIRED_PERSONA_CATEGORIES,
} from './index.js';
import { ConversationNotFoundError } from '../conversations/index.js';
import {
  InMemoryConversationPersonaStore,
  InMemoryPersonaStore,
  makeConversationRecord,
  makePersonaRecord,
  sequentialPersonaIdGenerator,
} from './fakes.js';

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };
const otherUserCtx: TenantContext = { organizationId: 'org-1', userId: 'user-2' };

function makeManager(): {
  manager: PersonaManager;
  personas: InMemoryPersonaStore;
  conversations: InMemoryConversationPersonaStore;
} {
  const personas = new InMemoryPersonaStore();
  const conversations = new InMemoryConversationPersonaStore(
    () => new Date('2026-02-01T00:00:00.000Z'),
  );
  const manager = new PersonaManager({
    personas,
    conversations,
    idGenerator: sequentialPersonaIdGenerator(),
    now: () => new Date('2026-02-01T00:00:00.000Z'),
  });
  return { manager, personas, conversations };
}

// ---------------------------------------------------------------------------
// Req 9.1 — default persona.
// ---------------------------------------------------------------------------

describe('PersonaManager.getDefault (Req 9.1)', () => {
  it('returns a persona marked as the default', () => {
    const { manager } = makeManager();
    const def = manager.getDefault();
    expect(def.isDefault).toBe(true);
    expect(def.systemPrompt.length).toBeGreaterThan(0);
    expect(def.ownerId).toBeUndefined();
  });

  it('is the only default among all built-in personas', () => {
    const { manager } = makeManager();
    const predefined = manager.listPredefined();
    expect(predefined.every((p) => !p.isDefault)).toBe(true);
  });

  it('returns a fresh clone each call (callers cannot mutate the catalog)', () => {
    const { manager } = makeManager();
    const a = manager.getDefault();
    a.systemPrompt = 'mutated';
    a.variables.push({ name: 'injected' });
    const b = manager.getDefault();
    expect(b.systemPrompt).not.toBe('mutated');
    expect(b.variables.some((v) => v.name === 'injected')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Req 9.2 — categorized predefined personas.
// ---------------------------------------------------------------------------

describe('PersonaManager.listPredefined (Req 9.2)', () => {
  it('covers at minimum engineering, sales, product, and marketing', () => {
    const { manager } = makeManager();
    const categories = new Set(manager.listPredefined().map((p) => p.category));
    for (const required of REQUIRED_PERSONA_CATEGORIES) {
      expect(categories.has(required)).toBe(true);
    }
  });

  it('returns personas with non-empty prompts and stable ids', () => {
    const { manager } = makeManager();
    for (const persona of manager.listPredefined()) {
      expect(persona.id.length).toBeGreaterThan(0);
      expect(persona.systemPrompt.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Req 9.3 — apply a persona to a conversation.
// ---------------------------------------------------------------------------

describe('PersonaManager.apply (Req 9.3)', () => {
  it('records the selected persona on the conversation', async () => {
    const { manager, conversations } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'conv-1', personaId: null }));

    await manager.apply(ctx, 'conv-1', 'persona-engineering-senior');

    const updated = await conversations.findById(ctx, 'conv-1');
    expect(updated?.personaId).toBe('persona-engineering-senior');
  });

  it('applies a user-owned custom persona', async () => {
    const { manager, conversations, personas } = makeManager();
    personas.seed(makePersonaRecord({ id: 'persona-custom-1', ownerId: 'user-1' }));
    conversations.seed(makeConversationRecord({ id: 'conv-1' }));

    await manager.apply(ctx, 'conv-1', 'persona-custom-1');

    const updated = await conversations.findById(ctx, 'conv-1');
    expect(updated?.personaId).toBe('persona-custom-1');
  });

  it('throws PersonaNotFoundError for an unknown persona', async () => {
    const { manager, conversations } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'conv-1' }));
    await expect(manager.apply(ctx, 'conv-1', 'persona-missing')).rejects.toBeInstanceOf(
      PersonaNotFoundError,
    );
  });

  it('throws ConversationNotFoundError for a conversation outside the tenant', async () => {
    const { manager, conversations } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'conv-1', organizationId: 'org-2' }));
    await expect(manager.apply(ctx, 'conv-1', 'persona-engineering-senior')).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
  });

  it("cannot apply another user's custom persona", async () => {
    const { manager, conversations, personas } = makeManager();
    personas.seed(makePersonaRecord({ id: 'persona-custom-1', ownerId: 'user-2' }));
    conversations.seed(makeConversationRecord({ id: 'conv-1' }));
    await expect(manager.apply(ctx, 'conv-1', 'persona-custom-1')).rejects.toBeInstanceOf(
      PersonaNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Req 9.4 — create custom personas.
// ---------------------------------------------------------------------------

describe('PersonaManager.createCustom (Req 9.4)', () => {
  it('persists a custom persona owned by the acting user', async () => {
    const { manager, personas } = makeManager();
    const persona = await manager.createCustom(ctx, {
      name: 'Legal Reviewer',
      systemPrompt: 'You review contracts for {{jurisdiction}}.',
      category: 'legal',
      variables: [{ name: 'jurisdiction', defaultValue: 'the US' }],
    });

    expect(persona.ownerId).toBe('user-1');
    expect(persona.id).toBe('persona-custom-1');
    expect(persona.isDefault).toBe(false);

    const stored = await personas.findById(ctx, persona.id);
    expect(stored?.name).toBe('Legal Reviewer');
  });

  it('defaults the category to "custom" when omitted or blank', async () => {
    const { manager } = makeManager();
    const a = await manager.createCustom(ctx, { name: 'A', systemPrompt: 'p' });
    const b = await manager.createCustom(ctx, { name: 'B', systemPrompt: 'p', category: '  ' });
    expect(a.category).toBe('custom');
    expect(b.category).toBe('custom');
  });

  it('rejects a missing name', async () => {
    const { manager } = makeManager();
    await expect(
      manager.createCustom(ctx, { name: '   ', systemPrompt: 'p' }),
    ).rejects.toBeInstanceOf(InvalidPersonaError);
  });

  it('rejects a missing system prompt', async () => {
    const { manager } = makeManager();
    await expect(manager.createCustom(ctx, { name: 'X', systemPrompt: '' })).rejects.toBeInstanceOf(
      InvalidPersonaError,
    );
  });

  it('does not surface a custom persona to another user', async () => {
    const { manager } = makeManager();
    const persona = await manager.createCustom(ctx, { name: 'Private', systemPrompt: 'secret' });
    await expect(manager.getPersona(otherUserCtx, persona.id)).rejects.toBeInstanceOf(
      PersonaNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Req 9.5 — variable substitution.
// ---------------------------------------------------------------------------

describe('PersonaManager.substituteVariables (Req 9.5)', () => {
  it('replaces every declared placeholder with its value', () => {
    const { manager } = makeManager();
    const out = manager.substituteVariables('Hi {{name}}, welcome to {{place}}.', {
      name: 'Sam',
      place: 'Auxify',
    });
    expect(out).toBe('Hi Sam, welcome to Auxify.');
  });

  it('replaces repeated occurrences of the same variable', () => {
    const { manager } = makeManager();
    const out = manager.substituteVariables('{{x}}-{{x}}-{{x}}', { x: 'a' });
    expect(out).toBe('a-a-a');
  });

  it('tolerates inner whitespace in placeholders', () => {
    const { manager } = makeManager();
    expect(manager.substituteVariables('{{ name }}', { name: 'Sam' })).toBe('Sam');
  });

  it('leaves unknown placeholders intact by default', () => {
    const { manager } = makeManager();
    expect(manager.substituteVariables('{{a}} {{b}}', { a: '1' })).toBe('1 {{b}}');
  });

  it('does not re-scan substituted values that look like placeholders', () => {
    const { manager } = makeManager();
    expect(manager.substituteVariables('{{a}}', { a: '{{b}}', b: 'x' })).toBe('{{b}}');
  });

  it('resolveSystemPrompt fills declared defaults then overrides', async () => {
    const { manager } = makeManager();
    const persona = await manager.createCustom(ctx, {
      name: 'Greeter',
      systemPrompt: 'Greet {{name}} in a {{tone}} tone.',
      variables: [
        { name: 'name', required: true },
        { name: 'tone', defaultValue: 'friendly' },
      ],
    });

    const prompt = await manager.resolveSystemPrompt(ctx, persona.id, { name: 'Sam' });
    expect(prompt).toBe('Greet Sam in a friendly tone.');
  });

  it('resolveSystemPrompt on the default persona substitutes its default tone', async () => {
    const { manager } = makeManager();
    const def = manager.getDefault();
    const prompt = await manager.resolveSystemPrompt(ctx, def.id);
    expect(prompt).toContain('professional');
    expect(prompt).not.toContain('{{tone}}');
  });
});
