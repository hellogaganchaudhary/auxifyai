/**
 * Property-based test for **Property 37: Creating an agent from a template
 * copies its configuration** (design "Property 37"; Req 16.5).
 *
 * Validates: Requirements 16.5
 *
 * Property 37 (design): _For any_ agent template, an agent created from it has
 * system prompt, allowed tools, model, and safety limits equal to those of the
 * template. Requirement 16.5: when a user creates an agent from a template, the
 * platform copies the template's system prompt, allowed tools, model, and
 * safety limits into the new agent.
 *
 * This file exercises the real {@link createFromTemplate} from `./create.js`
 * (built in task 15.8) against arbitrary valid templates and a wide mix of
 * overrides — empty, partial, full, and invalid. It is self-contained: it builds
 * its templates/overrides with the shared fakes ({@link makeAgentTemplate},
 * {@link makeSafetyLimits}, {@link makeOverrides}) imported directly from
 * `./fakes.js`, and it cross-checks the produced {@link AgentDefinition} against
 * an independent oracle ({@link expectedDefinition}) derived from the generated
 * template + overrides — so the test never re-uses production code to compute
 * the expected result.
 *
 * Three properties are asserted across arbitrary inputs (>= 100 runs each):
 *   1. With no overrides (or an empty object), the produced definition copies
 *      the template's `systemPrompt`/`allowedTools`/`model`/`safetyLimits`
 *      verbatim, links `templateId` to the template's id, and shares no
 *      array/object reference with the template (mutating the result never
 *      mutates the template).
 *   2. With valid overrides, the produced definition equals the oracle's merge
 *      of the template and overrides exactly — each present override replaces
 *      its field (trimmed), and every absent field is copied verbatim.
 *   3. With an invalid override (a blank required string, a blank or duplicate
 *      tool id, or a non-positive / over-ceiling safety limit),
 *      {@link createFromTemplate} fails closed with an
 *      {@link InvalidTemplateOverrideError} naming the offending field.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createFromTemplate } from './create.js';
import { InvalidTemplateOverrideError } from './errors.js';
import { makeAgentTemplate, makeOverrides, makeSafetyLimits } from './fakes.js';
import {
  SAFETY_LIMIT_CEILINGS,
  type AgentDefinition,
  type AgentTemplate,
  type AgentTemplateOverrides,
  type SafetyLimits,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

/** Stable tool ids the Tool_Registry gates (used to build Allow_Lists). */
const TOOL_ID_POOL = [
  'web_search',
  'create_page',
  'run_code',
  'sql_query',
  'send_message',
  'github_issue',
] as const;

/** A small pool of model ids. */
const MODEL_POOL = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4'] as const;

/** Whitespace-only / empty strings — every one is "blank" after `trim()`. */
const BLANK_POOL = ['', ' ', '   ', '\t', '\n', '  \t '] as const;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A string that is guaranteed non-blank after `trim()` (it always contains a
 * non-whitespace core), while still exercising arbitrary surrounding content —
 * including leading/trailing whitespace so the test covers `createFromTemplate`'s
 * trimming of string overrides.
 */
const nonBlankArb: fc.Arbitrary<string> = fc
  .tuple(fc.string(), fc.constantFrom('a', 'x', 'core', 'Z9', 'word'), fc.string())
  .map(([prefix, core, suffix]) => `${prefix}${core}${suffix}`);

/** 1..N unique, non-blank tool ids drawn from the pool. */
const toolsArb: fc.Arbitrary<string[]> = fc.uniqueArray(fc.constantFrom(...TOOL_ID_POOL), {
  minLength: 1,
  maxLength: TOOL_ID_POOL.length,
});

/** Valid, within-ceiling, positive safety limits. */
const limitsArb: fc.Arbitrary<SafetyLimits> = fc
  .record({
    maxSteps: fc.integer({ min: 1, max: SAFETY_LIMIT_CEILINGS.maxSteps }),
    maxDurationMs: fc.integer({ min: 1, max: SAFETY_LIMIT_CEILINGS.maxDurationMs }),
    budgetCap: fc.integer({ min: 1, max: 1000 }),
  })
  .map((l) => makeSafetyLimits(l));

/** An arbitrary valid template built via {@link makeAgentTemplate}. */
const templateArb: fc.Arbitrary<AgentTemplate> = fc
  .record({
    name: nonBlankArb,
    systemPrompt: nonBlankArb,
    model: fc.constantFrom(...MODEL_POOL),
    allowedTools: toolsArb,
    safetyLimits: limitsArb,
  })
  .map((parts) =>
    makeAgentTemplate({
      name: parts.name,
      systemPrompt: parts.systemPrompt,
      model: parts.model,
      allowedTools: parts.allowedTools,
      safetyLimits: parts.safetyLimits,
    }),
  );

/** A partial, all-valid safety-limit override (each supplied limit positive & within ceiling). */
const partialLimitsArb: fc.Arbitrary<Partial<SafetyLimits>> = fc
  .record({
    maxSteps: fc.option(fc.integer({ min: 1, max: SAFETY_LIMIT_CEILINGS.maxSteps }), {
      nil: undefined,
    }),
    maxDurationMs: fc.option(fc.integer({ min: 1, max: SAFETY_LIMIT_CEILINGS.maxDurationMs }), {
      nil: undefined,
    }),
    budgetCap: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
  })
  .map((l) => {
    const out: Partial<SafetyLimits> = {};
    if (l.maxSteps !== undefined) out.maxSteps = l.maxSteps;
    if (l.maxDurationMs !== undefined) out.maxDurationMs = l.maxDurationMs;
    if (l.budgetCap !== undefined) out.budgetCap = l.budgetCap;
    return out;
  });

/**
 * Arbitrary valid overrides: each field is independently present-or-absent, so
 * the generator covers the empty, partial, and full-override cases.
 */
const validOverridesArb: fc.Arbitrary<AgentTemplateOverrides> = fc
  .record({
    name: fc.option(nonBlankArb, { nil: undefined }),
    systemPrompt: fc.option(nonBlankArb, { nil: undefined }),
    model: fc.option(fc.constantFrom(...MODEL_POOL), { nil: undefined }),
    allowedTools: fc.option(toolsArb, { nil: undefined }),
    safetyLimits: fc.option(partialLimitsArb, { nil: undefined }),
  })
  .map((o) => {
    const ov: AgentTemplateOverrides = {};
    if (o.name !== undefined) ov.name = o.name;
    if (o.systemPrompt !== undefined) ov.systemPrompt = o.systemPrompt;
    if (o.model !== undefined) ov.model = o.model;
    if (o.allowedTools !== undefined) ov.allowedTools = o.allowedTools;
    if (o.safetyLimits !== undefined) ov.safetyLimits = o.safetyLimits;
    return makeOverrides(ov);
  });

/** One invalid override paired with the field `createFromTemplate` should name. */
interface InvalidCase {
  override: AgentTemplateOverrides;
  field: string;
}

/** A blank string (blank after trim). */
const blankArb: fc.Arbitrary<string> = fc.constantFrom(...BLANK_POOL);

/** A non-positive / non-finite limit value (always rejected by `validateLimit`). */
const badLimitArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -1000, max: -1 }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
);

/**
 * An override invalid in exactly one field (every other field absent), so the
 * offending field is deterministic given `createFromTemplate`'s validation
 * order (name -> systemPrompt -> model -> allowedTools -> safetyLimits).
 */
const invalidCaseArb: fc.Arbitrary<InvalidCase> = fc.oneof(
  blankArb.map((v): InvalidCase => ({ override: { name: v }, field: 'name' })),
  blankArb.map((v): InvalidCase => ({ override: { systemPrompt: v }, field: 'systemPrompt' })),
  blankArb.map((v): InvalidCase => ({ override: { model: v }, field: 'model' })),
  // A blank tool id appended to an otherwise-valid Allow_List.
  fc
    .tuple(toolsArb, blankArb)
    .map(
      ([tools, blank]): InvalidCase => ({
        override: { allowedTools: [...tools, blank] },
        field: 'allowedTools',
      }),
    ),
  // A duplicate tool id.
  fc
    .constantFrom(...TOOL_ID_POOL)
    .map((t): InvalidCase => ({ override: { allowedTools: [t, t] }, field: 'allowedTools' })),
  // Non-positive / non-finite individual limits.
  badLimitArb.map(
    (v): InvalidCase => ({ override: { safetyLimits: { maxSteps: v } }, field: 'safetyLimits.maxSteps' }),
  ),
  badLimitArb.map(
    (v): InvalidCase => ({
      override: { safetyLimits: { maxDurationMs: v } },
      field: 'safetyLimits.maxDurationMs',
    }),
  ),
  badLimitArb.map(
    (v): InvalidCase => ({
      override: { safetyLimits: { budgetCap: v } },
      field: 'safetyLimits.budgetCap',
    }),
  ),
  // Over-ceiling step / duration limits.
  fc.integer({ min: 1, max: 1000 }).map(
    (d): InvalidCase => ({
      override: { safetyLimits: { maxSteps: SAFETY_LIMIT_CEILINGS.maxSteps + d } },
      field: 'safetyLimits.maxSteps',
    }),
  ),
  fc.integer({ min: 1, max: 100_000 }).map(
    (d): InvalidCase => ({
      override: { safetyLimits: { maxDurationMs: SAFETY_LIMIT_CEILINGS.maxDurationMs + d } },
      field: 'safetyLimits.maxDurationMs',
    }),
  ),
);

// ---------------------------------------------------------------------------
// Independent oracle
// ---------------------------------------------------------------------------

/**
 * Compute the agent definition `createFromTemplate` should produce, derived
 * independently from the generated template + overrides. Mirrors the spec, not
 * the implementation: present string overrides replace their field (trimmed),
 * a present Allow_List replaces (trimmed per id), supplied safety limits merge
 * onto the template's, and every absent field is copied verbatim. `templateId`
 * always links back to the source template's id.
 */
function expectedDefinition(
  template: AgentTemplate,
  overrides: AgentTemplateOverrides,
): AgentDefinition {
  const safetyLimits: SafetyLimits = { ...template.safetyLimits };
  if (overrides.safetyLimits) {
    if (overrides.safetyLimits.maxSteps !== undefined) {
      safetyLimits.maxSteps = overrides.safetyLimits.maxSteps;
    }
    if (overrides.safetyLimits.maxDurationMs !== undefined) {
      safetyLimits.maxDurationMs = overrides.safetyLimits.maxDurationMs;
    }
    if (overrides.safetyLimits.budgetCap !== undefined) {
      safetyLimits.budgetCap = overrides.safetyLimits.budgetCap;
    }
  }
  return {
    name: overrides.name !== undefined ? overrides.name.trim() : template.name,
    systemPrompt:
      overrides.systemPrompt !== undefined ? overrides.systemPrompt.trim() : template.systemPrompt,
    model: overrides.model !== undefined ? overrides.model.trim() : template.model,
    allowedTools:
      overrides.allowedTools !== undefined
        ? overrides.allowedTools.map((t) => t.trim())
        : [...template.allowedTools],
    safetyLimits,
    templateId: template.id,
  };
}

// ---------------------------------------------------------------------------
// Property 37
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 37: Creating an agent from a template copies its configuration', () => {
  it('copies system prompt, allowed tools, model, and safety limits verbatim with no/empty overrides, links templateId, and shares no references (Validates: Requirements 16.5)', () => {
    fc.assert(
      fc.property(templateArb, (template) => {
        const def = createFromTemplate(template);

        // The four configuration fields are copied verbatim (Req 16.5).
        expect(def.systemPrompt).toBe(template.systemPrompt);
        expect(def.allowedTools).toEqual(template.allowedTools);
        expect(def.model).toBe(template.model);
        expect(def.safetyLimits).toEqual(template.safetyLimits);
        // Provenance link back to the source template.
        expect(def.templateId).toBe(template.id);
        // The whole definition equals the independent oracle's verbatim copy.
        expect(def).toEqual(expectedDefinition(template, {}));
        // An empty overrides object behaves exactly like omitting overrides.
        expect(createFromTemplate(template, {})).toEqual(def);

        // No shared array/object references with the template.
        expect(def.allowedTools).not.toBe(template.allowedTools);
        expect(def.safetyLimits).not.toBe(template.safetyLimits);

        // Mutating the produced definition never mutates the template.
        const toolsBefore = [...template.allowedTools];
        const stepsBefore = template.safetyLimits.maxSteps;
        def.allowedTools.push('__mutant_tool__');
        def.safetyLimits.maxSteps = template.safetyLimits.maxSteps + 7;
        expect(template.allowedTools).toEqual(toolsBefore);
        expect(template.safetyLimits.maxSteps).toBe(stepsBefore);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('applies valid overrides exactly: each present field is replaced and every absent field is copied verbatim (Validates: Requirements 16.5)', () => {
    fc.assert(
      fc.property(templateArb, validOverridesArb, (template, overrides) => {
        const def = createFromTemplate(template, overrides);

        // The produced definition equals the independent merge oracle exactly.
        expect(def).toEqual(expectedDefinition(template, overrides));
        // The provenance link is always the source template's id.
        expect(def.templateId).toBe(template.id);

        // Every field NOT overridden is copied verbatim from the template.
        if (overrides.name === undefined) expect(def.name).toBe(template.name);
        if (overrides.systemPrompt === undefined) {
          expect(def.systemPrompt).toBe(template.systemPrompt);
        }
        if (overrides.model === undefined) expect(def.model).toBe(template.model);
        if (overrides.allowedTools === undefined) {
          expect(def.allowedTools).toEqual(template.allowedTools);
        }
        if (overrides.safetyLimits === undefined) {
          expect(def.safetyLimits).toEqual(template.safetyLimits);
        } else {
          // A partial limits override inherits the limits it does not supply.
          if (overrides.safetyLimits.maxSteps === undefined) {
            expect(def.safetyLimits.maxSteps).toBe(template.safetyLimits.maxSteps);
          }
          if (overrides.safetyLimits.maxDurationMs === undefined) {
            expect(def.safetyLimits.maxDurationMs).toBe(template.safetyLimits.maxDurationMs);
          }
          if (overrides.safetyLimits.budgetCap === undefined) {
            expect(def.safetyLimits.budgetCap).toBe(template.safetyLimits.budgetCap);
          }
        }

        // The result still shares no references with the template.
        expect(def.allowedTools).not.toBe(template.allowedTools);
        expect(def.safetyLimits).not.toBe(template.safetyLimits);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('fails closed with InvalidTemplateOverrideError naming the offending field for an invalid override (Validates: Requirements 16.5)', () => {
    fc.assert(
      fc.property(templateArb, invalidCaseArb, (template, { override, field }) => {
        expect(() => createFromTemplate(template, override)).toThrow(InvalidTemplateOverrideError);
        try {
          createFromTemplate(template, override);
          expect.unreachable('expected an invalid override to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidTemplateOverrideError);
          expect((err as InvalidTemplateOverrideError).field).toBe(field);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
