/**
 * Unit tests for the self-contained JSON-schema validator (Req 16.2).
 *
 * The Tool_Registry validates tool arguments against this subset of JSON Schema
 * before dispatch. These example-based tests cover each supported keyword and
 * its edge cases: type checks (including `integer` vs `number` and type lists),
 * `const`/`enum`, string/number/array/object constraints, nested
 * `properties`/`items`, `additionalProperties`, exhaustive error collection,
 * and the never-throw contract.
 */

import { describe, expect, it } from 'vitest';

import { validateAgainstSchema } from './schema.js';
import type { JsonSchema } from './types.js';

describe('validateAgainstSchema type checks', () => {
  it('accepts a matching primitive type', () => {
    expect(validateAgainstSchema('hi', { type: 'string' }).valid).toBe(true);
    expect(validateAgainstSchema(3, { type: 'number' }).valid).toBe(true);
    expect(validateAgainstSchema(true, { type: 'boolean' }).valid).toBe(true);
    expect(validateAgainstSchema(null, { type: 'null' }).valid).toBe(true);
  });

  it('rejects a mismatched type with a root-path violation', () => {
    const result = validateAgainstSchema(3, { type: 'string' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path).toBe('');
  });

  it('distinguishes integer from number', () => {
    expect(validateAgainstSchema(3, { type: 'integer' }).valid).toBe(true);
    expect(validateAgainstSchema(3.5, { type: 'integer' }).valid).toBe(false);
  });

  it('rejects NaN and Infinity for number', () => {
    expect(validateAgainstSchema(Number.NaN, { type: 'number' }).valid).toBe(false);
    expect(validateAgainstSchema(Number.POSITIVE_INFINITY, { type: 'number' }).valid).toBe(false);
  });

  it('accepts any of a type list', () => {
    const schema: JsonSchema = { type: ['string', 'null'] };
    expect(validateAgainstSchema('x', schema).valid).toBe(true);
    expect(validateAgainstSchema(null, schema).valid).toBe(true);
    expect(validateAgainstSchema(1, schema).valid).toBe(false);
  });

  it('accepts any type when type is omitted', () => {
    expect(validateAgainstSchema({ anything: 1 }, {}).valid).toBe(true);
  });
});

describe('validateAgainstSchema const and enum', () => {
  it('enforces const by deep equality', () => {
    const schema: JsonSchema = { const: { a: 1 } };
    expect(validateAgainstSchema({ a: 1 }, schema).valid).toBe(true);
    expect(validateAgainstSchema({ a: 2 }, schema).valid).toBe(false);
  });

  it('enforces enum membership', () => {
    const schema: JsonSchema = { enum: ['a', 'b', 'c'] };
    expect(validateAgainstSchema('b', schema).valid).toBe(true);
    expect(validateAgainstSchema('z', schema).valid).toBe(false);
  });
});

describe('validateAgainstSchema string constraints', () => {
  it('enforces minLength/maxLength', () => {
    const schema: JsonSchema = { type: 'string', minLength: 2, maxLength: 4 };
    expect(validateAgainstSchema('ab', schema).valid).toBe(true);
    expect(validateAgainstSchema('a', schema).valid).toBe(false);
    expect(validateAgainstSchema('abcde', schema).valid).toBe(false);
  });

  it('enforces pattern', () => {
    const schema: JsonSchema = { type: 'string', pattern: '^[a-z]+$' };
    expect(validateAgainstSchema('abc', schema).valid).toBe(true);
    expect(validateAgainstSchema('Abc1', schema).valid).toBe(false);
  });

  it('reports an invalid pattern as a violation rather than throwing', () => {
    const schema: JsonSchema = { type: 'string', pattern: '(' };
    const result = validateAgainstSchema('x', schema);
    expect(result.valid).toBe(false);
  });
});

describe('validateAgainstSchema number constraints', () => {
  it('enforces minimum/maximum (inclusive)', () => {
    const schema: JsonSchema = { type: 'number', minimum: 1, maximum: 10 };
    expect(validateAgainstSchema(1, schema).valid).toBe(true);
    expect(validateAgainstSchema(10, schema).valid).toBe(true);
    expect(validateAgainstSchema(0, schema).valid).toBe(false);
    expect(validateAgainstSchema(11, schema).valid).toBe(false);
  });

  it('enforces exclusive bounds', () => {
    const schema: JsonSchema = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 };
    expect(validateAgainstSchema(0.5, schema).valid).toBe(true);
    expect(validateAgainstSchema(0, schema).valid).toBe(false);
    expect(validateAgainstSchema(1, schema).valid).toBe(false);
  });

  it('enforces multipleOf', () => {
    const schema: JsonSchema = { type: 'number', multipleOf: 5 };
    expect(validateAgainstSchema(15, schema).valid).toBe(true);
    expect(validateAgainstSchema(7, schema).valid).toBe(false);
  });
});

describe('validateAgainstSchema array constraints', () => {
  it('enforces minItems/maxItems', () => {
    const schema: JsonSchema = { type: 'array', minItems: 1, maxItems: 2 };
    expect(validateAgainstSchema([1], schema).valid).toBe(true);
    expect(validateAgainstSchema([], schema).valid).toBe(false);
    expect(validateAgainstSchema([1, 2, 3], schema).valid).toBe(false);
  });

  it('enforces uniqueItems by deep equality', () => {
    const schema: JsonSchema = { type: 'array', uniqueItems: true };
    expect(validateAgainstSchema([{ a: 1 }, { a: 2 }], schema).valid).toBe(true);
    expect(validateAgainstSchema([{ a: 1 }, { a: 1 }], schema).valid).toBe(false);
  });

  it('validates each item against items schema with indexed paths', () => {
    const schema: JsonSchema = { type: 'array', items: { type: 'string' } };
    const result = validateAgainstSchema(['ok', 7], schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/1')).toBe(true);
  });
});

describe('validateAgainstSchema object constraints', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } },
    required: ['name'],
    additionalProperties: false,
  };

  it('accepts a well-formed object', () => {
    expect(validateAgainstSchema({ name: 'a', age: 1 }, schema).valid).toBe(true);
  });

  it('reports a missing required property at its path', () => {
    const result = validateAgainstSchema({ age: 1 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/name')).toBe(true);
  });

  it('rejects an additional property when additionalProperties is false', () => {
    const result = validateAgainstSchema({ name: 'a', extra: true }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/extra')).toBe(true);
  });

  it('permits additional properties when omitted', () => {
    const permissive: JsonSchema = { type: 'object', properties: { name: { type: 'string' } } };
    expect(validateAgainstSchema({ name: 'a', extra: true }, permissive).valid).toBe(true);
  });

  it('validates additional properties against a sub-schema', () => {
    const withAdditional: JsonSchema = {
      type: 'object',
      properties: {},
      additionalProperties: { type: 'number' },
    };
    expect(validateAgainstSchema({ a: 1, b: 2 }, withAdditional).valid).toBe(true);
    expect(validateAgainstSchema({ a: 'x' }, withAdditional).valid).toBe(false);
  });

  it('recurses into nested object properties with nested paths', () => {
    const nested: JsonSchema = {
      type: 'object',
      properties: {
        profile: {
          type: 'object',
          properties: { email: { type: 'string' } },
          required: ['email'],
        },
      },
      required: ['profile'],
    };
    const result = validateAgainstSchema({ profile: {} }, nested);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === '/profile/email')).toBe(true);
  });
});

describe('validateAgainstSchema collects all violations and never throws', () => {
  it('returns every violation, not just the first', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    };
    const result = validateAgainstSchema({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
  });

  it('does not throw on undefined/function inputs', () => {
    expect(() => validateAgainstSchema(undefined, { type: 'object' })).not.toThrow();
    expect(() => validateAgainstSchema(() => 1, { type: 'object' })).not.toThrow();
    expect(validateAgainstSchema(undefined, { type: 'object' }).valid).toBe(false);
  });
});
