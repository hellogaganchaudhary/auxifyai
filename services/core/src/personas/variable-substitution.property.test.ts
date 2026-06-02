/**
 * Property-based test for **Property 24: Variable substitution is complete**
 * (Req 9.5, 10.4), the shared `{{name}}` template core implemented by
 * {@link substituteVariables} at `services/core/src/personas/variables.ts`
 * (task 9.1) and reused by both the Persona_Manager (a persona's system prompt,
 * Req 9.5) and the Prompt_Library (a template's content, Req 10.4).
 *
 * Validates: Requirements 9.5, 10.4
 *
 * Requirement 9.5: _WHEN a persona system prompt contains defined variables,
 * THE Persona_Manager SHALL substitute the configured values before sending the
 * system prompt to the model._
 *
 * Requirement 10.4: _WHEN a prompt template defines variables, THE
 * Prompt_Library SHALL prompt the user for variable values and SHALL substitute
 * the values before use._
 *
 * Property statement (design.md): _for any_ persona or prompt template with
 * declared variables and a complete map of values, the produced text contains
 * no unresolved variable placeholders and every declared variable is replaced
 * by its provided value before the text is sent to the model.
 *
 * ## How the property is exercised
 *
 * Each generated case is a template assembled from a typed token stream — a mix
 * of literal segments (guaranteed brace-free, so they can never accidentally
 * form a placeholder) and `{{name}}` references to a set of distinct declared
 * variables, with arbitrary inner whitespace (`{{ name }}`). Because the token
 * stream is known, we can reconstruct the *exact* expected output independently
 * of the implementation and assert byte-for-byte equality — the strongest form
 * of "every declared variable is replaced by its provided value, in place,
 * everywhere it occurs".
 *
 * The facets below together pin down the completeness contract Property 24
 * names:
 *   1. **complete map** — with a value for every referenced variable the output
 *      equals the oracle and contains no unresolved placeholders;
 *   2. **literal insertion / no re-scan** — values that themselves look like
 *      `{{x}}` are inserted verbatim and never re-substituted;
 *   3. **extra values are ignored** — supplying values for variables the text
 *      never references does not change the (still complete) result;
 *   4. **missing-value policy** — an omitted referenced variable is handled per
 *      the documented `leave` / `empty` / `throw` policy; and
 *   5. **declared variables with defaults** — `resolveVariableValues` layers
 *      provided values over declared defaults into a complete map that leaves no
 *      placeholder unresolved (the Req 9.5 "defined variables" path).
 *
 * The real `substituteVariables` / `resolveVariableValues` are exercised
 * directly — no mocks — so the assertions test the production substitution path.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MissingVariableError } from './errors.js';
import type { VariableDef } from './types.js';
import {
  extractVariableNames,
  hasUnresolvedVariables,
  resolveVariableValues,
  substituteVariables,
} from './variables.js';

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Token model: a template is a stream of literal segments and `{{name}}` refs.
// ---------------------------------------------------------------------------

/** A literal (brace-free) segment of template text. */
interface LitToken {
  kind: 'lit';
  text: string;
}

/** A `{{name}}` reference to the declared variable at `index`, with inner whitespace. */
interface RefToken {
  kind: 'ref';
  index: number;
  lead: string;
  trail: string;
}

type Token = LitToken | RefToken;

/** Anything carrying declared names and a token stream can build text + an oracle. */
interface HasTokens {
  names: string[];
  tokens: Token[];
}

/** A full case: distinct declared names, a value per name, and a token stream. */
interface TemplateCase extends HasTokens {
  values: string[];
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** The exact character class a `{{name}}` variable name must match (VARIABLE_NAME_PATTERN). */
const NAME_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-'.split('');

/** A valid variable name (one or more name characters). */
const variableNameArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 10 })
  .map((cs) => cs.join(''));

/** Inner-placeholder whitespace variants the regex's `\s*` must absorb. */
const wsArb: fc.Arbitrary<string> = fc.constantFrom('', ' ', '  ', '\t', ' \t ');

/** A plain value with no brace characters, so it introduces no new placeholders. */
const plainValueArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 12 })
  .map((s) => s.replace(/[{}]/g, ''));

/**
 * A "tricky" value that may itself contain `{{...}}`-looking text, used to prove
 * substituted values are inserted literally and never re-scanned.
 */
const trickyValueArb: fc.Arbitrary<string> = fc.oneof(
  plainValueArb,
  variableNameArb.map((n) => `{{${n}}}`),
  fc.string({ maxLength: 12 }),
);

/** One token referencing one of `count` declared variables, or a brace-free literal. */
function tokenArb(count: number): fc.Arbitrary<Token> {
  const litArb: fc.Arbitrary<Token> = fc
    .string({ maxLength: 8 })
    .map((s) => s.replace(/[{}]/g, ''))
    .map((text) => ({ kind: 'lit', text }));
  const refArb: fc.Arbitrary<Token> = fc
    .record({
      index: fc.integer({ min: 0, max: count - 1 }),
      lead: wsArb,
      trail: wsArb,
    })
    .map(({ index, lead, trail }) => ({ kind: 'ref', index, lead, trail }));
  return fc.oneof(litArb, refArb);
}

/** A template case whose values are drawn from `valueArb`. */
function templateCaseArb(valueArb: fc.Arbitrary<string>): fc.Arbitrary<TemplateCase> {
  return fc.uniqueArray(variableNameArb, { minLength: 1, maxLength: 6 }).chain((names) =>
    fc
      .record({
        values: fc.array(valueArb, { minLength: names.length, maxLength: names.length }),
        tokens: fc.array(tokenArb(names.length), { maxLength: 24 }),
      })
      .map(({ values, tokens }) => ({ names, values, tokens })),
  );
}

/** A plain-valued template case guaranteed to reference at least one variable. */
const templateCaseWithRefArb: fc.Arbitrary<TemplateCase> = templateCaseArb(plainValueArb).map(
  (c) =>
    c.tokens.some((t) => t.kind === 'ref')
      ? c
      : { ...c, tokens: [...c.tokens, { kind: 'ref', index: 0, lead: '', trail: '' }] },
);

// ---------------------------------------------------------------------------
// Oracles: reconstruct expected text independently of the implementation.
// ---------------------------------------------------------------------------

/** Assemble the raw template text (literals verbatim, refs as `{{lead+name+trail}}`). */
function buildText(c: HasTokens): string {
  let text = '';
  for (const t of c.tokens) {
    text += t.kind === 'lit' ? t.text : `{{${t.lead}${c.names[t.index]!}${t.trail}}}`;
  }
  return text;
}

/** The complete value map for a case (name -> value, by index). */
function valueMap(c: TemplateCase): Record<string, string> {
  const m: Record<string, string> = {};
  c.names.forEach((n, i) => {
    m[n] = c.values[i]!;
  });
  return m;
}

/** Expected output when every referenced name resolves via `values`. */
function expectedOutput(c: HasTokens, values: Record<string, string>): string {
  let out = '';
  for (const t of c.tokens) {
    out += t.kind === 'lit' ? t.text : values[c.names[t.index]!]!;
  }
  return out;
}

/** The distinct variable names actually referenced by the token stream, first-seen order. */
function referencedNames(c: HasTokens): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of c.tokens) {
    if (t.kind === 'ref') {
      const n = c.names[t.index]!;
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}

/** Expected output under a missing-value policy for the `missing` set of names. */
function expectedWithMissing(
  c: TemplateCase,
  full: Record<string, string>,
  missing: ReadonlySet<string>,
  policy: 'leave' | 'empty',
): string {
  let out = '';
  for (const t of c.tokens) {
    if (t.kind === 'lit') {
      out += t.text;
      continue;
    }
    const name = c.names[t.index]!;
    if (missing.has(name)) {
      // 'empty' contributes nothing; 'leave' keeps the original placeholder text.
      if (policy === 'leave') out += `{{${t.lead}${name}${t.trail}}}`;
    } else {
      out += full[name]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property 24
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 24: Variable substitution is complete', () => {
  it('a complete value map leaves no unresolved placeholders and replaces every reference (Validates: Requirements 9.5, 10.4)', () => {
    fc.assert(
      fc.property(templateCaseArb(plainValueArb), (c) => {
        const values = valueMap(c);
        const out = substituteVariables(buildText(c), values);

        // Every reference replaced by its provided value, in place, everywhere.
        expect(out).toBe(expectedOutput(c, values));
        // No template placeholder survives, and none is left to extract.
        expect(hasUnresolvedVariables(out)).toBe(false);
        expect(extractVariableNames(out)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('inserts substituted values literally and never re-scans them (Validates: Requirements 9.5, 10.4)', () => {
    fc.assert(
      fc.property(templateCaseArb(trickyValueArb), (c) => {
        const values = valueMap(c);
        const out = substituteVariables(buildText(c), values);

        // A value that looks like `{{x}}` is inserted verbatim, not re-substituted,
        // so the result still matches the single-pass oracle exactly.
        expect(out).toBe(expectedOutput(c, values));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('ignores values for variables the text never references (Validates: Requirements 9.5, 10.4)', () => {
    fc.assert(
      fc.property(
        templateCaseArb(plainValueArb),
        fc.dictionary(fc.string(), plainValueArb),
        (c, extra) => {
          const base = valueMap(c);
          const declared = new Set(c.names);
          const merged: Record<string, string> = { ...base };
          for (const [k, v] of Object.entries(extra)) {
            if (!declared.has(k)) merged[k] = v;
          }
          const out = substituteVariables(buildText(c), merged);

          // Extra unreferenced values neither appear nor disturb the complete result.
          expect(out).toBe(expectedOutput(c, base));
          expect(hasUnresolvedVariables(out)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('handles an omitted referenced variable per the documented missing-value policy (Validates: Requirements 9.5, 10.4)', () => {
    fc.assert(
      fc.property(templateCaseWithRefArb, (c) => {
        const omitted = referencedNames(c)[0]!;
        const full = valueMap(c);
        const partial: Record<string, string> = { ...full };
        delete partial[omitted];
        const text = buildText(c);
        const missing = new Set([omitted]);

        // 'leave' (default): the omitted placeholder is preserved unchanged; every
        // other reference is still fully resolved.
        const left = substituteVariables(text, partial);
        expect(left).toBe(expectedWithMissing(c, full, missing, 'leave'));
        expect(hasUnresolvedVariables(left)).toBe(true);
        expect(extractVariableNames(left)).toEqual([omitted]);

        // 'empty': the omitted placeholder collapses to '', leaving no unresolved text.
        const emptied = substituteVariables(text, partial, { onMissing: 'empty' });
        expect(emptied).toBe(expectedWithMissing(c, full, missing, 'empty'));
        expect(hasUnresolvedVariables(emptied)).toBe(false);

        // 'throw': strict substitution raises a MissingVariableError naming the gap.
        let thrown: unknown;
        try {
          substituteVariables(text, partial, { onMissing: 'throw' });
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(MissingVariableError);
        expect((thrown as MissingVariableError).variableName).toBe(omitted);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('resolves declared variables with defaults into a complete map that leaves nothing unresolved (Validates: Requirements 9.5, 10.4)', () => {
    const declaredCaseArb = fc
      .uniqueArray(variableNameArb, { minLength: 1, maxLength: 6 })
      .chain((names) =>
        fc
          .record({
            defaults: fc.array(plainValueArb, { minLength: names.length, maxLength: names.length }),
            provideFlags: fc.array(fc.boolean(), {
              minLength: names.length,
              maxLength: names.length,
            }),
            overrides: fc.array(plainValueArb, {
              minLength: names.length,
              maxLength: names.length,
            }),
            tokens: fc.array(tokenArb(names.length), { maxLength: 24 }),
          })
          .map((r) => ({ names, ...r })),
      );

    fc.assert(
      fc.property(declaredCaseArb, (c) => {
        // Every declared variable carries a default, so the resolved map is complete.
        const defs: VariableDef[] = c.names.map((name, i) => ({
          name,
          defaultValue: c.defaults[i]!,
        }));
        const provided: Record<string, string> = {};
        const expectedValues: Record<string, string> = {};
        c.names.forEach((name, i) => {
          if (c.provideFlags[i]) {
            provided[name] = c.overrides[i]!;
            expectedValues[name] = c.overrides[i]!;
          } else {
            expectedValues[name] = c.defaults[i]!;
          }
        });

        const resolved = resolveVariableValues(defs, provided);
        // Provided values layer over declared defaults into a complete value map.
        expect(resolved).toEqual(expectedValues);

        const text = buildText(c);
        const out = substituteVariables(text, resolved);
        expect(out).toBe(expectedOutput(c, expectedValues));
        expect(hasUnresolvedVariables(out)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
