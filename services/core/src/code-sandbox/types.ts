/**
 * Domain records and the injectable isolation port for the Code_Sandbox
 * (Req 18.1, 18.2, 18.3, 18.4, 18.5, 18.7, 18.8).
 *
 * The Code_Sandbox runs untrusted, agent- or user-submitted code in an isolated
 * backend with no network access by default (Req 18.1), supporting Python 3.12,
 * Node.js 22, shell, and read-only SQL (Req 18.2). It treats the 30-second
 * wall-clock limit (Req 18.3) and the 512 MB memory limit (Req 18.4) as ordinary
 * typed outcomes rather than crashes, runs without filesystem persistence
 * between executions and without root privileges (Req 18.5), and returns
 * captured standard output, standard error, generated files, and execution
 * metadata including elapsed time and memory used (Req 18.7).
 *
 * The single thing it cannot do purely — actually run code under hard isolation
 * — is modelled here as the narrow {@link SandboxIsolationBackend} port. The
 * concrete production backend (a gVisor-hardened container, a microVM, …) is the
 * deployment's responsibility and can be replaced with a stronger isolation
 * backend without changing the code-submission contract (Req 18.8). Because the
 * backend is an injected port, the orchestration — language validation, the
 * Allow_List import preflight, isolation-flag enforcement, the wall-clock
 * watchdog, and result mapping — is fully unit-testable with the deterministic
 * fake in `./fakes.js`, which never evaluates the submitted code.
 */

/**
 * The runtimes the Code_Sandbox supports (Req 18.2).
 *
 *  - `python` — Python 3.12;
 *  - `node` — Node.js 22 (JavaScript/TypeScript);
 *  - `shell` — a shell script;
 *  - `sql` — read-only SQL evaluated against a staging database (the read-only
 *    guarantee is enforced by the backend's connection, never a write path).
 */
export type SandboxLanguage = 'python' | 'node' | 'shell' | 'sql';

/** All {@link SandboxLanguage} values, for iteration, validation, and tests. */
export const SUPPORTED_LANGUAGES: readonly SandboxLanguage[] = [
  'python',
  'node',
  'shell',
  'sql',
] as const;

/**
 * The network policy applied to a sandboxed execution.
 *
 * Network egress is denied by default (Req 18.1); the type is deliberately a
 * single literal so the isolation seam can never be configured "open" through
 * this contract.
 */
export type NetworkPolicy = 'none';

/**
 * The resource limits enforced for a single execution (Req 18.3, 18.4).
 *
 * A request may *lower* these but never raise them past the platform maximums;
 * the {@link import('./code-sandbox.js').CodeSandbox} clamps every effective
 * limit to {@link import('./code-sandbox.js').SANDBOX_TIMEOUT_MS} and
 * {@link import('./code-sandbox.js').SANDBOX_MEMORY_BYTES}.
 */
export interface ResourceLimits {
  /** The wall-clock timeout in milliseconds (Req 18.3). */
  timeoutMs: number;
  /** The memory ceiling in bytes (Req 18.4). */
  memoryBytes: number;
}

/**
 * A code-execution request submitted to the Code_Sandbox.
 *
 * `source` is the untrusted program to run in `language` (Req 18.1, 18.2);
 * `stdin` is fed to the program's standard input; `allowedPackages` is the
 * Allow_List of import names the program may use (Req 18.6); `limits` optionally
 * lowers the timeout/memory ceilings below the platform maximums.
 */
export interface SandboxExecRequest {
  /** The runtime to execute the source under (Req 18.2). */
  language: SandboxLanguage;
  /** The untrusted source code to execute. */
  source: string;
  /** Optional standard input fed to the program. */
  stdin?: string;
  /**
   * The Allow_List of import/package names the source may use (Req 18.6).
   *
   * Any import the source declares that is not in this list rejects the
   * execution before it runs. Defaults to an empty list, i.e. a program that
   * imports anything is rejected unless the import is explicitly allowed.
   */
  allowedPackages?: readonly string[];
  /** Optional limits that lower (never raise) the platform timeout/memory caps. */
  limits?: Partial<ResourceLimits>;
}

/**
 * A file produced by a sandboxed execution and captured for the caller
 * (Req 18.7).
 *
 * The bytes are base64-encoded so the record is transport-stable across the
 * REST_API, the WebSocket_Gateway, and the SDK; nothing on the sandbox host
 * filesystem persists between executions (Req 18.5).
 */
export interface GeneratedFile {
  /** The file path within the execution's ephemeral working directory. */
  path: string;
  /** The file contents, base64-encoded. */
  contentBase64: string;
  /** The file size in bytes. */
  sizeBytes: number;
}

/**
 * The terminal status the {@link SandboxIsolationBackend} reports for a run.
 *
 *  - `exited` — the program ran to completion (with any exit code);
 *  - `timeout` — the backend killed the program at the wall-clock limit (Req 18.3);
 *  - `memory_exceeded` — the backend killed the program at the memory limit (Req 18.4).
 */
export type ContainerStatus = 'exited' | 'timeout' | 'memory_exceeded';

/**
 * The fully-resolved specification the Code_Sandbox hands the isolation backend.
 *
 * Every isolation guarantee is fixed here, not left to the backend's discretion:
 * {@link network} is always `none` (Req 18.1), {@link rootless} is always `true`
 * and {@link ephemeralFilesystem} is always `true` (Req 18.5), and {@link limits}
 * carries the clamped timeout/memory ceilings (Req 18.3, 18.4). The backend's
 * job is only to *enforce* this spec under hard isolation.
 */
export interface ContainerSpec {
  /** A unique id for this execution, used for cancellation and correlation. */
  executionId: string;
  /** The runtime to execute under (Req 18.2). */
  language: SandboxLanguage;
  /** The untrusted source code to execute. */
  source: string;
  /** The standard input fed to the program (empty string when none supplied). */
  stdin: string;
  /** The clamped resource ceilings the backend must enforce (Req 18.3, 18.4). */
  limits: ResourceLimits;
  /** The network policy — always `none` (Req 18.1). */
  network: NetworkPolicy;
  /** Whether the process runs without root privileges — always `true` (Req 18.5). */
  rootless: boolean;
  /** Whether the filesystem is discarded after the run — always `true` (Req 18.5). */
  ephemeralFilesystem: boolean;
}

/**
 * The raw outcome the {@link SandboxIsolationBackend} returns after running a
 * {@link ContainerSpec}.
 *
 * `exitCode` is the program's exit code when {@link status} is `exited`, and
 * `null` when the run was killed by a timeout or memory limit (there is no clean
 * exit). `elapsedMs` and `memoryUsedBytes` are the measured resource usage the
 * Code_Sandbox surfaces in its result metadata (Req 18.7).
 */
export interface ContainerResult {
  /** The terminal status of the run. */
  status: ContainerStatus;
  /** The program's exit code when `status` is `exited`; otherwise `null`. */
  exitCode: number | null;
  /** The captured standard output (Req 18.7). */
  stdout: string;
  /** The captured standard error (Req 18.7). */
  stderr: string;
  /** The files the program produced (Req 18.7). */
  files: GeneratedFile[];
  /** The measured wall-clock duration in milliseconds (Req 18.7). */
  elapsedMs: number;
  /** The measured peak memory usage in bytes (Req 18.7). */
  memoryUsedBytes: number;
}

/**
 * The replaceable isolation backend (Req 18.8).
 *
 * This is the isolation seam: every untrusted execution crosses this port and
 * nothing else. A production backend runs the {@link ContainerSpec} inside a
 * hardened container / microVM / gVisor sandbox with no network, no root, and an
 * ephemeral filesystem; a test backend returns canned results without ever
 * evaluating the code. Because the submission contract ({@link ContainerSpec} in,
 * {@link ContainerResult} out) is fixed, the containerized backend can be swapped
 * for a stronger isolation backend without any change to the Code_Sandbox or its
 * callers (Req 18.8).
 */
export interface SandboxIsolationBackend {
  /**
   * Run a fully-resolved spec under isolation and return its raw outcome.
   *
   * @param spec The isolation-enforced execution spec.
   * @returns The captured outcome (status, exit code, output, files, usage).
   */
  run(spec: ContainerSpec): Promise<ContainerResult>;

  /**
   * Best-effort cancellation of an in-flight execution (Req 18.3).
   *
   * Invoked by the Code_Sandbox's wall-clock watchdog when a backend overruns
   * its deadline, so a misbehaving or hung backend cannot leak a live execution.
   * Optional: a backend that enforces its own hard timeout need not implement it.
   *
   * @param executionId The id of the execution to cancel.
   */
  cancel?(executionId: string): Promise<void>;
}

/**
 * The high-level outcome of a Code_Sandbox execution.
 *
 *  - `completed` — the program ran to completion (inspect {@link SandboxResult.exitCode}
 *    for success vs. a non-zero failure);
 *  - `timeout` — the 30-second wall-clock limit was reached (Req 18.3);
 *  - `memory_limit` — the 512 MB memory limit was reached (Req 18.4).
 */
export type SandboxOutcome = 'completed' | 'timeout' | 'memory_limit';

/**
 * The execution metadata returned with every completed (non-rejected) result
 * (Req 18.7).
 *
 * Beyond the required elapsed time and memory used, it attests the isolation
 * constraints the execution actually ran under, so a caller can verify the
 * sandbox boundary held (Req 18.1, 18.5).
 */
export interface SandboxMetadata {
  /** The runtime the code ran under (Req 18.2). */
  language: SandboxLanguage;
  /** The wall-clock duration in milliseconds (Req 18.7). */
  elapsedMs: number;
  /** The peak memory usage in bytes (Req 18.7). */
  memoryUsedBytes: number;
  /** The network policy the execution ran under — always `none` (Req 18.1). */
  network: NetworkPolicy;
  /** Whether the execution ran without root privileges — always `true` (Req 18.5). */
  rootless: boolean;
  /** Whether the execution's filesystem was ephemeral — always `true` (Req 18.5). */
  ephemeralFilesystem: boolean;
}

/**
 * The structured result of a Code_Sandbox execution (Req 18.3, 18.4, 18.7).
 *
 * Resource-limit breaches are ordinary outcomes here, not thrown errors: a
 * timeout surfaces as `outcome: 'timeout'` / `timedOut: true` (Req 18.3) and a
 * memory breach as `outcome: 'memory_limit'` / `memoryExceeded: true` (Req 18.4),
 * each still carrying whatever output and metadata the backend captured. A
 * completed run carries the program's {@link exitCode} (zero or non-zero). The
 * only failure that is *not* a result is a rejected, never-run execution (an
 * unsupported language or an Allow_List violation), which throws a typed error
 * (Req 18.6).
 */
export interface SandboxResult {
  /** The high-level outcome. */
  outcome: SandboxOutcome;
  /** The program's exit code for a completed run; `null` for a limit breach. */
  exitCode: number | null;
  /** The captured standard output (Req 18.7). */
  stdout: string;
  /** The captured standard error (Req 18.7). */
  stderr: string;
  /** `true` iff the run hit the wall-clock limit (Req 18.3). */
  timedOut: boolean;
  /** `true` iff the run hit the memory limit (Req 18.4). */
  memoryExceeded: boolean;
  /** The files the program produced (Req 18.7). */
  files: GeneratedFile[];
  /** The execution metadata, including elapsed time and memory used (Req 18.7). */
  metadata: SandboxMetadata;
}
