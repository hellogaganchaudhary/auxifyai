/**
 * Feature: auxify-ai-platform, Property 39: Sandbox rejects non-allow-listed
 * imports and returns complete results.
 *
 * Validates: Requirements 18.6, 18.7
 *
 * This pins down the Allow_List import gate and result completeness of the
 * {@link CodeSandbox} (task 15.1) against an INDEPENDENT oracle, over arbitrary
 * programs across every supported runtime (python / node / shell, plus `sql` as
 * a no-import control), an arbitrary set of imported packages, and an arbitrary
 * Allow_List.
 *
 * The oracle is the lexical import set the program declares. Each program's
 * source is built *deterministically* from a generated set of simple-identifier
 * package names — `import <pkg>` lines for python, `import x from '<pkg>'` for
 * node, bare command words for shell — so the conservative lexical extractor
 * ({@link extractImports}) recovers exactly that set; the test asserts this
 * recovery on every run so the oracle is provably exact. `sql` has no import
 * concept, so its declared set is always empty and it always runs regardless of
 * the (still arbitrary) Allow_List — the control case.
 *
 * Two mutually-exclusive faces of the same property are checked:
 *
 *   1. Gating (Req 18.6) — if ANY declared import is not on the Allow_List, then
 *      `execute` rejects with an {@link UnauthorizedPackageError} whose
 *      `unauthorizedPackages` is EXACTLY the missing set (sorted, unique) and
 *      whose `language` matches, AND the {@link FakeIsolationBackend} recorded
 *      ZERO runs — the untrusted code never reached the isolation backend.
 *
 *   2. Completeness (Req 18.7) — if EVERY declared import is allow-listed (or
 *      there are none), then `execute` resolves to a complete
 *      {@link SandboxResult}: the backend ran exactly once, the outcome is
 *      `completed` with `timedOut`/`memoryExceeded` false, the exit code is the
 *      seeded code, and stdout/stderr/files plus full metadata (language,
 *      elapsed time, memory used, and the attesting isolation flags) are present.
 *
 * The backend is the deterministic {@link FakeIsolationBackend} from `./fakes.js`
 * — which NEVER evaluates the submitted source — so the property is checked
 * against the real Code_Sandbox orchestration, not a re-implementation, and no
 * untrusted code is ever run.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CodeSandbox, type WatchdogTimer } from './code-sandbox.js';
import { UnauthorizedPackageError } from './errors.js';
import { FakeIsolationBackend, type SeededOutcome } from './fakes.js';
import { extractImports } from './imports.js';
import {
  SUPPORTED_LANGUAGES,
  type SandboxExecRequest,
  type SandboxLanguage,
} from './types.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

/** A watchdog timer that never fires, so the backend always wins the race (deterministic, no real delay). */
const neverTimer: WatchdogTimer = () => ({ cancel(): void {} });

/** A deterministic, monotonic execution-id source. */
function seqIds(): () => string {
  let n = 0;
  return () => `exec-${(n += 1)}`;
}

/**
 * Shell command words the lexical extractor deliberately SKIPS (env-assignment
 * prefixes, `sudo`, and block-introducing keywords). Excluding them from
 * generated package names keeps the lexical oracle exact for the shell runtime,
 * where a "package" is the command word a line invokes.
 */
const SHELL_SKIPPED_WORDS = new Set(['sudo', 'then', 'do', 'else']);

const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');
const LOWER_DIGIT = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

/**
 * A simple identifier package name (`[a-z][a-z0-9]{0,7}`) that every runtime's
 * lexical extractor recovers verbatim. Words the shell extractor skips are
 * filtered out so the oracle stays exact across all languages.
 */
const pkgNameArb = fc
  .tuple(fc.constantFrom(...LOWER), fc.array(fc.constantFrom(...LOWER_DIGIT), { maxLength: 7 }))
  .map(([head, tail]) => head + tail.join(''))
  .filter((name) => !SHELL_SKIPPED_WORDS.has(name));

/**
 * An arbitrary scenario: a runtime, a set of imported packages, an Allow_List
 * drawn from those packages plus arbitrary extra (non-imported) allowed names,
 * and a seeded normal exit code.
 *
 * `declared` is the oracle import set the source will lexically declare: the
 * deduped+sorted package set for python/node/shell, and always empty for the
 * `sql` control. The Allow_List is any subarray of (declared ∪ extra), so it
 * ranges over none / partial / full coverage.
 */
const scenarioArb = fc
  .record({
    language: fc.constantFrom(...SUPPORTED_LANGUAGES),
    packages: fc.array(pkgNameArb, { maxLength: 5 }),
    allowExtra: fc.array(pkgNameArb, { maxLength: 4 }),
    seededExitCode: fc.integer({ min: 0, max: 5 }),
  })
  .chain((base) => {
    const sourcePackages = [...new Set(base.packages)];
    // `sql` has no import concept: its declared set is always empty (control).
    const declared = base.language === 'sql' ? [] : [...sourcePackages].sort();
    const allowPool = [...new Set([...declared, ...base.allowExtra])];
    return fc.record({
      language: fc.constant(base.language),
      sourcePackages: fc.constant(sourcePackages),
      declared: fc.constant(declared),
      allowList: fc.subarray(allowPool),
      seededExitCode: fc.constant(base.seededExitCode),
    });
  });

/**
 * Build source for `language` that declares exactly `packages` as imports, so
 * the lexical {@link extractImports} oracle recovers them precisely. An empty
 * package set yields a source with no extractable imports.
 */
function buildSource(language: SandboxLanguage, packages: readonly string[]): string {
  if (packages.length === 0) {
    // No imports to declare; `sql` still needs a syntactically plausible body.
    return language === 'sql' ? 'SELECT 1' : '';
  }
  switch (language) {
    case 'python':
      // `import <pkg>` per line → top-level package `<pkg>`.
      return packages.map((p) => `import ${p}`).join('\n');
    case 'node':
      // `import m<i> from '<pkg>'` → bare specifier `<pkg>`.
      return packages.map((p, i) => `import m${i} from '${p}';`).join('\n');
    case 'shell':
      // Each command word on its own line → the invoked binary `<pkg>`.
      return packages.join('\n');
    case 'sql':
      // SQL declares no imports; the identifiers are inert column refs.
      return `SELECT ${packages.join(', ')} FROM staging`;
    default: {
      const never: never = language;
      return never;
    }
  }
}

describe('Feature: auxify-ai-platform, Property 39: Sandbox rejects non-allow-listed imports and returns complete results', () => {
  it('rejects any non-allow-listed import before it runs, and otherwise returns a complete result (Validates: Requirements 18.6, 18.7)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { language, sourcePackages, declared, allowList, seededExitCode } = scenario;
        const source = buildSource(language, sourcePackages);

        // Independent oracle: the import set the source lexically declares is
        // EXACTLY `declared` (empty for the sql control). Asserting recovery
        // here makes the rest of the oracle provably exact.
        expect(extractImports(language, source)).toEqual(declared);

        const allowed = new Set(allowList);
        // The missing set: declared imports absent from the Allow_List. Since
        // `declared` is already sorted+unique, so is this.
        const unauthorized = declared.filter((name) => !allowed.has(name));

        const seed: Partial<Record<SandboxLanguage, SeededOutcome>> = {};
        seed[language] = { exitCode: seededExitCode, stdout: `[run:${language}]` };
        const backend = new FakeIsolationBackend(seed);
        const sandbox = new CodeSandbox({ backend, idGenerator: seqIds(), timer: neverTimer });

        const request: SandboxExecRequest = { language, source, allowedPackages: allowList };

        if (unauthorized.length > 0) {
          // (1) Gating (Req 18.6): a non-allow-listed import rejects before the
          //     code runs, naming exactly the missing packages, and nothing
          //     reaches the isolation backend.
          let thrown: unknown;
          try {
            await sandbox.execute(request);
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(UnauthorizedPackageError);
          const rejection = thrown as UnauthorizedPackageError;
          expect(rejection.language).toBe(language);
          expect(rejection.unauthorizedPackages).toEqual(unauthorized);
          // The untrusted code never crossed the backend port.
          expect(backend.runs).toHaveLength(0);
        } else {
          // (2) Completeness (Req 18.7): every import is allow-listed (or there
          //     are none), so the code runs once and a complete result returns.
          const result = await sandbox.execute(request);

          expect(backend.runs).toHaveLength(1);

          expect(result.outcome).toBe('completed');
          expect(result.timedOut).toBe(false);
          expect(result.memoryExceeded).toBe(false);
          expect(result.exitCode).toBe(seededExitCode);

          // Captured output + files are present and well-typed.
          expect(typeof result.stdout).toBe('string');
          expect(typeof result.stderr).toBe('string');
          expect(Array.isArray(result.files)).toBe(true);

          // Metadata is complete: runtime, elapsed time, memory used, and the
          // attesting isolation flags (Req 18.7).
          expect(result.metadata.language).toBe(language);
          expect(typeof result.metadata.elapsedMs).toBe('number');
          expect(result.metadata.elapsedMs).toBeGreaterThanOrEqual(0);
          expect(typeof result.metadata.memoryUsedBytes).toBe('number');
          expect(result.metadata.memoryUsedBytes).toBeGreaterThanOrEqual(0);
          expect(result.metadata.network).toBe('none');
          expect(result.metadata.rootless).toBe(true);
          expect(result.metadata.ephemeralFilesystem).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
