/**
 * Policy_Engine (Req 19.1, 19.2, 19.3, 19.8).
 *
 * The first guard of the fail-closed decision pipeline (design "Fail-Closed
 * Decision Pipeline"). It resolves hierarchical Allow_List policies with
 * **Organization > Team > User** precedence (Req 19.3) and is **default-deny**:
 * a permission is granted only by an explicit `allow` entry and denied whenever
 * no policy resolves (Req 19.2, 19.8).
 *
 * Access_Control (task 3.7) composes this engine, and the precedence (Property
 * 4), role/policy-change application (Property 5), and fail-closed default-deny
 * (Property 2) tests validate it.
 *
 * Surface:
 *   - {@link PolicyEngine} — the service; `resolve(principal, resource, action)`
 *     reads policies fresh per call (no caching, Req 19.7) and returns a
 *     {@link PolicyDecision}.
 *   - {@link decidePolicy} — the pure, deterministic precedence/merge algorithm
 *     the engine and tests build on.
 *   - {@link PolicyRepository} — the tenant-scoped repository over `policies`.
 */

export { PolicyEngine, decidePolicy, type PolicyEngineOptions } from './policy-engine.js';

export { PolicyRepository } from './policy-repository.js';

export {
  POLICY_SCOPE_PRECEDENCE,
  type AllowListEntry,
  type Policy,
  type PolicyDecision,
  type PolicyEffect,
  type PolicyScope,
} from './types.js';
