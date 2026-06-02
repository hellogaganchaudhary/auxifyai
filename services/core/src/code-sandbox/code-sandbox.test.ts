/**
 * Unit tests for the Code_Sandbox (Req 18.1-18.7).
 *
 * These exercise the orchestration against the deterministic
 * {@link FakeIsolationBackend} in `./fakes.js` — which never evaluates the
 * submitted code — covering the task's required scenarios:
 *
 *  - a successful execution returns captured output + exit code + metadata
 *    (Req 18.2, 18.7);
 *  - the 30 s wall-clock timeout is enforced and surfaced as a timeout result,
 *    both when the backend reports it and when the backend overruns and the
 *    watchdog steps in (Req 18.3);
 *  - a 512 MB memory-limit breach is surfaced as a memory-limit result (Req 18.4);
 *  - a non-zero exit is reported as a completed run with that exit code;
 *  - the isolation seam holds: every spec the sandbox hands the backend denies
 *    network egress, runs non-root, and uses an ephemeral filesystem (Req 18.1,
 *    18.5), and untrusted code only ever crosses the backend port;
 *  - an unsupported language and a non-allow-listed import are rejected before
 *    the code runs (Req 18.2, 18.6).
 */

import { describe, expect, it } from 'vitest';

import {
  CodeSandbox,
  SANDBOX_MEMORY_BYTES,
  SANDBOX_TIMEOUT_MS,
  type CodeSandboxOptions,
  type WatchdogTimer,
} from './code-sandbox.js';
import { UnauthorizedPackageError, UnsupportedLanguageError } from './errors.js';
import { FakeIsolationBackend, makeGeneratedFile, type SeededOutcome } from './fakes.js';
import type { SandboxExecRequest, SandboxLanguage } from './types.js';

/** A watchdog timer that fires synchronously, for deterministic timeout tests. */
const immediateTimer: WatchdogTimer = (_ms, onElapsed) => {
  onElapsed();
  return { cancel(): void {} };
};

/** A watchdog timer that never fires, so the backend always wins the race. */
const neverTimer: WatchdogTimer = () => ({ cancel(): void {} });

/** Build a sandbox wired to a fresh fake backend, with overrides. */
function makeSandbox(
  seed: Partial<Record<SandboxLanguage, SeededOutcome>> = {},
  overrides: Partial<CodeSandboxOptions> = {},
): { sandbox: CodeSandbox; backend: FakeIsolationBackend } {
  const backend =
    overrides.backend instanceof FakeIsolationBackend
      ? overrides.backend
      : new FakeIsolationBackend(seed);
  const sandbox = new CodeSandbox({
    backend,
    // Default to a never-firing watchdog + fixed ids so non-timeout tests are
    // deterministic; individual timeout tests override the timer.
    idGenerator: makeSeqIds(),
    timer: neverTimer,
    ...overrides,
  });
  return { sandbox, backend };
}

/** A deterministic execution-id generator. */
function makeSeqIds(): () => string {
  let n = 0;
  return () => `exec-${(n += 1)}`;
}

const PY: SandboxExecRequest = { language: 'python', source: 'print("hi")' };

describe('CodeSandbox — successful execution (Req 18.2, 18.7)', () => {
  it('returns captured stdout/stderr, a zero exit code, and complete metadata', async () => {
    const { sandbox } = makeSandbox({
      python: { stdout: 'hello world\n', stderr: '', exitCode: 0, elapsedMs: 12, memoryUsedBytes: 4096 },
    });

    const result = await sandbox.execute(PY);

    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
    expect(result.memoryExceeded).toBe(false);
    // Metadata carries elapsed time and memory used (Req 18.7)...
    expect(result.metadata.elapsedMs).toBe(12);
    expect(result.metadata.memoryUsedBytes).toBe(4096);
    expect(result.metadata.language).toBe('python');
    // ...and attests the isolation constraints the run executed under.
    expect(result.metadata.network).toBe('none');
    expect(result.metadata.rootless).toBe(true);
    expect(result.metadata.ephemeralFilesystem).toBe(true);
  });

  it('returns the generated files the backend captured (Req 18.7)', async () => {
    const file = makeGeneratedFile('out/result.txt', 'generated output');
    const { sandbox } = makeSandbox({ python: { files: [file] } });

    const result = await sandbox.execute(PY);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('out/result.txt');
    expect(Buffer.from(result.files[0]!.contentBase64, 'base64').toString('utf8')).toBe(
      'generated output',
    );
  });

  it('supports every documented runtime: python, node, shell, sql (Req 18.2)', async () => {
    const languages: SandboxLanguage[] = ['python', 'node', 'shell', 'sql'];
    for (const language of languages) {
      const { sandbox } = makeSandbox();
      const result = await sandbox.execute({ language, source: '' });
      expect(result.outcome).toBe('completed');
      expect(result.metadata.language).toBe(language);
    }
  });

  it('feeds stdin and clamps a too-large requested limit down to the platform maximum', async () => {
    const { sandbox, backend } = makeSandbox();

    await sandbox.execute({
      language: 'node',
      source: 'process.stdout.write("ok")',
      stdin: 'piped input',
      // Request absurd limits; the sandbox must clamp them to the maximums.
      limits: { timeoutMs: 10 * 60_000, memoryBytes: 8 * 1024 * 1024 * 1024 },
    });

    const spec = backend.runs[0]!;
    expect(spec.stdin).toBe('piped input');
    expect(spec.limits.timeoutMs).toBe(SANDBOX_TIMEOUT_MS);
    expect(spec.limits.memoryBytes).toBe(SANDBOX_MEMORY_BYTES);
  });

  it('honours a lower requested limit but never raises the ceiling', async () => {
    const { sandbox, backend } = makeSandbox();

    await sandbox.execute({
      language: 'python',
      source: 'pass',
      limits: { timeoutMs: 5_000, memoryBytes: 64 * 1024 * 1024 },
    });

    const spec = backend.runs[0]!;
    expect(spec.limits.timeoutMs).toBe(5_000);
    expect(spec.limits.memoryBytes).toBe(64 * 1024 * 1024);
  });
});

describe('CodeSandbox — non-zero exit (Req 18.7)', () => {
  it('reports a completed run carrying the program’s non-zero exit code', async () => {
    const { sandbox } = makeSandbox({
      python: { status: 'exited', exitCode: 3, stderr: 'Traceback: boom\n' },
    });

    const result = await sandbox.execute(PY);

    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('Traceback: boom\n');
    expect(result.timedOut).toBe(false);
    expect(result.memoryExceeded).toBe(false);
  });
});

describe('CodeSandbox — timeout enforcement (Req 18.3)', () => {
  it('surfaces a backend-reported timeout as a timeout result with no exit code', async () => {
    const { sandbox } = makeSandbox({
      python: { status: 'timeout', stdout: 'partial', elapsedMs: SANDBOX_TIMEOUT_MS },
    });

    const result = await sandbox.execute(PY);

    expect(result.outcome).toBe('timeout');
    expect(result.timedOut).toBe(true);
    expect(result.memoryExceeded).toBe(false);
    expect(result.exitCode).toBeNull();
    // Whatever output was captured before the kill is still returned.
    expect(result.stdout).toBe('partial');
  });

  it('enforces the timeout via the watchdog when the backend overruns, and cancels it', async () => {
    // The backend "hangs" (never resolves on its own within the test); the
    // immediate watchdog fires and the sandbox synthesizes a timeout result.
    const backend = new FakeIsolationBackend(
      { python: { hangForMs: 10_000 } },
      // Never resolve the hang, so the only way out is the watchdog.
      () => new Promise<void>(() => {}),
    );
    const { sandbox } = makeSandbox({}, { backend, timer: immediateTimer });

    const result = await sandbox.execute(PY);

    expect(result.outcome).toBe('timeout');
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    // The overrunning execution was asked to cancel (Req 18.3).
    expect(backend.cancellations).toEqual(['exec-1']);
  });
});

describe('CodeSandbox — memory-limit enforcement (Req 18.4)', () => {
  it('surfaces a memory breach as a memory-limit result with no exit code', async () => {
    const { sandbox } = makeSandbox({
      node: { status: 'memory_exceeded', stderr: 'OOM', memoryUsedBytes: SANDBOX_MEMORY_BYTES },
    });

    const result = await sandbox.execute({ language: 'node', source: 'allocate()' });

    expect(result.outcome).toBe('memory_limit');
    expect(result.memoryExceeded).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.metadata.memoryUsedBytes).toBe(SANDBOX_MEMORY_BYTES);
  });
});

describe('CodeSandbox — isolation seam (Req 18.1, 18.5, 18.8)', () => {
  it('hands the backend a spec that denies network, runs non-root, and uses an ephemeral fs', async () => {
    const { sandbox, backend } = makeSandbox();

    await sandbox.execute(PY);

    expect(backend.runs).toHaveLength(1);
    const spec = backend.runs[0]!;
    expect(spec.network).toBe('none');
    expect(spec.rootless).toBe(true);
    expect(spec.ephemeralFilesystem).toBe(true);
    expect(spec.limits.timeoutMs).toBe(SANDBOX_TIMEOUT_MS);
    expect(spec.limits.memoryBytes).toBe(SANDBOX_MEMORY_BYTES);
  });

  it('routes untrusted code only through the backend port — never executing it here', async () => {
    // A source string that WOULD be catastrophic if anything evaluated it.
    const malicious = 'import os; os.system("rm -rf /")';
    const { sandbox, backend } = makeSandbox(
      { python: { stdout: 'inert' } },
      // Allow the `os` import so the request reaches the backend rather than
      // being rejected by the preflight — the point here is that even reaching
      // the backend, the code is treated as inert data.
    );

    const result = await sandbox.execute({
      language: 'python',
      source: malicious,
      allowedPackages: ['os'],
    });

    // The backend received the source verbatim as data and returned canned
    // output; nothing executed it.
    expect(backend.runs[0]?.source).toBe(malicious);
    expect(result.stdout).toBe('inert');
    expect(result.outcome).toBe('completed');
  });

  it('the fake backend rejects a spec whose isolation flags were weakened', async () => {
    // Directly probing the fake's guard documents that a real backend would
    // refuse a non-isolated spec — the seam is not advisory.
    const backend = new FakeIsolationBackend();
    await expect(
      backend.run({
        executionId: 'x',
        language: 'python',
        source: '',
        stdin: '',
        limits: { timeoutMs: 1000, memoryBytes: 1024 },
        network: 'none',
        rootless: false,
        ephemeralFilesystem: true,
      }),
    ).rejects.toThrow(/Isolation breach/);
  });
});

describe('CodeSandbox — rejections that never run the code (Req 18.2, 18.6)', () => {
  it('rejects an unsupported language before reaching the backend', async () => {
    const { sandbox, backend } = makeSandbox();

    await expect(
      sandbox.execute({ language: 'ruby' as SandboxLanguage, source: 'puts 1' }),
    ).rejects.toBeInstanceOf(UnsupportedLanguageError);
    expect(backend.runs).toHaveLength(0);
  });

  it('projects an unsupported-language rejection to a validation PlatformError', async () => {
    const { sandbox } = makeSandbox();
    const error = await sandbox
      .execute({ language: 'go' as SandboxLanguage, source: '' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (caught: unknown) => caught as UnsupportedLanguageError,
      );

    const platform = error.toPlatformError('corr-lang');
    expect(platform.category).toBe('validation');
    expect(platform.code).toBe('SANDBOX_UNSUPPORTED_LANGUAGE');
  });

  it('rejects a non-allow-listed import before reaching the backend (Req 18.6)', async () => {
    const { sandbox, backend } = makeSandbox();

    await expect(
      sandbox.execute({
        language: 'python',
        source: 'import requests\nprint(requests.get("http://x"))',
        allowedPackages: [],
      }),
    ).rejects.toBeInstanceOf(UnauthorizedPackageError);
    // The untrusted code never reached the isolation backend.
    expect(backend.runs).toHaveLength(0);
  });

  it('projects an unauthorized-import rejection to a sandbox_limit PlatformError naming the package', async () => {
    const { sandbox } = makeSandbox();
    const error = await sandbox
      .execute({ language: 'python', source: 'import requests, numpy', allowedPackages: ['numpy'] })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (caught: unknown) => caught as UnauthorizedPackageError,
      );

    expect(error.unauthorizedPackages).toEqual(['requests']);
    const platform = error.toPlatformError('corr-pkg');
    expect(platform.category).toBe('sandbox_limit');
    expect(platform.code).toBe('SANDBOX_UNAUTHORIZED_PACKAGE');
    expect(platform.details).toMatchObject({ unauthorizedPackages: ['requests'] });
  });

  it('admits code whose every import is on the Allow_List', async () => {
    const { sandbox, backend } = makeSandbox({ python: { stdout: 'ok' } });

    const result = await sandbox.execute({
      language: 'python',
      source: 'import os\nfrom json import dumps\nimport numpy as np',
      allowedPackages: ['os', 'json', 'numpy'],
    });

    expect(result.outcome).toBe('completed');
    expect(backend.runs).toHaveLength(1);
  });
});
