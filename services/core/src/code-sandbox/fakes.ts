/**
 * Test fakes for the Code_Sandbox (Req 18.1, 18.3, 18.4, 18.5, 18.7, 18.8).
 *
 * The isolation backend is the one thing the Code_Sandbox cannot do purely, so
 * it is the one thing tests fake. {@link FakeIsolationBackend} is a deterministic,
 * in-memory {@link SandboxIsolationBackend} that returns *canned* results keyed
 * by language (with optional finer overrides). It is the test's stand-in for a
 * real hardened container/microVM.
 *
 * SECURITY — this fake NEVER runs the submitted code. It does not `eval`, does
 * not spawn a process, does not import anything, and does not touch the
 * filesystem or network. That is deliberate and load-bearing: the whole point of
 * the sandbox is that untrusted code only ever runs behind the isolation port,
 * so even the *test* backend must treat `source` as inert data. Every result is
 * fabricated from the seed map, and the backend asserts that the
 * {@link ContainerSpec} it receives carries the isolation guarantees the
 * Code_Sandbox is responsible for fixing (no network, non-root, ephemeral fs);
 * if those are ever absent the fake throws, so a regression that weakens the
 * seam fails the tests loudly.
 */

import {
  type ContainerResult,
  type ContainerSpec,
  type GeneratedFile,
  type SandboxIsolationBackend,
  type SandboxLanguage,
} from './types.js';

/** A canned outcome the {@link FakeIsolationBackend} returns for a matching spec. */
export interface SeededOutcome {
  /** The terminal status to report (defaults to `exited`). */
  status?: ContainerResult['status'];
  /** The exit code for an `exited` run (defaults to 0; ignored for a limit breach). */
  exitCode?: number | null;
  /** The standard output to return (defaults to a deterministic stub). */
  stdout?: string;
  /** The standard error to return (defaults to empty). */
  stderr?: string;
  /** The files to report as generated (defaults to none). */
  files?: GeneratedFile[];
  /** The elapsed time in ms to report (defaults to a small deterministic value). */
  elapsedMs?: number;
  /** The peak memory in bytes to report (defaults to a small deterministic value). */
  memoryUsedBytes?: number;
  /**
   * When set, {@link FakeIsolationBackend.run} never resolves on its own and
   * instead waits `hangForMs` milliseconds via the injected waiter — used to
   * exercise the Code_Sandbox's wall-clock watchdog (Req 18.3). The watcher
   * still records the spec so the test can assert cancellation.
   */
  hangForMs?: number;
}

/** A minimal async waiter so a hanging backend can be driven without real delay in tests. */
export interface FakeWaiter {
  /** Resolve after `ms` milliseconds (or however the test chooses to fulfil it). */
  (ms: number): Promise<void>;
}

/** Build a {@link GeneratedFile} from a path + UTF-8 text, for tests (Req 18.7). */
export function makeGeneratedFile(path: string, text: string): GeneratedFile {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    contentBase64: Buffer.from(bytes).toString('base64'),
    sizeBytes: bytes.byteLength,
  };
}

/**
 * A deterministic, in-memory {@link SandboxIsolationBackend} that fabricates
 * results without ever executing the submitted code.
 *
 * Seed canned outcomes per language with {@link seedLanguage} (or in the
 * constructor); an unseeded language returns a benign `exited` 0 result. The
 * backend records every {@link ContainerSpec} it receives in {@link runs} and
 * every cancelled execution id in {@link cancellations} so a test can assert the
 * isolation flags, the clamped limits, and watchdog-driven cancellation.
 */
export class FakeIsolationBackend implements SandboxIsolationBackend {
  /** Every spec passed to {@link run}, in order, exactly as the Code_Sandbox built it. */
  readonly runs: ContainerSpec[] = [];
  /** Every execution id passed to {@link cancel}, in order. */
  readonly cancellations: string[] = [];

  private readonly byLanguage = new Map<SandboxLanguage, SeededOutcome>();

  /**
   * @param seed Optional per-language canned outcomes.
   * @param waiter Optional waiter used to simulate a hanging backend
   *   ({@link SeededOutcome.hangForMs}); defaults to a real `setTimeout`.
   */
  constructor(
    seed: Partial<Record<SandboxLanguage, SeededOutcome>> = {},
    private readonly waiter: FakeWaiter = (ms): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    for (const [language, outcome] of Object.entries(seed)) {
      if (outcome !== undefined) {
        this.byLanguage.set(language as SandboxLanguage, outcome);
      }
    }
  }

  /** Seed (or replace) the canned outcome for a language. */
  seedLanguage(language: SandboxLanguage, outcome: SeededOutcome): this {
    this.byLanguage.set(language, outcome);
    return this;
  }

  async run(spec: ContainerSpec): Promise<ContainerResult> {
    this.runs.push(spec);

    // The isolation seam must be intact on every spec the Code_Sandbox builds.
    // A real hardened backend would refuse a spec that asked for network access
    // or root; the fake asserts the same so a weakened seam fails loudly.
    assertIsolated(spec);

    const seeded = this.byLanguage.get(spec.language) ?? {};

    if (seeded.hangForMs !== undefined) {
      // Simulate a backend that ignores its own deadline so the Code_Sandbox's
      // watchdog has to step in (Req 18.3). It resolves only well after the
      // grace period; in practice the watchdog wins the race first.
      await this.waiter(seeded.hangForMs);
    }

    const status = seeded.status ?? 'exited';
    const isBreach = status === 'timeout' || status === 'memory_exceeded';

    return {
      status,
      exitCode: isBreach ? null : (seeded.exitCode ?? 0),
      stdout: seeded.stdout ?? `[fake:${spec.language}] stdout`,
      stderr: seeded.stderr ?? '',
      files: seeded.files ?? [],
      elapsedMs: seeded.elapsedMs ?? 5,
      memoryUsedBytes: seeded.memoryUsedBytes ?? 1024,
    };
  }

  async cancel(executionId: string): Promise<void> {
    this.cancellations.push(executionId);
  }
}

/**
 * Assert the Code_Sandbox handed the backend a spec with the isolation
 * guarantees intact: no network egress (Req 18.1), non-root, and an ephemeral
 * filesystem (Req 18.5). A real backend would enforce these; the fake checks
 * them so a test catches any regression that weakens the seam.
 */
function assertIsolated(spec: ContainerSpec): void {
  if (spec.network !== 'none') {
    throw new Error(
      `Isolation breach: spec requested network "${spec.network}"; the sandbox must deny egress (Req 18.1)`,
    );
  }
  if (spec.rootless !== true) {
    throw new Error('Isolation breach: spec did not require rootless execution (Req 18.5)');
  }
  if (spec.ephemeralFilesystem !== true) {
    throw new Error('Isolation breach: spec did not require an ephemeral filesystem (Req 18.5)');
  }
}
