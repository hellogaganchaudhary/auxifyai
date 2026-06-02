/**
 * A self-contained JSON-schema validator for tool parameter schemas (Req 16.2).
 *
 * The Tool_Registry validates an invocation's arguments against the tool's
 * parameter schema before dispatch (Req 16.2). Rather than take a runtime
 * dependency on an external JSON-schema library, this module implements a
 * pragmatic, well-scoped subset of JSON Schema (documented on {@link JsonSchema})
 * that is sufficient to describe tool inputs: type checks, enums/consts,
 * string/number/array/object constraints, and nested `properties`/`items`.
 *
 * {@link validateAgainstSchema} collects *every* violation (it does not stop at
 * the first) so a caller can report all argument problems at once, and never
 * throws on malformed input — it returns a {@link ToolValidationResult}. The
 * helpers are pure, so they are trivially unit- and property-testable.
 */

import type { JsonSchema, JsonSchemaType, SchemaViolation, ToolValidationResult } from './types.js';

/** Append a property/index segment to a JSON-Pointer-style path. */
function childPath(path: string, segment: string | number): string {
  return `${path}/${segment}`;
}

/** Classify a runtime value into the JSON type system used by {@link JsonSchema}. */
function jsonTypeOf(value: unknown): Exclude<JsonSchemaType, 'integer'> | 'undefined' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'boolean';
  if (t === 'number') return 'number';
  if (t === 'object') return 'object';
  // functions, symbols, bigint, undefined — none are valid JSON values.
  if (t === 'undefined') return 'undefined';
  return 'object';
}

/** Whether `value` matches a single declared JSON-schema `type`. */
function matchesType(value: unknown, type: JsonSchemaType): boolean {
  if (type === 'integer') {
    return typeof value === 'number' && Number.isInteger(value);
  }
  if (type === 'number') {
    // JSON numbers exclude NaN/Infinity.
    return typeof value === 'number' && Number.isFinite(value);
  }
  return jsonTypeOf(value) === type;
}

/** Structural deep-equality for `enum`/`const`/`uniqueItems` comparisons. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

/** Validate string-specific keywords, pushing any violations. */
function validateString(value: string, schema: JsonSchema, path: string, out: SchemaViolation[]): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    out.push({ path, message: `string length ${value.length} is below minLength ${schema.minLength}` });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    out.push({ path, message: `string length ${value.length} exceeds maxLength ${schema.maxLength}` });
  }
  if (schema.pattern !== undefined) {
    let re: RegExp | undefined;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      out.push({ path, message: `schema pattern is not a valid regular expression` });
    }
    if (re !== undefined && !re.test(value)) {
      out.push({ path, message: `string does not match pattern ${schema.pattern}` });
    }
  }
}

/** Validate number/integer-specific keywords, pushing any violations. */
function validateNumber(value: number, schema: JsonSchema, path: string, out: SchemaViolation[]): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    out.push({ path, message: `value ${value} is below minimum ${schema.minimum}` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    out.push({ path, message: `value ${value} exceeds maximum ${schema.maximum}` });
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    out.push({ path, message: `value ${value} is not greater than exclusiveMinimum ${schema.exclusiveMinimum}` });
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    out.push({ path, message: `value ${value} is not less than exclusiveMaximum ${schema.exclusiveMaximum}` });
  }
  if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (!Number.isInteger(quotient)) {
      out.push({ path, message: `value ${value} is not a multiple of ${schema.multipleOf}` });
    }
  }
}

/** Validate array-specific keywords (length, uniqueness, items), recursing into elements. */
function validateArray(value: unknown[], schema: JsonSchema, path: string, out: SchemaViolation[]): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    out.push({ path, message: `array length ${value.length} is below minItems ${schema.minItems}` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    out.push({ path, message: `array length ${value.length} exceeds maxItems ${schema.maxItems}` });
  }
  if (schema.uniqueItems === true) {
    for (let i = 0; i < value.length; i += 1) {
      for (let j = i + 1; j < value.length; j += 1) {
        if (deepEqual(value[i], value[j])) {
          out.push({ path, message: `array items must be unique; indices ${i} and ${j} are equal` });
        }
      }
    }
  }
  if (schema.items !== undefined) {
    value.forEach((item, index) => {
      collect(item, schema.items as JsonSchema, childPath(path, index), out);
    });
  }
}

/** Validate object-specific keywords (required, properties, additionalProperties). */
function validateObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
  out: SchemaViolation[],
): void {
  const properties = schema.properties ?? {};
  const declared = new Set(Object.keys(properties));

  for (const requiredKey of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) {
      out.push({ path: childPath(path, requiredKey), message: `missing required property "${requiredKey}"` });
    }
  }

  for (const [key, subSchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collect(value[key], subSchema, childPath(path, key), out);
    }
  }

  const additional = schema.additionalProperties;
  if (additional !== undefined && additional !== true) {
    for (const key of Object.keys(value)) {
      if (declared.has(key)) continue;
      if (additional === false) {
        out.push({ path: childPath(path, key), message: `additional property "${key}" is not allowed` });
      } else {
        collect(value[key], additional, childPath(path, key), out);
      }
    }
  }
}

/** Core recursive validation: append every violation for `value` against `schema`. */
function collect(value: unknown, schema: JsonSchema, path: string, out: SchemaViolation[]): void {
  // `const` and `enum` are checked first; they fully constrain the value.
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    out.push({ path, message: `value does not equal the required const` });
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    out.push({ path, message: `value is not one of the allowed enum values` });
  }

  // Type gate. A failing type makes the type-specific keyword checks moot.
  if (schema.type !== undefined) {
    const accepted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!accepted.some((type) => matchesType(value, type))) {
      out.push({
        path,
        message: `expected type ${accepted.join(' | ')} but got ${jsonTypeOf(value)}`,
      });
      return;
    }
  }

  if (typeof value === 'string') {
    validateString(value, schema, path, out);
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    validateNumber(value, schema, path, out);
  } else if (Array.isArray(value)) {
    validateArray(value, schema, path, out);
  } else if (value !== null && typeof value === 'object') {
    validateObject(value as Record<string, unknown>, schema, path, out);
  }
}

/**
 * Validate `value` against `schema`, returning every violation found (Req 16.2).
 *
 * Never throws: a malformed value yields `{ valid: false, errors: [...] }`
 * rather than an exception. Validation is exhaustive — all violations are
 * collected, not just the first — so a caller can surface every argument
 * problem at once.
 *
 * @param value The value to validate (typically a tool invocation's arguments).
 * @param schema The {@link JsonSchema} to validate against.
 * @returns A {@link ToolValidationResult} with `valid` and the collected `errors`.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): ToolValidationResult {
  const errors: SchemaViolation[] = [];
  collect(value, schema, '', errors);
  return { valid: errors.length === 0, errors };
}
