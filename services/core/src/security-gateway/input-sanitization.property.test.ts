/**
 * Property-based test for **Property 46: Input sanitization is idempotent and
 * removes disallowed constructs** (design "Property 46"; Req 34.4, 34.5).
 *
 * **Validates: Requirements 34.4, 34.5**
 *
 * Property 46 (design): _For any_ user input, the sanitized output contains none
 * of the disallowed constructs (injection / XSS patterns) the Security_Gateway
 * screens for, and sanitizing an already-sanitized input produces the same
 * result (`sanitize(sanitize(x)) === sanitize(x)`). Requirement 34.4 validates
 * and sanitizes user input before processing; Requirement 34.5 encodes rendered
 * output to neutralize cross-site scripting.
 *
 * This file drives the real pure helpers exported from `./validation.js`
 * ({@link sanitizeText}, {@link sanitizeDeep}, {@link containsDisallowedConstructs})
 * — the same functions the gateway's {@link DefaultRequestValidator} composes —
 * with no fakes required (the helpers are total and side-effect free).
 *
 * The generators deliberately mix three sources so the removal path (not just
 * inert text) is exercised: unconstrained `fc.string()`, curated benign
 * fragments, and curated *disallowed* fragments that mirror EXACTLY the
 * construct set `validation.ts` screens for — `<script>`/`<style>` element
 * blocks and their bare open/close tags, inline `on*=` event-handler attributes
 * (double-quoted, single-quoted, unquoted, and spaced forms), and the
 * script-execution URL schemes `javascript:` / `vbscript:` / `data:text/html`.
 * No pattern the module does not handle is invented.
 *
 * Two properties are asserted, each over >= 100 generated iterations:
 *   1. Idempotence — `sanitizeText(sanitizeText(x)) === sanitizeText(x)` for any
 *      string, and `sanitizeDeep(sanitizeDeep(body)) === sanitizeDeep(body)` for
 *      any nested JSON-like object/array structure.
 *   2. Removal — `containsDisallowedConstructs(sanitizeText(x)) === false`: the
 *      sanitized output carries none of the constructs the gateway screens for.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { containsDisallowedConstructs, sanitizeDeep, sanitizeText } from './validation.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 300;

// ---------------------------------------------------------------------------
// Generators — seed inputs with the EXACT disallowed constructs validation.ts
// screens for, so sanitization's removal path is exercised, not just inert text.
// ---------------------------------------------------------------------------

/**
 * Fragments that each match at least one of `validation.ts`'s DISALLOWED_PATTERNS:
 *   - `<script>…</script>` / `<style>…</style>` element blocks;
 *   - bare `<script …>` / `</script>` / `<style>` / `</style>` open/close tags
 *     (including mixed case, since the patterns are case-insensitive);
 *   - inline `on*=` event-handler attributes in their double-quoted,
 *     single-quoted, unquoted, and whitespace-padded forms;
 *   - the script-execution URL schemes `javascript:` / `vbscript:` and the
 *     `data:text/html` scheme.
 */
const disallowedFragmentArb: fc.Arbitrary<string> = fc.constantFrom(
  '<script>alert(1)</script>',
  '<script src="evil.js"></script>',
  '<SCRIPT>steal()</SCRIPT>',
  '<script>',
  '</script>',
  '<style>body{color:red}</style>',
  '<style>',
  '</style>',
  ' onclick="steal()"',
  " onerror='alert(1)'",
  ' onload=run()',
  ' onmouseover = handler',
  ' ONERROR=alert(1)',
  'javascript:alert(1)',
  'JavaScript:void(0)',
  'vbscript:msgbox(1)',
  'data:text/html',
  'data:text/html;base64,PHNjcmlwdD4=',
);

/** Inert fragments — none of these match any disallowed pattern. */
const benignFragmentArb: fc.Arbitrary<string> = fc.constantFrom(
  '',
  'hello world',
  '<b>bold</b>',
  '<div class="x">content</div>',
  'a & b < c > d',
  'plain text 12345',
  'no constructs here',
  'a link to https://example.com',
);

/**
 * A "spiced" string: a random concatenation of disallowed fragments, benign
 * fragments, and unconstrained text, so most generated values carry at least
 * one construct that must be removed (the removal path), while still covering
 * fully inert inputs.
 */
const spicedStringArb: fc.Arbitrary<string> = fc
  .array(fc.oneof(disallowedFragmentArb, benignFragmentArb, fc.string()), {
    minLength: 0,
    maxLength: 6,
  })
  .map((parts) => parts.join(''));

/** The input arbitrary for the string-level properties. */
const inputStringArb: fc.Arbitrary<string> = fc.oneof(fc.string(), spicedStringArb);

/**
 * A nested JSON-like structure (strings drawn from {@link spicedStringArb}, plus
 * non-string scalars, arrays, and plain objects) for the {@link sanitizeDeep}
 * idempotence check. Depth is bounded so generation terminates quickly.
 */
const jsonBodyArb: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, withCrossShrink: true },
    fc.oneof(spicedStringArb, fc.integer(), fc.double(), fc.boolean(), fc.constant(null)),
    fc.array(tie('node'), { maxLength: 4 }),
    fc.dictionary(fc.string(), tie('node'), { maxKeys: 4 }),
  ),
})).node;

// ---------------------------------------------------------------------------
// Property 46
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 46: Input sanitization is idempotent and removes disallowed constructs', () => {
  it('sanitizeText is idempotent — sanitizeText(sanitizeText(x)) === sanitizeText(x) (Validates: Requirements 34.4, 34.5)', () => {
    fc.assert(
      fc.property(inputStringArb, (input) => {
        const once = sanitizeText(input);
        const twice = sanitizeText(once);
        // Re-sanitizing an already-sanitized string changes nothing: the first
        // pass already reached the fixed point.
        expect(twice).toBe(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('sanitizeDeep is idempotent over nested object/array structures (Validates: Requirements 34.4, 34.5)', () => {
    fc.assert(
      fc.property(jsonBodyArb, (body) => {
        const once = sanitizeDeep(body);
        const twice = sanitizeDeep(once);
        // Deep sanitization of an already-sanitized body preserves both the
        // structure and the (already-fixed-point) string content.
        expect(twice).toEqual(once);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('removes every disallowed construct — containsDisallowedConstructs(sanitizeText(x)) === false (Validates: Requirements 34.4, 34.5)', () => {
    fc.assert(
      fc.property(inputStringArb, (input) => {
        const sanitized = sanitizeText(input);
        // The sanitized output contains none of the injection / XSS constructs
        // the gateway screens for.
        expect(containsDisallowedConstructs(sanitized)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
