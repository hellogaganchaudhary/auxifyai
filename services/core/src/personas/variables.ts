/**
 * Variable substitution — the shared `{{name}}` template core (Req 9.5, 10.4).
 *
 * Both the Persona_Manager (a persona's system prompt, Req 9.5) and the
 * Prompt_Library (a template's content, Req 10.4) substitute declared variable
 * values into text before it is sent to the model. To keep that behavior
 * identical — and to let task 9.2's property test (Property 24, "variable
 * substitution is complete") validate a single implementation — the substitution
 * lives here as a small, pure, dependency-free module.
 *
 * ## Variable syntax
 *
 * A variable reference is written `{{name}}` where `name` matches
 * {@link VARIABLE_NAME_PATTERN} (letters, digits, `_`, `.`, `-`). Optional inner
 * whitespace is allowed and ignored, so `{{ name }}` and `{{name}}` are the same
 * reference. Anything not matching this exact shape is treated as literal text
 * and is never altered.
 *
 * ## Guarantees (Property 24)
 *
 * {@link substituteVariables} is **total**: it scans the text once and replaces
 * *every* occurrence of a referenced variable, and substituted values are
 * inserted literally (a value that itself looks like `{{x}}` is never
 * re-scanned), so substitution always terminates and is deterministic. When the
 * provided value map covers every variable referenced in the text, the result
 * therefore contains no unresolved `{{...}}` placeholders and each occurrence is
 * its provided value.
 *
 * ## Missing-value behavior (documented and configurable)
 *
 * A placeholder whose name has no provided value is handled per
 * {@link MissingVariablePolicy}:
 *   - `leave` (default) — keep the original `{{name}}` text unchanged. This is
 *     non-destructive and lets a caller substitute in passes.
 *   - `empty` — replace with the empty string.
 *   - `throw` — raise {@link MissingVariableError}, naming the variable, for the
 *     strict "every declared variable must be supplied" path used by
 *     {@link resolveVariableValues}.
 */

import { MissingVariableError } from './errors.js';
import type { VariableDef } from './types.js';

/** The character class a `{{name}}` variable name must match. */
export const VARIABLE_NAME_PATTERN = '[A-Za-z0-9_.-]+';

/**
 * Matches a `{{name}}` placeholder with optional inner whitespace, capturing the
 * trimmed name in group 1. Constructed per use so the `lastIndex` of this global
 * regex is never shared across calls.
 */
function placeholderRegex(): RegExp {
  return new RegExp(`\\{\\{\\s*(${VARIABLE_NAME_PATTERN})\\s*\\}\\}`, 'g');
}

/** How {@link substituteVariables} treats a referenced variable with no value. */
export type MissingVariablePolicy = 'leave' | 'empty' | 'throw';

/** Options for {@link substituteVariables}. */
export interface SubstituteOptions {
  /** Behavior when a referenced variable has no provided value. Defaults to `leave`. */
  onMissing?: MissingVariablePolicy;
}

/**
 * Return the distinct variable names referenced by `{{name}}` placeholders in
 * `text`, in first-seen order.
 *
 * @param text The template text to scan.
 * @returns The unique referenced variable names.
 */
export function extractVariableNames(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  const regex = placeholderRegex();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1] as string;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Whether `text` still contains any `{{name}}` placeholder.
 *
 * @param text The text to test.
 * @returns `true` if at least one variable placeholder remains.
 */
export function hasUnresolvedVariables(text: string): boolean {
  return placeholderRegex().test(text);
}

/**
 * Substitute `{{name}}` placeholders in `text` using `values` (Req 9.5, 10.4).
 *
 * Every occurrence of a referenced variable present in `values` is replaced by
 * its value (inserted literally, never re-scanned). A referenced variable with
 * no value is handled per {@link SubstituteOptions.onMissing} (default `leave`).
 *
 * @param text The template text containing `{{name}}` placeholders.
 * @param values The variable values, keyed by name.
 * @param options Missing-value behavior; defaults to leaving unknown placeholders.
 * @returns The text with all resolvable placeholders substituted.
 * @throws MissingVariableError when `onMissing` is `throw` and a referenced
 *   variable has no value.
 */
export function substituteVariables(
  text: string,
  values: Record<string, string>,
  options: SubstituteOptions = {},
): string {
  const onMissing = options.onMissing ?? 'leave';
  return text.replace(placeholderRegex(), (whole, rawName: string) => {
    const name = rawName;
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return values[name] as string;
    }
    switch (onMissing) {
      case 'empty':
        return '';
      case 'throw':
        throw new MissingVariableError(name);
      case 'leave':
      default:
        return whole as string;
    }
  });
}

/**
 * Resolve a complete value map for declared `variables`, layering provided
 * values over each variable's {@link VariableDef.defaultValue} (Req 9.5).
 *
 * Used by the strict substitution path: every declared variable ends up with a
 * value (provided or default). A variable that is `required` with neither a
 * provided value nor a default raises {@link MissingVariableError}.
 *
 * @param variables The declared variables of a persona or prompt template.
 * @param provided The caller-supplied values, keyed by name.
 * @returns A complete value map covering every declared variable that has a
 *   provided value or a default.
 * @throws MissingVariableError for a required variable with no value or default.
 */
export function resolveVariableValues(
  variables: VariableDef[],
  provided: Record<string, string> = {},
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const variable of variables) {
    if (Object.prototype.hasOwnProperty.call(provided, variable.name)) {
      resolved[variable.name] = provided[variable.name] as string;
    } else if (variable.defaultValue !== undefined) {
      resolved[variable.name] = variable.defaultValue;
    } else if (variable.required === true) {
      throw new MissingVariableError(variable.name);
    }
  }
  return resolved;
}
