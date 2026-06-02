/**
 * Unit tests for the shared `{{ variable }}` substitution core (Req 10.4, 9.5).
 *
 * These pin the exact substitution behaviour the Prompt_Library and (by the
 * same syntax) the Persona_Manager rely on: declared-name extraction, missing
 * detection, complete substitution, whitespace tolerance, and the single-pass
 * guarantee that inserted values are never re-scanned for further placeholders.
 */

import { describe, expect, it } from 'vitest';

import { extractVariableNames, findMissingVariables, substituteVariables } from './variables.js';

describe('extractVariableNames', () => {
  it('returns distinct names in first-appearance order', () => {
    expect(extractVariableNames('Hi {{name}}, {{name}} from {{ team }}!')).toEqual([
      'name',
      'team',
    ]);
  });

  it('returns an empty array when there are no placeholders', () => {
    expect(extractVariableNames('no variables here')).toEqual([]);
  });

  it('tolerates surrounding whitespace inside the braces', () => {
    expect(extractVariableNames('{{  spaced_name  }}')).toEqual(['spaced_name']);
  });
});

describe('findMissingVariables', () => {
  it('reports declared names with no supplied value', () => {
    expect(findMissingVariables('{{a}} {{b}} {{c}}', { a: '1', c: '3' })).toEqual(['b']);
  });

  it('treats an empty-string value as supplied (present, not missing)', () => {
    expect(findMissingVariables('{{a}}', { a: '' })).toEqual([]);
  });

  it('returns empty when every declared variable has a value', () => {
    expect(findMissingVariables('{{a}}-{{b}}', { a: '1', b: '2' })).toEqual([]);
  });
});

describe('substituteVariables', () => {
  it('replaces every declared placeholder with its value', () => {
    expect(substituteVariables('Hello {{name}}!', { name: 'Ada' })).toBe('Hello Ada!');
  });

  it('replaces repeated placeholders consistently', () => {
    expect(substituteVariables('{{x}}+{{x}}', { x: '1' })).toBe('1+1');
  });

  it('leaves placeholders with no value verbatim', () => {
    expect(substituteVariables('{{a}} {{b}}', { a: 'A' })).toBe('A {{b}}');
  });

  it('does not re-scan inserted values for new placeholders (single pass)', () => {
    // The value for `a` itself looks like a placeholder; it must be emitted
    // literally and never substituted with `b`'s value.
    expect(substituteVariables('{{a}}', { a: '{{b}}', b: 'INJECTED' })).toBe('{{b}}');
  });

  it('produces no unresolved declared placeholders when the map is complete', () => {
    const out = substituteVariables('{{greeting}}, {{name}} of {{team}}', {
      greeting: 'Hello',
      name: 'Grace',
      team: 'Eng',
    });
    expect(out).toBe('Hello, Grace of Eng');
    expect(out).not.toMatch(/\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/);
  });
});
