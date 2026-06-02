/**
 * LaTeX math rendering support for the Output_Renderer (Req 8.4).
 *
 * As with Mermaid, final typesetting of LaTeX happens **client-side** (KaTeX or
 * MathJax). The backend/SSR renderer carries the LaTeX source plus a
 * lightweight **parse/validity check** so plainly-malformed notation (e.g.
 * unbalanced braces or `\begin`/`\end` environments) is caught here and falls
 * back to raw content (Req 8.7) instead of breaking the client typesetter. It
 * also records whether the math should be laid out as display (block) or inline.
 */

import type { LatexRenderedBlock } from './types.js';

/** The payload shape a `latex` {@link ContentBlock} is narrowed to. */
export interface LatexBlockData {
  /** The LaTeX math source. */
  latex: string;
  /** Whether to render as display (block) math; defaults to `true`. */
  display?: boolean;
}

/** The result of validating a LaTeX expression. */
export interface LatexValidation {
  /** Whether the expression passes the lightweight balance/validity checks. */
  valid: boolean;
}

/** Whether every `{ … }`, `[ … ]`, and `( … )` pair is balanced (ignoring `\{` escapes). */
function bracesBalanced(latex: string): boolean {
  const pairs: Readonly<Record<string, string>> = { '}': '{', ']': '[', ')': '(' };
  const openers = new Set(['{', '[', '(']);
  const stack: string[] = [];
  for (let i = 0; i < latex.length; i += 1) {
    const ch = latex[i] ?? '';
    // Skip escaped delimiters like \{ \} \[ \] \( \).
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (openers.has(ch)) {
      stack.push(ch);
    } else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return stack.length === 0;
}

/** Whether `\begin{env}` / `\end{env}` occurrences are balanced and properly nested. */
function environmentsBalanced(latex: string): boolean {
  const tokens = [...latex.matchAll(/\\(begin|end)\s*\{([^}]*)\}/g)];
  const stack: string[] = [];
  for (const token of tokens) {
    const kind = token[1];
    const env = token[2] ?? '';
    if (kind === 'begin') {
      stack.push(env);
    } else if (stack.pop() !== env) {
      return false;
    }
  }
  return stack.length === 0;
}

/**
 * Lightweight parse/validity check for a LaTeX math expression (Req 8.4).
 *
 * Rejects empty input, unbalanced braces/brackets/parens, and mismatched
 * `\begin`/`\end` environments. This is a *structural* gate, not a full LaTeX
 * parse, but it reliably catches the malformed notation that would otherwise
 * make a client typesetter throw.
 *
 * @param latex The raw LaTeX math source.
 * @returns The validation outcome.
 */
export function validateLatex(latex: string): LatexValidation {
  const trimmed = latex.trim();
  if (trimmed === '') return { valid: false };
  return { valid: bracesBalanced(trimmed) && environmentsBalanced(trimmed) };
}

/**
 * Build the {@link LatexRenderedBlock} for a valid LaTeX expression (Req 8.4),
 * carrying the source for client-side KaTeX/MathJax typesetting.
 *
 * @param data The LaTeX payload and display flag.
 * @returns The rendered LaTeX block descriptor.
 */
export function renderLatex(data: LatexBlockData): Omit<LatexRenderedBlock, 'attribution'> {
  return { kind: 'latex', latex: data.latex, display: data.display ?? true };
}
