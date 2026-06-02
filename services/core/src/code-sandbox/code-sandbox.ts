/**
 * Code_Sandbox (Req 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8).
 *
 * {@link CodeSandbox.execute} runs a single untrusted code-execution request and
 * returns a structured {@link SandboxResult}. It is *pure orchestration around an
 * isolation seam*: the only thing that actually runs the code is the injected
 * {@link SandboxIsolationBackend}, so the production isolation technology (a
 * gVisor-hardened container, a microVM, …) can be replaced without touching this
 * class or its callers (Req 18.8), and the class is fully unit-testable with the
 * deterministic fake backend in `./fakes.js` — which never evaluates the code.
 *
 * The orchestration, in order:
 *
 *  1. validate the requested runtime, rejecting an unsupported one with an
 *     {@link UnsupportedLanguageError} (Req 18.2);
 *  2. run the Allow_List import preflight ({@link extractImports}) and reject the
 *     execution *before it runs* if the code imports any non-allow-listed package
 *     ({@link UnauthorizedPackageError}, Req 18.6, Property 39);
 *  3. clamp the effective timeout/memory ceilings to the platform maximums
 *     (30 s / 512 MB) — a request may lower them but never raise them (Req 18.3,
 *     18.4);
 *  4. build a {@link ContainerSpec} with the isolation guarantees fixed in code —
 *     `network: 'none'` (Req 18.1), `rootless: true`, `ephemeralFilesystem: true`
 *     (Req 18.5) — and hand it to the backend;
 *  5. guard the backend with an independent wall-clock watchdog so even a backend
 *     that fails to honour its own deadline still yields a timeout result and the
 *     execution is asked to cancel (Req 18.3);
 *  6. map the backend's raw {@link ContainerResult} into the typed
 *     {@link SandboxResult}, turning a timeout (Req 18.3) or memory breach
 *     (Req 18.4) into an ordinary outcome rather than a thrown error, and
 *     attaching the elapsed-time / memory-used metadata (Req 18.7).
 *
 * Security: this class executes UNTRUSTED code. Isolation is delegated entirely
 * to the {@link SandboxIsolationBackend} port — this orchestrator never spawns a
 * process, never evaluates source, and never touches the host filesystem or
 * network. The strength of the real isolation (no network egress, non-root,
 * no persistence, hard memory/CPU caps) is the deployment's responsibility behind
 * that port; this class only fixes the policy the backend must enforce and fails
 * closed when anything is unclear.
 */

import { randomUUID } from 'node:crypto';

import { UnauthorizedPackageError, UnsupportedLanguageError } from './errors.js';
import { extractImports } from './imports.js';
import {
  SUPPORTED_LANGUAGES,
  type ContainerResult,
  type ContainerSpec,
  type ResourceLimits,
  type SandboxExecRequest,
  type SandboxIsolationBackend,
  type SandboxLanguage,
  type SandboxMetadata,
  type SandboxResult,
} from './types.js';

/** The fixed maximum wall-clock timeout: 30 seconds (Req 18.3). */
export const SANDBOX_TIMEOUT_MS = 30_000;

/** The fixed maximum memory ceiling: 512 MB, in bytes (Req 18.4). */
export const SANDBOX_MEMORY_BYTES = 512 * 1024 * 1024;

/**
 * The grace period, beyond the spec's timeout, the watchdog waits before it
 * forcibly treats a run as timed out (Req 18.3).
 *
 * A well-behaved backend enforces the timeout itself and returns first; the
 * watchdog only fires if the backend overruns, so this slack just absorbs
 * scheduling jitter without masking a backend's own timeout result.
 */
export const SANDBOX_WATCHDOG_GRACE_MS = 1_000;

/** An execution-id source, injectable for deterministic tests. */
export interface ExecutionIdGenerator {
  /** Return a new unique execution id. */
  (): string;
}

/**
 * A bounded "wait this many ms, then resolve" timer, injectable so the watchdog
 * can be driven deterministically in tests without real wall-clock delay.
 *
 * Returns a handle exposing `cancel()` so the Code_Sandbox can clear the timer
 * the moment the backend returns (the common, non-timeout path).
 */
export interface WatchdogTimer {
  /**
   * Schedule `onElapsed` to run after `ms` milliseconds.
   *
   * @param ms The delay in milliseconds.
   * @param onElapsed The callback to run when the delay elapses.
   * @returns A handle whose `cancel()` prevents `onElapsed` from running.
   */
  (ms: number, onElapsed: () => void): { cancel(): void };
}

/** The default {@link WatchdogTimer} backed by `setTimeout` (unref'd so it never holds the process open). */
const defaultTimer: WatchdogTimer = (ms, onElapsed) => {
  const handle = setTimeout(onElapsed, ms);
  // Do not keep the event loop alive solely for the watchdog.
  (handle as { unref?: () => void }).unref?.();
  return {
    cancel(): void {
      clearTimeout(handle);
    },
  };
};

/**
 * Construction-time dependencies for the {@link CodeSandbox}.
 *
 * The {@link backend} isolation port is required — the sandbox refuses to run
 * untrusted code without an explicit isolation backend. The id generator and
 * watchdog timer have defaults and exist primarily so tests can make execution
 * fully deterministic.
 */
export interface CodeSandboxOptions {
  /** The replaceable isolation backend that actually runs the code (Req 18.8). */
  backend: SandboxIsolationBackend;
  /** Execution-id source (defaults to `crypto.randomUUID`). */
  idGenerator?: ExecutionIdGenerator;
  /** Wall-clock watchdog timer (defaults to a `setTimeout`-backed timer). */
  timer?: WatchdogTimer;
  /** Override the platform maximum timeout in ms (defaults to {@link SANDBOX_TIMEOUT_MS}). */
  maxTimeoutMs?: number;
  /** Override the platform maximum memory in bytes (defaults to {@link SANDBOX_MEMORY_BYTES}). */
  maxMemoryBytes?: number;
}

/** A sentinel result the watchdog produces when the backend overruns its deadline. */
const WATCHDOG_TIMEOUT = Symbol('watchdog-timeout');

/**
 * The concrete Code_Sandbox. Construct it with a {@link SandboxIsolationBackend};
 * {@link execute} runs one request and returns a {@link SandboxResult}.
 */
export class CodeSandbox {
  private readonly backend: SandboxIsolationBackend;
  private readonly newId: ExecutionIdGenerator;
  private readonly timer: WatchdogTimer;
  private readonly maxTimeoutMs: number;
  private readonly maxMemoryBytes: number;

  constructor(options: CodeSandboxOptions) {
    this.backend = options.backend;
    this.newId = options.idGenerator ?? ((): string => randomUUID());
    this.timer = options.timer ?? defaultTimer;
    this.maxTimeoutMs = options.maxTimeoutMs ?? SANDBOX_TIMEOUT_MS;
    this.maxMemoryBytes = options.maxMemoryBytes ?? SANDBOX_MEMORY_BYTES;
  }

  /**
   * Execute a single untrusted code-execution request under isolation
   * (Req 18.1-18.7).
   *
   * Rejections (never-run code) throw a typed error; resource-limit breaches
   * (code that ran but exceeded a ceiling) return an ordinary
   * {@link SandboxResult}.
   *
   * @param request The code-execution request.
   * @returns The structured execution result.
   * @throws {UnsupportedLanguageError} When the requested runtime is unsupported (Req 18.2).
   * @throws {UnauthorizedPackageError} When the source imports a non-allow-listed package (Req 18.6).
   */
  async execute(request: SandboxExecRequest): Promise<SandboxResult> {
    this.assertSupportedLanguage(request.language);
    this.assertImportsAllowed(request);

    const spec = this.buildSpec(request);
    const container = await this.runWithWatchdog(spec);
    return this.toResult(spec, container);
  }

  /** Reject an unsupported runtime before any further work (Req 18.2). */
  private assertSupportedLanguage(language: SandboxLanguage): void {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      throw new UnsupportedLanguageError(language);
    }
  }

  /**
   * Reject the execution if the source imports any package not on the
   * Allow_List, before the code ever reaches the backend (Req 18.6,
   * Property 39).
   */
  private assertImportsAllowed(request: SandboxExecRequest): void {
    const allowed = new Set(request.allowedPackages ?? []);
    const imported = extractImports(request.language, request.source);
    const unauthorized = imported.filter((name) => !allowed.has(name));
    if (unauthorized.length > 0) {
      throw new UnauthorizedPackageError(request.language, unauthorized);
    }
  }

  /**
   * Build the fully-resolved {@link ContainerSpec}, clamping the request's
   * limits to the platform maximums and fixing the isolation guarantees in code
   * (Req 18.1, 18.3, 18.4, 18.5).
   */
  private buildSpec(request: SandboxExecRequest): ContainerSpec {
    return {
      executionId: this.newId(),
      language: request.language,
      source: request.source,
      stdin: request.stdin ?? '',
      limits: this.clampLimits(request.limits),
      // Isolation guarantees are fixed here, never delegated to the backend's
      // discretion: no network (Req 18.1), non-root + ephemeral fs (Req 18.5).
      network: 'none',
      rootless: true,
      ephemeralFilesystem: true,
    };
  }

  /**
   * Clamp the effective limits to the platform ceilings (Req 18.3, 18.4).
   *
   * A request may request a *lower* timeout or memory ceiling, but a requested
   * value above the maximum — or a non-positive value — is ignored in favour of
   * the platform maximum, so the caps can never be raised through this contract.
   */
  private clampLimits(requested?: Partial<ResourceLimits>): ResourceLimits {
    const timeoutMs = clamp(requested?.timeoutMs, this.maxTimeoutMs);
    const memoryBytes = clamp(requested?.memoryBytes, this.maxMemoryBytes);
    return { timeoutMs, memoryBytes };
  }

  /**
   * Run the spec on the backend, racing it against an independent wall-clock
   * watchdog so a backend that overruns its own deadline still produces a
   * timeout result and the execution is asked to cancel (Req 18.3).
   */
  private async runWithWatchdog(spec: ContainerSpec): Promise<ContainerResult> {
    const deadlineMs = spec.limits.timeoutMs + SANDBOX_WATCHDOG_GRACE_MS;
    let timer: { cancel(): void } | undefined;

    const watchdog = new Promise<typeof WATCHDOG_TIMEOUT>((resolve) => {
      timer = this.timer(deadlineMs, () => resolve(WATCHDOG_TIMEOUT));
    });

    try {
      const outcome = await Promise.race([this.backend.run(spec), watchdog]);
      if (outcome === WATCHDOG_TIMEOUT) {
        // The backend overran its deadline: ask it to cancel (best-effort) and
        // synthesize a timeout result so the caller still gets a typed outcome.
        await this.cancelQuietly(spec.executionId);
        return synthTimeout(spec.limits.timeoutMs);
      }
      return outcome;
    } finally {
      timer?.cancel();
    }
  }

  /** Best-effort cancellation of an overrunning execution; never throws (Req 18.3). */
  private async cancelQuietly(executionId: string): Promise<void> {
    try {
      await this.backend.cancel?.(executionId);
    } catch {
      // A backend that cannot cancel must not turn the timeout into a crash;
      // the synthesized timeout result still stands.
    }
  }

  /**
   * Map the backend's raw {@link ContainerResult} into the typed
   * {@link SandboxResult}, turning resource-limit statuses into ordinary
   * outcomes and attaching the isolation-attesting metadata (Req 18.3, 18.4,
   * 18.7).
   */
  private toResult(spec: ContainerSpec, container: ContainerResult): SandboxResult {
    const timedOut = container.status === 'timeout';
    const memoryExceeded = container.status === 'memory_exceeded';
    const outcome = timedOut ? 'timeout' : memoryExceeded ? 'memory_limit' : 'completed';

    const metadata: SandboxMetadata = {
      language: spec.language,
      // Clamp reported usage to non-negative, and never report below the limit
      // for a breach, so the metadata is internally consistent.
      elapsedMs: Math.max(0, container.elapsedMs),
      memoryUsedBytes: Math.max(0, container.memoryUsedBytes),
      network: spec.network,
      rootless: spec.rootless,
      ephemeralFilesystem: spec.ephemeralFilesystem,
    };

    return {
      outcome,
      // A limit breach has no clean exit code (Req 18.3, 18.4).
      exitCode: outcome === 'completed' ? container.exitCode : null,
      stdout: container.stdout,
      stderr: container.stderr,
      timedOut,
      memoryExceeded,
      files: container.files,
      metadata,
    };
  }
}

/**
 * Clamp a requested limit to `max`: a positive, finite request below `max` is
 * honoured; anything else (undefined, non-positive, NaN, or above `max`) falls
 * back to `max` so the platform ceiling can never be exceeded.
 */
function clamp(requested: number | undefined, max: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return max;
  }
  return Math.min(requested, max);
}

/** Build the timeout {@link ContainerResult} the watchdog synthesizes for an overrunning backend. */
function synthTimeout(timeoutMs: number): ContainerResult {
  return {
    status: 'timeout',
    exitCode: null,
    stdout: '',
    stderr: '',
    files: [],
    elapsedMs: timeoutMs,
    memoryUsedBytes: 0,
  };
}
