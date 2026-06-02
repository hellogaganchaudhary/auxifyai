/**
 * Test fakes and builders for the Billing_Guard.
 *
 * The Billing_Guard depends on two injected ports — a
 * {@link BillingStatusProvider} (the billing-compliance registry) and an
 * {@link AuditRecorder} (the Audit_Service). These fakes let unit and property
 * tests drive `verify` deterministically and inspect what was audited, without
 * any external service:
 *
 *   - {@link FakeBillingStatusProvider} returns a per-dependency
 *     {@link BillingComplianceStatus} from a configurable map (defaulting to an
 *     `undefined`, i.e. "unknown", status), and can be told to throw to exercise
 *     the fail-closed `verification_unavailable` path.
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` pair so a test
 *     can assert that exactly the blocks were audited (Req 37.1 / Property 3) and
 *     inspect the captured metadata.
 *   - {@link makeDependency} is a small builder with sensible defaults that each
 *     test overrides field-by-field.
 *
 * The fakes are exported (not test-only) so the concurrent property test
 * (task 19.8) can reuse exactly the same doubles the guard was unit-tested
 * against.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type { BillingStatusProvider } from './billing-guard.js';
import type { BillableDependency, BillingComplianceStatus } from './types.js';

/**
 * A {@link BillingStatusProvider} that returns a configurable per-dependency
 * status.
 *
 * Statuses are looked up by dependency id from {@link statuses}; an id with no
 * entry resolves to `undefined` (an "unknown" status), exercising the guard's
 * fail-closed `verification_unavailable` path by default. Set {@link throwError}
 * to make `getStatus` reject, modelling a registry that is itself unavailable.
 * Every call is captured in {@link calls} for assertions.
 */
export class FakeBillingStatusProvider implements BillingStatusProvider {
  /** Per-dependency-id compliance statuses; a missing id resolves to `undefined`. */
  readonly statuses: Map<string, BillingComplianceStatus>;
  /** When set, `getStatus` rejects with this error (models an unavailable registry). */
  throwError: Error | undefined;
  /** Every `getStatus` invocation, in order, by dependency id. */
  readonly calls: string[] = [];

  constructor(
    statuses: Record<string, BillingComplianceStatus> = {},
    throwError?: Error,
  ) {
    this.statuses = new Map(Object.entries(statuses));
    this.throwError = throwError;
  }

  async getStatus(dependency: BillableDependency): Promise<BillingComplianceStatus | undefined> {
    this.calls.push(dependency.id);
    if (this.throwError !== undefined) {
      throw this.throwError;
    }
    return this.statuses.get(dependency.id);
  }

  /** Set or replace the status for a dependency id; returns `this` for chaining. */
  set(dependencyId: string, status: BillingComplianceStatus): this {
    this.statuses.set(dependencyId, status);
    return this;
  }
}

/** Convenience: a provider that reports a verified AWS/Azure credit-billable status for every id. */
export function verifiedStatusProvider(
  creditProvider: BillingComplianceStatus['creditProvider'] = 'aws',
): FakeBillingStatusProvider {
  return new (class extends FakeBillingStatusProvider {
    override async getStatus(
      dependency: BillableDependency,
    ): Promise<BillingComplianceStatus | undefined> {
      this.calls.push(dependency.id);
      return { creditBillable: true, creditProvider, verifiable: true };
    }
  })();
}

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} that stores every recorded event so tests
 * can assert which blocks were audited (Req 37.1).
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

  /** Every recorded event with the given action (e.g. `billing.blocked`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }
}

/** Build a {@link BillableDependency} with sensible defaults; override field-by-field. */
export function makeDependency(overrides: Partial<BillableDependency> = {}): BillableDependency {
  return {
    id: 'dep-1',
    name: 'Dependency 1',
    category: 'ai_model',
    organizationId: 'org-1',
    ...overrides,
  };
}
