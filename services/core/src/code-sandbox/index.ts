/**
 * Code_Sandbox (Req 18.1-18.8): isolated execution of untrusted, agent- or
 * user-submitted code behind a replaceable isolation backend.
 *
 * {@link CodeSandbox.execute} accepts a {@link SandboxExecRequest} (language,
 * source, stdin, optional Allow_List, optional lowered limits) and returns a
 * structured {@link SandboxResult} (stdout, stderr, exit code, `timedOut` /
 * `memoryExceeded` flags, generated files, and metadata carrying elapsed time
 * and memory used, Req 18.7). It supports Python 3.12, Node.js 22, shell, and
 * read-only SQL (Req 18.2), rejecting any other runtime with an
 * {@link UnsupportedLanguageError}.
 *
 * The isolation boundary is modelled explicitly as the narrow injectable
 * {@link SandboxIsolationBackend} port (Req 18.8): the Code_Sandbox fixes the
 * isolation policy in code — no network egress (Req 18.1), non-root execution
 * and an ephemeral filesystem (Req 18.5), and the clamped 30 s / 512 MB ceilings
 * (Req 18.3, 18.4) — and hands a fully-resolved {@link ContainerSpec} to the
 * backend, which alone runs the code under hard isolation. The production backend
 * (a gVisor-hardened container, a microVM, …) is the deployment's responsibility
 * and can be swapped for a stronger one without changing the submission contract.
 *
 * Before any code runs, the Allow_List import preflight ({@link extractImports})
 * rejects a program that imports a non-allow-listed package with an
 * {@link UnauthorizedPackageError} (Req 18.6, Property 39). A wall-clock watchdog
 * guards against a backend that overruns its own deadline (Req 18.3). Resource-
 * limit breaches are ordinary typed outcomes, never thrown errors; only a
 * never-run rejection throws.
 *
 * Because the only impure dependency is the isolation port, the orchestration is
 * fully unit-testable with the deterministic {@link FakeIsolationBackend} in
 * `./fakes.js`, which never evaluates the submitted code.
 */

export {
  CodeSandbox,
  SANDBOX_TIMEOUT_MS,
  SANDBOX_MEMORY_BYTES,
  SANDBOX_WATCHDOG_GRACE_MS,
  type CodeSandboxOptions,
  type ExecutionIdGenerator,
  type WatchdogTimer,
} from './code-sandbox.js';

export { extractImports } from './imports.js';

export {
  UnsupportedLanguageError,
  UnauthorizedPackageError,
  UNSUPPORTED_LANGUAGE_CODE,
  UNAUTHORIZED_PACKAGE_CODE,
} from './errors.js';

export {
  SUPPORTED_LANGUAGES,
  type SandboxLanguage,
  type NetworkPolicy,
  type ResourceLimits,
  type SandboxExecRequest,
  type GeneratedFile,
  type ContainerStatus,
  type ContainerSpec,
  type ContainerResult,
  type SandboxIsolationBackend,
  type SandboxOutcome,
  type SandboxMetadata,
  type SandboxResult,
} from './types.js';
