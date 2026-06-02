/**
 * Test fakes and builders for the agent-template catalog (Req 16.4, 16.5).
 *
 * The agent-template module is pure (a constant catalog plus pure discovery and
 * creation functions), so the only fixtures worth sharing are small builders
 * that produce a valid {@link AgentTemplate} / {@link AgentTemplateOverrides}
 * with sensible defaults, overridable field-by-field. These let unit and the
 * companion property test (task 15.9, Property 37) drive
 * {@link import('./create.js').createFromTemplate} deterministically and assert
 * the copied configuration without hand-writing a full template each time.
 *
 * Import these directly from `./fakes.js` in tests, never from a package barrel.
 */

import type { AgentTemplate, AgentTemplateOverrides, SafetyLimits } from './types.js';

/** Build a valid {@link SafetyLimits} with sensible, within-ceiling defaults. */
export function makeSafetyLimits(overrides: Partial<SafetyLimits> = {}): SafetyLimits {
  return {
    maxSteps: 25,
    maxDurationMs: 5 * 60 * 1000,
    budgetCap: 3,
    ...overrides,
  };
}

/**
 * Build a valid {@link AgentTemplate} with deterministic defaults, overridable
 * field-by-field.
 *
 * The defaults form a complete, valid template (a non-blank prompt/model, a
 * duplicate-free Allow_List, and within-ceiling limits) so a test can pass it
 * straight to {@link import('./create.js').createFromTemplate} with no setup.
 */
export function makeAgentTemplate(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    id: 'agent-template-test',
    name: 'Test Agent',
    category: 'research',
    description: 'A test agent template.',
    systemPrompt: 'You are a helpful test agent.',
    allowedTools: ['web_search', 'create_page'],
    model: 'gpt-4o',
    safetyLimits: makeSafetyLimits(),
    ...overrides,
  };
}

/**
 * Build an {@link AgentTemplateOverrides} object; defaults to an empty object
 * (a verbatim copy) and is overridable field-by-field.
 */
export function makeOverrides(
  overrides: Partial<AgentTemplateOverrides> = {},
): AgentTemplateOverrides {
  return { ...overrides };
}
