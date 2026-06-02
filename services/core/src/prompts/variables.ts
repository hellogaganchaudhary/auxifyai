/**
 * Shared `{{variable}}` substitution for the Prompt_Library (Req 10.4) and,
 * by the same syntax, the Persona_Manager (Req 9.5).
 *
 * Both the Prompt_Library and the Persona_Manager fill declared variables in a
 * template/system prompt before the text is sent to a model. To keep the two
 * surfaces consistent — so the single Property 24 ("variable substitution is
 * complete") covers both — the syntax is defined here once:
 *
 *   - A variable placeholder is `{{ name }}` where `name` matches
 *     {@link VARIABLE_NAME_PATTERN} (letters, digits, `_`, `.`, `-`) and any
 *     surrounding ASCII whitespace inside the braces is ignored.
 *   - Substitution is a single left-to-right pass: a value that itself contains
 *     `{{ … }}` is **not** re-scanned, so values can never inject new
 *     placeholders.
 *
 * The Persona_Manager (concurrent task 9.1) implements the same `{{var}}`
 * syntax for its system prompts; this module is intentionally self-contained so
 * the two tasks do not race on a shared import. If a single shared helper is
 * later desired, both can re-export from here.
 */

/** The character class a variable name is composed of (without the braces). */
export const VARIABLE_NAME_PATTERN = '[A-Za-z0-9_.-]+' as const;

/**
 * Matches a single `{{ name }}` placeholder, capturing the (untrimmed) name.
 * Recreated per use so callers never share the stateful `lastIndex` of a global
 * regex.
 */
function placeholderPattern(): RegExp {
  return new RegExp(`\\{\\{\\s*(${VARIABLE_NAME_PATTERN})\\s*\\}\\}`, 'g');
}

/**
 * The distinct variable names declared by `{{ … }}` placeholders in `template`,
 * in first-appearance order.
 *
 * @param template The text to scan.
 * @returns The unique declared variable names (may be empty).
 */
export function extractVariableNames(template: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const pattern = placeholderPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    const name = (match[1] ?? '').trim();
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * The declared variable names that have no value in `vars`, in first-appearance
 * order. An empty result means `vars` is a complete map for `template`.
 *
 * @param template The text whose placeholders are checked.
 * @param vars The supplied variable values.
 * @returns The names of declared variables missing from `vars`.
 */
export function findMissingVariables(template: string, vars: Record<string, string>): string[] {
  return extractVariableNames(template).filter(
    (name) => !Object.prototype.hasOwnProperty.call(vars, name),
  );
}

/**
 * Substitute every `{{ name }}` placeholder in `template` with `vars[name]`.
 *
 * Substitution is a single pass: each placeholder present in `vars` is replaced
 * with its value, and any placeholder whose name is **not** in `vars` is left
 * verbatim (so callers can detect an incomplete map via
 * {@link findMissingVariables}). Because replacement does not re-scan inserted
 * values, a value containing `{{ … }}` is emitted literally and never treated
 * as a further placeholder.
 *
 * When `vars` is a complete map (every declared name present), the result
 * contains no unresolved declared placeholders and every declared variable is
 * replaced by its value (Property 24 / Req 9.5, 10.4).
 *
 * @param template The text containing `{{ … }}` placeholders.
 * @param vars The variable values to substitute.
 * @returns The substituted text.
 */
export function substituteVariables(template: string, vars: Record<string, string>): string {
  return template.replace(placeholderPattern(), (match, rawName: string) => {
    const name = rawName.trim();
    // `?? match` also satisfies the `noUncheckedIndexedAccess` typing of `vars[name]`.
    return Object.prototype.hasOwnProperty.call(vars, name) ? (vars[name] ?? match) : match;
  });
}
