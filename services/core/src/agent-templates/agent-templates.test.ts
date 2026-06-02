/**
 * Unit tests for the agent-template catalog and creation-from-template
 * (Req 16.4, 16.5).
 *
 * These exercise each acceptance criterion with concrete examples and edge
 * cases against the pure catalog and creation functions (no database, no ports):
 *   - the catalog lists the seven required templates across every required
 *     category (Req 16.4);
 *   - {@link getTemplate} resolves by id and fails closed for an unknown id
 *     (Req 16.4);
 *   - {@link createFromTemplate} copies the template's system prompt, allowed
 *     tools, model, and safety limits into the new definition (Req 16.5);
 *   - overrides replace the corresponding fields (and partial safety-limit
 *     overrides merge); and
 *   - an invalid override fails closed with a field-named error (Req 16.5).
 *
 * The exhaustive over-all-inputs copy guarantee lives in the companion property
 * test (task 15.9, Property 37).
 */

import { describe, expect, it } from 'vitest';

import {
  InvalidTemplateOverrideError,
  PREDEFINED_AGENT_TEMPLATES,
  REQUIRED_AGENT_TEMPLATE_CATEGORIES,
  SAFETY_LIMIT_CEILINGS,
  UnknownAgentTemplateError,
  createFromTemplate,
  findTemplate,
  getTemplate,
  listTemplates,
  type AgentTemplateCategory,
} from './index.js';
import { makeAgentTemplate, makeSafetyLimits } from './fakes.js';

// ---------------------------------------------------------------------------
// Req 16.4 — the pre-built catalog.
// ---------------------------------------------------------------------------

describe('agent-template catalog (Req 16.4)', () => {
  /** The seven templates the platform must ship, by display name. */
  const REQUIRED_TEMPLATE_NAMES = [
    'Research Agent',
    'Competitive Intel Agent',
    'Code Review Agent',
    'Content Writer Agent',
    'Lead Research Agent',
    'Report Generator Agent',
    'Bug Triage Agent',
  ] as const;

  it('ships all seven required pre-built templates', () => {
    const names = listTemplates().map((t) => t.name);
    for (const required of REQUIRED_TEMPLATE_NAMES) {
      expect(names).toContain(required);
    }
    expect(listTemplates()).toHaveLength(7);
  });

  it('covers every required category', () => {
    const categories = new Set(listTemplates().map((t) => t.category));
    for (const required of REQUIRED_AGENT_TEMPLATE_CATEGORIES) {
      expect(categories.has(required)).toBe(true);
    }
  });

  it('gives every template a unique, stable id', () => {
    const ids = listTemplates().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('agent-template-'))).toBe(true);
  });

  it('gives every template complete, within-ceiling configuration', () => {
    for (const template of listTemplates()) {
      expect(template.systemPrompt.length).toBeGreaterThan(0);
      expect(template.model.length).toBeGreaterThan(0);
      expect(template.allowedTools.length).toBeGreaterThan(0);
      // No duplicate tool ids in a shipped Allow_List.
      expect(new Set(template.allowedTools).size).toBe(template.allowedTools.length);
      // Limits are positive and within the platform ceilings (Req 15.2, 15.3).
      expect(template.safetyLimits.maxSteps).toBeGreaterThan(0);
      expect(template.safetyLimits.maxSteps).toBeLessThanOrEqual(SAFETY_LIMIT_CEILINGS.maxSteps);
      expect(template.safetyLimits.maxDurationMs).toBeGreaterThan(0);
      expect(template.safetyLimits.maxDurationMs).toBeLessThanOrEqual(
        SAFETY_LIMIT_CEILINGS.maxDurationMs,
      );
      expect(template.safetyLimits.budgetCap).toBeGreaterThan(0);
    }
  });

  it('returns fresh clones so the shared catalog cannot be mutated', () => {
    const first = listTemplates()[0]!;
    first.allowedTools.push('mutant_tool');
    first.name = 'mutated';
    const second = listTemplates()[0]!;
    expect(second.name).not.toBe('mutated');
    expect(second.allowedTools).not.toContain('mutant_tool');
  });
});

// ---------------------------------------------------------------------------
// Req 16.4 — discovery (findTemplate / getTemplate).
// ---------------------------------------------------------------------------

describe('agent-template discovery (Req 16.4)', () => {
  it('findTemplate resolves a known id and returns undefined for an unknown id', () => {
    const known = PREDEFINED_AGENT_TEMPLATES[0]!;
    expect(findTemplate(known.id)?.id).toBe(known.id);
    expect(findTemplate('agent-template-does-not-exist')).toBeUndefined();
  });

  it('getTemplate resolves a known id', () => {
    const known = PREDEFINED_AGENT_TEMPLATES[0]!;
    expect(getTemplate(known.id).id).toBe(known.id);
  });

  it('getTemplate throws UnknownAgentTemplateError for an unknown id', () => {
    expect(() => getTemplate('agent-template-nope')).toThrow(UnknownAgentTemplateError);
    try {
      getTemplate('agent-template-nope');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownAgentTemplateError);
      expect((err as UnknownAgentTemplateError).templateId).toBe('agent-template-nope');
      const platform = (err as UnknownAgentTemplateError).toPlatformError('corr-1');
      expect(platform.category).toBe('not_found');
      expect(platform.code).toBe('AGENT_TEMPLATE_NOT_FOUND');
    }
  });
});

// ---------------------------------------------------------------------------
// Req 16.5 — creation copies the template configuration.
// ---------------------------------------------------------------------------

describe('createFromTemplate copies configuration (Req 16.5)', () => {
  it('copies system prompt, allowed tools, model, and safety limits verbatim with no overrides', () => {
    const template = makeAgentTemplate({
      id: 'agent-template-x',
      name: 'X Agent',
      systemPrompt: 'Prompt X',
      allowedTools: ['web_search', 'run_code'],
      model: 'claude-sonnet-4',
      safetyLimits: makeSafetyLimits({ maxSteps: 12, maxDurationMs: 60_000, budgetCap: 2 }),
    });

    const def = createFromTemplate(template);

    expect(def.name).toBe('X Agent');
    expect(def.systemPrompt).toBe('Prompt X');
    expect(def.allowedTools).toEqual(['web_search', 'run_code']);
    expect(def.model).toBe('claude-sonnet-4');
    expect(def.safetyLimits).toEqual({ maxSteps: 12, maxDurationMs: 60_000, budgetCap: 2 });
    expect(def.templateId).toBe('agent-template-x');
  });

  it('treats an empty overrides object the same as no overrides', () => {
    const template = makeAgentTemplate();
    expect(createFromTemplate(template, {})).toEqual(createFromTemplate(template));
  });

  it('produces a definition that shares no array/object reference with the template', () => {
    const template = makeAgentTemplate();
    const def = createFromTemplate(template);
    def.allowedTools.push('extra_tool');
    def.safetyLimits.maxSteps = 999;
    expect(template.allowedTools).not.toContain('extra_tool');
    expect(template.safetyLimits.maxSteps).not.toBe(999);
  });

  it('works end to end against a real catalog template', () => {
    const template = getTemplate('agent-template-research');
    const def = createFromTemplate(template);
    expect(def.systemPrompt).toBe(template.systemPrompt);
    expect(def.allowedTools).toEqual(template.allowedTools);
    expect(def.model).toBe(template.model);
    expect(def.safetyLimits).toEqual(template.safetyLimits);
    expect(def.templateId).toBe('agent-template-research');
  });
});

// ---------------------------------------------------------------------------
// Req 16.5 — overrides are applied.
// ---------------------------------------------------------------------------

describe('createFromTemplate applies overrides (Req 16.5)', () => {
  it('replaces name, system prompt, model, and allowed tools', () => {
    const template = makeAgentTemplate();
    const def = createFromTemplate(template, {
      name: 'Renamed',
      systemPrompt: 'New prompt',
      model: 'gpt-4o-mini',
      allowedTools: ['sql_query'],
    });
    expect(def.name).toBe('Renamed');
    expect(def.systemPrompt).toBe('New prompt');
    expect(def.model).toBe('gpt-4o-mini');
    expect(def.allowedTools).toEqual(['sql_query']);
  });

  it('trims overridden string fields', () => {
    const def = createFromTemplate(makeAgentTemplate(), {
      name: '  Trimmed  ',
      model: '  gpt-4o  ',
    });
    expect(def.name).toBe('Trimmed');
    expect(def.model).toBe('gpt-4o');
  });

  it('merges a partial safety-limit override, inheriting the rest', () => {
    const template = makeAgentTemplate({
      safetyLimits: makeSafetyLimits({ maxSteps: 20, maxDurationMs: 120_000, budgetCap: 4 }),
    });
    const def = createFromTemplate(template, { safetyLimits: { maxSteps: 10 } });
    expect(def.safetyLimits).toEqual({ maxSteps: 10, maxDurationMs: 120_000, budgetCap: 4 });
  });
});

// ---------------------------------------------------------------------------
// Req 16.5 — invalid overrides fail closed.
// ---------------------------------------------------------------------------

describe('createFromTemplate rejects invalid overrides (Req 16.5)', () => {
  it('rejects a blank name', () => {
    expect(() => createFromTemplate(makeAgentTemplate(), { name: '   ' })).toThrow(
      InvalidTemplateOverrideError,
    );
  });

  it('rejects a blank system prompt and a blank model', () => {
    expect(() => createFromTemplate(makeAgentTemplate(), { systemPrompt: '' })).toThrow(
      InvalidTemplateOverrideError,
    );
    expect(() => createFromTemplate(makeAgentTemplate(), { model: '  ' })).toThrow(
      InvalidTemplateOverrideError,
    );
  });

  it('rejects a blank or duplicate tool id with a field-named error', () => {
    expect(() => createFromTemplate(makeAgentTemplate(), { allowedTools: ['ok', ''] })).toThrow(
      InvalidTemplateOverrideError,
    );
    try {
      createFromTemplate(makeAgentTemplate(), { allowedTools: ['dup', 'dup'] });
      expect.unreachable('expected a duplicate-tool override to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTemplateOverrideError);
      expect((err as InvalidTemplateOverrideError).field).toBe('allowedTools');
      const platform = (err as InvalidTemplateOverrideError).toPlatformError('corr-2');
      expect(platform.category).toBe('validation');
      expect(platform.code).toBe('INVALID_TEMPLATE_OVERRIDE');
    }
  });

  it('rejects a non-positive safety limit', () => {
    expect(() =>
      createFromTemplate(makeAgentTemplate(), { safetyLimits: { maxSteps: 0 } }),
    ).toThrow(InvalidTemplateOverrideError);
    expect(() =>
      createFromTemplate(makeAgentTemplate(), { safetyLimits: { budgetCap: -1 } }),
    ).toThrow(InvalidTemplateOverrideError);
  });

  it('rejects a safety limit that exceeds the platform ceiling (Req 15.2, 15.3)', () => {
    expect(() =>
      createFromTemplate(makeAgentTemplate(), {
        safetyLimits: { maxSteps: SAFETY_LIMIT_CEILINGS.maxSteps + 1 },
      }),
    ).toThrow(InvalidTemplateOverrideError);
    expect(() =>
      createFromTemplate(makeAgentTemplate(), {
        safetyLimits: { maxDurationMs: SAFETY_LIMIT_CEILINGS.maxDurationMs + 1 },
      }),
    ).toThrow(InvalidTemplateOverrideError);
  });

  it('accepts a safety limit exactly at the ceiling', () => {
    const def = createFromTemplate(makeAgentTemplate(), {
      safetyLimits: {
        maxSteps: SAFETY_LIMIT_CEILINGS.maxSteps,
        maxDurationMs: SAFETY_LIMIT_CEILINGS.maxDurationMs,
      },
    });
    expect(def.safetyLimits.maxSteps).toBe(SAFETY_LIMIT_CEILINGS.maxSteps);
    expect(def.safetyLimits.maxDurationMs).toBe(SAFETY_LIMIT_CEILINGS.maxDurationMs);
  });

  it('every required category is one of the declared union members', () => {
    const declared: AgentTemplateCategory[] = ['research', 'engineering', 'content'];
    for (const category of REQUIRED_AGENT_TEMPLATE_CATEGORIES) {
      expect(declared).toContain(category);
    }
  });
});
