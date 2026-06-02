/**
 * Unit tests for the shared variable-substitution core (Req 9.5, 10.4).
 *
 * These cover the documented `{{name}}` syntax, totality (every occurrence
 * replaced), literal insertion (no re-scan), the three missing-value policies,
 * and {@link resolveVariableValues} default layering. The exhaustive
 * completeness property (Property 24) is task 9.2; this is the example/edge-case
 * companion for the shared module both the Persona_Manager and Prompt_Library
 * reuse.
 */

import { describe, expect, it } from 'vitest';

import { MissingVariableError } from './errors.js';
import {
  extractVariableNames,
  hasUnresolvedVariables,
  resolveVariableValues,
  substituteVariables,
} from './variables.js';

describe('substituteVariables (Req 9.5)', () => {
  it('replaces a single variable', () => {
    expect(substituteVariables('Hello {{name}}', { name: 'Sam' })).toBe('Hello Sam');
  });

  it('replaces all occurrences of a repeated variable', () => {
    expect(substituteVariables('{{a}}{{a}}{{a}}', { a: 'x' })).toBe('xxx');
  });

  it('handles multiple distinct variables', () => {
    expect(substituteVariables('{{a}}-{{b}}', { a: '1', b: '2' })).toBe('1-2');
  });

  it('ignores inner whitespace in the placeholder', () => {
    expect(substituteVariables('{{  a }}', { a: 'x' })).toBe('x');
  });

  it('leaves literal non-placeholder braces untouched', () => {
    expect(substituteVariables('{ not a var } {{a}}', { a: 'x' })).toBe('{ not a var } x');
  });

  it('inserts values literally without re-scanning', () => {
    expect(substituteVariables('{{a}}', { a: '{{b}}', b: 'y' })).toBe('{{b}}');
  });

  describe('missing-value policy', () => {
    it('leaves unknown placeholders by default', () => {
      expect(substituteVariables('{{a}} {{b}}', { a: '1' })).toBe('1 {{b}}');
    });

    it('replaces with empty string when onMissing=empty', () => {
      expect(substituteVariables('[{{x}}]', {}, { onMissing: 'empty' })).toBe('[]');
    });

    it('throws MissingVariableError when onMissing=throw', () => {
      expect(() => substituteVariables('{{x}}', {}, { onMissing: 'throw' })).toThrow(
        MissingVariableError,
      );
    });
  });

  it('produces no unresolved placeholders when all referenced vars are provided', () => {
    const out = substituteVariables('{{a}} {{b}} {{a}}', { a: '1', b: '2' });
    expect(hasUnresolvedVariables(out)).toBe(false);
  });
});

describe('extractVariableNames', () => {
  it('returns distinct names in first-seen order', () => {
    expect(extractVariableNames('{{b}} {{a}} {{b}} {{c}}')).toEqual(['b', 'a', 'c']);
  });

  it('returns an empty list when there are no placeholders', () => {
    expect(extractVariableNames('plain text')).toEqual([]);
  });
});

describe('resolveVariableValues', () => {
  it('layers provided values over declared defaults', () => {
    const values = resolveVariableValues(
      [
        { name: 'a', defaultValue: 'da' },
        { name: 'b', defaultValue: 'db' },
      ],
      { a: 'pa' },
    );
    expect(values).toEqual({ a: 'pa', b: 'db' });
  });

  it('throws for a required variable with no value or default', () => {
    expect(() => resolveVariableValues([{ name: 'x', required: true }])).toThrow(
      MissingVariableError,
    );
  });

  it('omits an optional variable with neither value nor default', () => {
    expect(resolveVariableValues([{ name: 'x' }])).toEqual({});
  });
});
