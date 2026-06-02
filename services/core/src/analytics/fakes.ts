/**
 * Test fakes and builders for the Analytics_Service (Req 31.1-31.8).
 *
 * The Analytics_Service composes its ports — a {@link MetricStore}, an optional
 * {@link ScopeAuthorizer}, the shared {@link AuditRecorder}, and an
 * {@link AnalyticsClock}. These in-memory fakes let unit tests drive the service
 * deterministically and inspect what was recorded, aggregated, scope-restricted,
 * and aged out — without a database, a clock, or a network:
 *
 *   - {@link InMemoryMetricStore} keeps the three granular record kinds in
 *     plain arrays, filtering reads to the queried Organization and period and
 *     deleting records before a cutoff on purge (the retention seam, Req 31.8);
 *   - {@link FixedScopeAuthorizer} returns a per-viewer fixed
 *     {@link AnalyticsScope} so a test can model an Org-wide or a Team/Project-
 *     scoped administrator (Req 31.7);
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert which denials / purges were audited (Req 37.1);
 *   - {@link MutableAnalyticsClock} is a hand-advanceable clock so retention is
 *     fully testable;
 *   - {@link makeTenantContext} / {@link makeRequestMetric} /
 *     {@link makeAgentRunMetric} / {@link makeRagMetric} /
 *     {@link sequentialAnalyticsIdGenerator} are small builders with defaults.
 *
 * These are imported directly from `./fakes.js` by the tests (never from the
 * package barrel), matching the established convention.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type { AnalyticsIdGenerator } from './analytics-service.js';
import type {
  AgentRunMetric,
  AnalyticsClock,
  AnalyticsScope,
  AnalyticsViewer,
  MetricQuery,
  MetricStore,
  RagMetric,
  RequestMetric,
  ScopeAuthorizer,
} from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  /** The tenant context the event was scoped to. */
  ctx: TenantContext;
  /** The recorded event. */
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which analytics actions were audited (Req 37.1).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({
      ctx: { ...ctx },
      event: { ...event, metadata: { ...(event.metadata ?? {}) } },
    });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `analytics.retention_purge`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }
}

/**
 * A hand-advanceable {@link AnalyticsClock}: fix "now" at construction, then
 * {@link advance} it across a record's 90-day retention deadline (or {@link set}
 * an absolute instant).
 */
export class MutableAnalyticsClock implements AnalyticsClock {
  private current: number;

  /** @param startMs The initial "now" in epoch milliseconds (default 2026-01-01T00:00:00Z). */
  constructor(startMs: number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.current = startMs;
  }

  /** The current time in milliseconds since the Unix epoch. */
  now(): number {
    return this.current;
  }

  /** Advance the clock by `deltaMs` milliseconds. */
  advance(deltaMs: number): void {
    this.current += deltaMs;
  }

  /** Set the clock to an absolute epoch-millisecond instant. */
  set(absoluteMs: number): void {
    this.current = absoluteMs;
  }
}

/** Whether a record's recorded instant falls within a query's period (inclusive). */
function inPeriod(recordedAt: string, query: MetricQuery): boolean {
  const at = Date.parse(recordedAt);
  return at >= query.period.fromMs && at <= query.period.toMs;
}

/**
 * An in-memory {@link MetricStore} keeping the three granular record kinds in
 * plain arrays.
 *
 * Reads filter to the queried Organization and period; purges delete records
 * recorded strictly before the cutoff (the retention seam, Req 31.8) and return
 * the count removed. Records are cloned in and out so a test never mutates the
 * store's state through a returned reference.
 */
export class InMemoryMetricStore implements MetricStore {
  private readonly requests: RequestMetric[] = [];
  private readonly agentRuns: AgentRunMetric[] = [];
  private readonly rag: RagMetric[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async appendRequest(metric: RequestMetric): Promise<void> {
    this.requests.push({ ...metric });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async appendAgentRun(metric: AgentRunMetric): Promise<void> {
    this.agentRuns.push({ ...metric });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async appendRag(metric: RagMetric): Promise<void> {
    this.rag.push({ ...metric });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async queryRequests(query: MetricQuery): Promise<RequestMetric[]> {
    return this.requests
      .filter((m) => m.organizationId === query.organizationId && inPeriod(m.recordedAt, query))
      .map((m) => ({ ...m }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async queryAgentRuns(query: MetricQuery): Promise<AgentRunMetric[]> {
    return this.agentRuns
      .filter((m) => m.organizationId === query.organizationId && inPeriod(m.recordedAt, query))
      .map((m) => ({ ...m }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async queryRag(query: MetricQuery): Promise<RagMetric[]> {
    return this.rag
      .filter((m) => m.organizationId === query.organizationId && inPeriod(m.recordedAt, query))
      .map((m) => ({ ...m }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async purgeRequestsBefore(cutoffMs: number): Promise<number> {
    return purgeBefore(this.requests, cutoffMs);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async purgeAgentRunsBefore(cutoffMs: number): Promise<number> {
    return purgeBefore(this.agentRuns, cutoffMs);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async purgeRagBefore(cutoffMs: number): Promise<number> {
    return purgeBefore(this.rag, cutoffMs);
  }

  /** The total number of granular records held across every kind (test inspection). */
  get totalCount(): number {
    return this.requests.length + this.agentRuns.length + this.rag.length;
  }
}

/** Remove records recorded strictly before `cutoffMs` in place; return the count removed. */
function purgeBefore(records: { recordedAt: string }[], cutoffMs: number): number {
  let removed = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const entry = records[i];
    if (entry !== undefined && Date.parse(entry.recordedAt) < cutoffMs) {
      records.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

/**
 * A {@link ScopeAuthorizer} that returns a fixed {@link AnalyticsScope} per
 * viewer, so a test can model an Organization-wide or a Team/Project-scoped
 * administrator (Req 31.7).
 *
 * A viewer with no configured scope authorizes their whole Organization.
 */
export class FixedScopeAuthorizer implements ScopeAuthorizer {
  private readonly scopes = new Map<string, AnalyticsScope>();

  /** Configure the authorized scope a viewer (by user id) resolves to. */
  setScope(userId: string, scope: AnalyticsScope): this {
    this.scopes.set(userId, scope);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async authorizedScope(viewer: AnalyticsViewer): Promise<AnalyticsScope> {
    return this.scopes.get(viewer.userId) ?? { organizationId: viewer.organizationId };
  }
}

/** Build a {@link TenantContext} with sensible defaults; override field-by-field. */
export function makeTenantContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    ...overrides,
  };
}

/** Build an {@link AnalyticsViewer} with sensible defaults; override field-by-field. */
export function makeViewer(overrides: Partial<AnalyticsViewer> = {}): AnalyticsViewer {
  return {
    userId: 'admin-1',
    organizationId: 'org-1',
    ...overrides,
  };
}

/** Build a {@link RequestMetric} with sensible defaults; override field-by-field. */
export function makeRequestMetric(overrides: Partial<RequestMetric> = {}): RequestMetric {
  return {
    id: 'req-1',
    organizationId: 'org-1',
    userId: 'user-1',
    model: 'gpt-economy',
    provider: 'openai',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.01,
    latencyMs: 200,
    requestType: 'chat',
    toolCallCount: 0,
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
    ...overrides,
  };
}

/** Build an {@link AgentRunMetric} with sensible defaults; override field-by-field. */
export function makeAgentRunMetric(overrides: Partial<AgentRunMetric> = {}): AgentRunMetric {
  return {
    id: 'run-1',
    organizationId: 'org-1',
    userId: 'user-1',
    runId: 'agent-run-1',
    steps: 3,
    success: true,
    costUsd: 0.05,
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
    ...overrides,
  };
}

/** Build a {@link RagMetric} with sensible defaults; override field-by-field. */
export function makeRagMetric(overrides: Partial<RagMetric> = {}): RagMetric {
  return {
    id: 'rag-1',
    organizationId: 'org-1',
    userId: 'user-1',
    relevanceScore: 0.8,
    sourceAttributed: true,
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
    ...overrides,
  };
}

/**
 * A deterministic {@link AnalyticsIdGenerator} handing out `metric-1`,
 * `metric-2`, … ids, for assertion-friendly tests.
 */
export function sequentialAnalyticsIdGenerator(): AnalyticsIdGenerator {
  let counter = 0;
  return {
    metricId: () => `metric-${(counter += 1)}`,
  };
}
