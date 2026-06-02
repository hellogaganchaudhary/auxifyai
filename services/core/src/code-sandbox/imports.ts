/**
 * Static import extraction for the Code_Sandbox Allow_List preflight
 * (Req 18.6, Property 39).
 *
 * Before any untrusted code reaches the isolation backend, the Code_Sandbox
 * must reject it if it imports a package that is not on the Allow_List
 * (Req 18.6). That requires knowing *which* packages a program declares. This
 * module performs a deliberately conservative, purely lexical scan of the
 * source — it never executes or fully parses the code (executing untrusted code
 * to discover its imports would defeat the sandbox) — extracting the set of
 * top-level package/module names each runtime would load:
 *
 *  - `python` — `import a, b.c` and `from a.b import c` (top-level package `a`);
 *  - `node` — `require('x')`, `import … from 'x'`, and dynamic `import('x')`,
 *    reduced to the bare package name (scoped packages keep their `@scope/name`);
 *  - `shell` — external commands invoked on a line (the first bare word), so a
 *    shell Allow_List can gate which binaries a script may call;
 *  - `sql` — no import concept, so the extracted set is always empty.
 *
 * Being conservative and lexical means the scan errs toward *over*-reporting an
 * import (e.g. one mentioned in a comment), which fails safe: at worst a benign
 * program is rejected and the caller widens the Allow_List, never the reverse.
 * Relative imports (`./x`, `../x`, `/x`) are not packages and are ignored.
 */

import type { SandboxLanguage } from './types.js';

/**
 * Extract the set of package/module names a program declares, for the
 * Allow_List preflight (Req 18.6).
 *
 * @param language The runtime the source will execute under.
 * @param source The untrusted source code.
 * @returns The distinct imported package names, sorted for determinism. Empty
 *   for SQL (no import concept) and for code that imports nothing.
 */
export function extractImports(language: SandboxLanguage, source: string): string[] {
  switch (language) {
    case 'python':
      return unique(extractPythonImports(source));
    case 'node':
      return unique(extractNodeImports(source));
    case 'shell':
      return unique(extractShellCommands(source));
    case 'sql':
      return [];
    default: {
      // Exhaustiveness guard: a new language must opt into an extractor.
      const never: never = language;
      return never;
    }
  }
}

/** Strip `#`-introduced line comments so an import in a comment is not mistaken for real code. */
function stripPythonComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const hash = indexOfUnquoted(line, '#');
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join('\n');
}

/** Extract top-level package names from Python `import` / `from … import` statements. */
function extractPythonImports(source: string): string[] {
  const code = stripPythonComments(source);
  const names: string[] = [];

  // `from a.b.c import d` → top-level package `a`.
  const fromRe = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm;
  for (const match of code.matchAll(fromRe)) {
    const top = topLevelPythonPackage(match[1]!);
    if (top !== null) {
      names.push(top);
    }
  }

  // `import a, b.c as d, e` → packages `a`, `b`, `e`. A trailing `;`-separated
  // statement on the same line (e.g. `import os; os.system(...)`) is dropped so
  // only the import clause is scanned.
  const importRe = /^[ \t]*import[ \t]+(.+)$/gm;
  for (const match of code.matchAll(importRe)) {
    const importClause = match[1]!.split(';')[0]!;
    for (const part of importClause.split(',')) {
      // Drop an `as alias` suffix, then take the dotted module's top segment.
      const moduleRef = part.trim().split(/[ \t]+as[ \t]+/)[0]!.trim();
      const top = topLevelPythonPackage(moduleRef);
      if (top !== null) {
        names.push(top);
      }
    }
  }

  return names;
}

/** Reduce a dotted Python module reference to its top-level package, or `null` if relative/empty. */
function topLevelPythonPackage(moduleRef: string): string | null {
  // A leading dot is a relative import (e.g. `from . import x`) — not a package.
  if (moduleRef.length === 0 || moduleRef.startsWith('.')) {
    return null;
  }
  const top = moduleRef.split('.')[0]!.trim();
  return top.length > 0 ? top : null;
}

/** Extract package names from Node `import`, `require`, and dynamic `import()`. */
function extractNodeImports(source: string): string[] {
  const code = stripJsComments(source);
  const names: string[] = [];

  // static: `import … from 'x'`, `import 'x'`, `export … from 'x'`.
  const fromRe = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(fromRe)) {
    pushNodeSpecifier(names, match[1]!);
  }
  const bareImportRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(bareImportRe)) {
    pushNodeSpecifier(names, match[1]!);
  }

  // dynamic: `import('x')` and CommonJS `require('x')`.
  const dynamicRe = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of code.matchAll(dynamicRe)) {
    pushNodeSpecifier(names, match[1]!);
  }

  return names;
}

/** Reduce a Node module specifier to its bare package name and collect it (ignoring relatives). */
function pushNodeSpecifier(into: string[], specifier: string): void {
  const name = bareNodePackage(specifier);
  if (name !== null) {
    into.push(name);
  }
}

/**
 * Reduce a Node module specifier to the package name an Allow_List gates on, or
 * `null` for a relative/absolute path import (not a package).
 *
 *  - `lodash/fp` → `lodash`;
 *  - `@scope/pkg/sub` → `@scope/pkg`;
 *  - `node:fs` → `node:fs` (the built-in is named in full);
 *  - `./util`, `../util`, `/abs` → `null`.
 */
function bareNodePackage(specifier: string): string | null {
  if (specifier.length === 0 || specifier.startsWith('.') || specifier.startsWith('/')) {
    return null;
  }
  if (specifier.startsWith('node:')) {
    return specifier;
  }
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    // Scoped package: keep `@scope/name`.
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : segments[0]!;
  }
  return segments[0]!;
}

/** Extract the external command (first bare word) invoked on each shell line. */
function extractShellCommands(source: string): string[] {
  const names: string[] = [];
  for (const rawLine of stripShellComments(source).split('\n')) {
    // Split a line on pipes and statement separators so each sub-command's
    // leading word is considered (e.g. `curl x | grep y` → `curl`, `grep`).
    for (const segment of rawLine.split(/[|;&]+/)) {
      const word = firstShellWord(segment);
      if (word !== null) {
        names.push(word);
      }
    }
  }
  return names;
}

/** The first command word of a shell segment, skipping `VAR=val` prefixes; `null` if none. */
function firstShellWord(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    // Skip leading environment assignments like `FOO=bar cmd`.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    // Skip shell keywords that introduce a command rather than being one.
    if (token === 'sudo' || token === 'then' || token === 'do' || token === 'else') {
      continue;
    }
    return token;
  }
  return null;
}

/** Strip `#` comments from shell source (a `#` not inside quotes starts a comment). */
function stripShellComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const hash = indexOfUnquoted(line, '#');
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join('\n');
}

/** Strip `//` line comments and `/* … *\/` block comments from JS/TS source. */
function stripJsComments(source: string): string {
  // Remove block comments first, then line comments. Good enough for a
  // conservative lexical scan; quoted occurrences are rare in import lines and
  // over-stripping only widens, never narrows, what we treat as code.
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const slash = line.indexOf('//');
      return slash === -1 ? line : line.slice(0, slash);
    })
    .join('\n');
}

/**
 * Find the first index of `marker` in `line` that is not inside a single- or
 * double-quoted string, or `-1`. Used so a `#` inside a quoted string is not
 * mistaken for a comment.
 */
function indexOfUnquoted(line: string, marker: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === marker && !inSingle && !inDouble) {
      return i;
    }
  }
  return -1;
}

/** Sort + dedupe a list of names for deterministic, stable output. */
function unique(names: string[]): string[] {
  return [...new Set(names)].sort();
}
