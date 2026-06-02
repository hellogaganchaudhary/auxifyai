/**
 * Access_Control (Req 1.3, 1.7, 19.4, 19.5, 19.6).
 *
 * The request-path authorization gate that composes the platform's fail-closed
 * guards into a single verdict: membership / cross-tenant check (Req 1.3, 1.7),
 * Allow_List resolution through the Policy_Engine (Req 19.2, 19.4, 19.8), the
 * viewer resource restriction (Req 19.6), and the model-tier gates (Req 19.5,
 * 19.6, 20.6). Every denial is recorded through the injected AuditRecorder port
 * (Req 1.7, 19.4). It denies by default and grants only when every stage passes
 * (Property 2).
 *
 * Surface:
 *   - {@link AccessControl} — the service; `authorize(principal, resource,
 *     action, options?)` returns a structured {@link AuthzDecision}, and
 *     `authorizeOrThrow` throws {@link AccessDeniedError} on a denial.
 *   - {@link PolicyResolver} / {@link AccessControlOptions} — the injected
 *     Policy_Engine port and construction dependencies.
 *   - {@link checkMembership} / {@link checkViewerResource} — the pure stage
 *     helpers, reusable and directly testable.
 *   - {@link checkModelAccess} / {@link isViewer} — the reusable, pure
 *     model-tier gates (also used by the Model_Router, task 6.1).
 *   - {@link AccessDeniedError} — the typed denial raised by `authorizeOrThrow`.
 *   - {@link AuthzDecision}, {@link AuthzDenialCode}, {@link AuthorizeOptions},
 *     {@link ModelAccessResult}, {@link ModelDenialCode} — the decision types.
 */

export {
  AccessControl,
  checkMembership,
  checkViewerResource,
  type AccessControlOptions,
  type PolicyResolver,
} from './access-control.js';

export {
  checkModelAccess,
  isViewer,
  type ModelAccessResult,
  type ModelDenialCode,
} from './model-access.js';

export { AccessDeniedError } from './errors.js';

export type { AuthorizeOptions, AuthzDecision, AuthzDenialCode } from './types.js';
