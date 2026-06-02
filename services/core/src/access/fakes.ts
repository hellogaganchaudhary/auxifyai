/**
 * Test fakes and builders for Access_Control.
 *
 * Access_Control depends on two injected ports — a {@link PolicyResolver}
 * (the Policy_Engine) and an {@link AuditRecorder} (the Audit_Service). These
 * fakes let unit and property tests drive `authorize` deterministically and
 * inspect what was audited, without a database:
 *
 *   - {@link FakePolicyResolver} returns a fixed allow/deny decision (or one
 *     computed from a supplied function), so a test can isolate any single
 *     stage of the pipeline.
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` pair so a test
 *     can assert that exactly the denials were audited (Req 1.7, 19.4 /
 *     Property 3) and inspect the captured metadata.
 *   - {@link makePrincipal}, {@link makeResource}, {@link makeModel} are small
 *     builders with sensible defaults that each test overrides field-by-field.
 *
 * The fakes are exported (not test-only) so the concurrent property tests
 * (tasks 3.8) can reuse exactly the same doubles Access_Control was unit-tested
 * against.
 */

import type {
  Action,
  ModelInfo,
  ModelTier,
  Principal,
  ResourceRef,
  TenantContext,
} from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type { PolicyDecision } from '../policy/index.js';
import type { PolicyResolver } from './access-control.js';

/**
 * A {@link PolicyResolver} that returns a configurable decision.
 *
 * By default it grants (so tests exercising later stages are not blocked by the
 * policy stage). Pass a fixed {@link PolicyDecision}, or a function computing
 * one per `(principal, resource, action)`, to model the Policy_Engine's verdict.
 * Every resolution is captured in {@link calls} for assertions.
 */
export class FakePolicyResolver implements PolicyResolver {
  /** Every `resolve` invocation, in order. */
  readonly calls: Array<{ principal: Principal; resource: ResourceRef; action: Action }> = [];

  constructor(
    private readonly decide:
      | PolicyDecision
      | ((principal: Principal, resource: ResourceRef, action: Action) => PolicyDecision) = {
      allowed: true,
      reason: 'fake: granted',
      decidingScope: 'org',
    },
  ) {}

  async resolve(
    principal: Principal,
    resource: ResourceRef,
    action: Action,
  ): Promise<PolicyDecision> {
    this.calls.push({ principal, resource, action });
    return typeof this.decide === 'function'
      ? this.decide(principal, resource, action)
      : this.decide;
  }
}

/** Convenience: a resolver that always denies with the default-deny shape. */
export function denyingPolicyResolver(): FakePolicyResolver {
  return new FakePolicyResolver({
    allowed: false,
    reason: 'default-deny: no Allow_List grants the action',
    decidingScope: null,
  });
}

/** Convenience: a resolver that always grants. */
export function grantingPolicyResolver(): FakePolicyResolver {
  return new FakePolicyResolver({
    allowed: true,
    reason: 'fake: granted',
    decidingScope: 'org',
  });
}

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} that stores every recorded event so tests
 * can assert which denials were audited (Req 1.7, 19.4).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    // Defensive copies so later mutation by callers cannot rewrite the trail.
    this.recorded.push({ ctx: { ...ctx }, event: { ...event, metadata: { ...event.metadata } } });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `access.denied`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }
}

/** Build a {@link Principal} with sensible defaults; override field-by-field. */
export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    roles: ['standard_user'],
    teamIds: ['team-1'],
    projectIds: ['project-1'],
    allowedModels: [],
    premiumAuthorized: false,
    ...overrides,
  };
}

/** Build a {@link ResourceRef} with sensible defaults; override field-by-field. */
export function makeResource(overrides: Partial<ResourceRef> = {}): ResourceRef {
  return {
    type: 'conversation',
    id: 'conv-1',
    organizationId: 'org-1',
    ...overrides,
  };
}

/** Build a {@link ModelInfo} of the given tier with sensible defaults. */
export function makeModel(tier: ModelTier, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: `model-${tier}`,
    provider: 'azure',
    providerModelId: `provider-${tier}`,
    displayName: `Model ${tier}`,
    modality: 'chat',
    tier,
    maxTokens: 128_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: tier === 'premium',
    cost: { per1kInputTokens: 1, per1kOutputTokens: 2 },
    available: true,
    ...overrides,
  };
}
