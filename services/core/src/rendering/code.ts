/**
 * Fenced-code rendering support for the Output_Renderer (Req 8.2).
 *
 * The acceptance criterion requires syntax highlighting for the *detected*
 * language and a *copy control*. Rather than embedding a heavy
 * syntax-highlighter (which would also drag a tokenizer/grammar set into a
 * backend package), the renderer produces a **structured representation** the
 * web layer can highlight: the detected/declared `language`, the HTML-escaped
 * code (`escapedCode`, ready for `<pre><code class="language-…">`), and a
 * `copyText` carrying the exact raw code for the copy affordance.
 *
 * Language detection is deliberately small: an explicit fence language always
 * wins (normalized through a few common aliases); otherwise a cheap heuristic
 * guesses from the code, falling back to `plaintext`. This keeps the function
 * pure, fast, and good enough to drive a client-side highlighter.
 */

import { escapeHtml } from './html.js';
import type { CodeRenderedBlock } from './types.js';

/** The language used when none is declared and none can be guessed. */
export const DEFAULT_CODE_LANGUAGE = 'plaintext';

/** Common fence-language aliases normalized to a canonical name. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  cs: 'csharp',
  golang: 'go',
};

/** Normalize a declared fence language to its canonical name. */
function normalizeLanguage(language: string): string {
  const lower = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

/**
 * Best-effort language guess from code when no fence language is declared.
 *
 * Intentionally conservative: it only claims a language on a strong signal and
 * otherwise returns {@link DEFAULT_CODE_LANGUAGE}. The client highlighter can
 * refine this; the renderer just needs a reasonable default.
 */
function guessLanguage(code: string): string {
  const sample = code.trim();
  if (sample === '') return DEFAULT_CODE_LANGUAGE;
  if (/^\s*<\?php/.test(sample)) return 'php';
  if (/^\s*</.test(sample) && /<\/?[a-zA-Z]/.test(sample)) return 'html';
  if (/\b(def|import|print)\b/.test(sample) && /:\s*$/m.test(sample)) return 'python';
  if (/\b(function|const|let|var)\b/.test(sample) || /=>/.test(sample)) {
    return /\b(interface|type|enum)\b|:\s*\w+/.test(sample) ? 'typescript' : 'javascript';
  }
  if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE)\b/i.test(sample)) return 'sql';
  if (/^\s*[{[]/.test(sample) && /[}\]]\s*$/.test(sample)) return 'json';
  return DEFAULT_CODE_LANGUAGE;
}

/**
 * The payload shape the renderer narrows a `code` {@link ContentBlock} to.
 * Either a structured object (`{ code, language? }`) or a bare code string.
 */
export interface CodeBlockData {
  /** The raw source code. */
  code: string;
  /** The declared language, if any. */
  language?: string;
}

/**
 * Build the structured {@link CodeRenderedBlock} for a fenced code block
 * (Req 8.2): detected language, escaped code for display, and the copyable raw
 * code.
 *
 * @param data The code payload: the raw code and an optional declared language.
 * @returns The rendered code block with a copy affordance.
 */
export function renderCode(data: CodeBlockData): Omit<CodeRenderedBlock, 'attribution'> {
  const code = data.code;
  const declared = data.language?.trim();
  const language = declared ? normalizeLanguage(declared) : guessLanguage(code);

  return {
    kind: 'code',
    language: language === '' ? DEFAULT_CODE_LANGUAGE : language,
    code,
    escapedCode: escapeHtml(code),
    copyText: code,
    copyable: true,
  };
}
