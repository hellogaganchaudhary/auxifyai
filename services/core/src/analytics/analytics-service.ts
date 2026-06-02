/**
 * The Analytics_Service (Req 31.1-31.8).
 *
 * Records a granular per-request metric when a billable or trackable request
 * completes (Req 31.1), records agent-run (Req 31.5) and RAG (Req 31.6) metrics,
 * and aggregates them into the dashboard's usage (Req 31.2), cost (Req 31.3),
 * performance (Req 31.4), agent (Req 31.5), and RAG (Req 31.6) reports over an
 * authorized, time-bounded view — restricting every query to the Organization,
 * Teams, and Projects the administrator is authorized to see (Req 31.7) — and
 * purges granular data once its 90-day retention window has elapsed while
 * aggregated data is retained for 2 years (Req 31.8).
 *
 * It is the AGGREGATION / QUERY layer over the request outcomes the Model_Router
 * already records (selected model, latency, tokens, cost — Req 3.9); it never
 * re-routes or re-prices a request.
 *
 * It is pure orchestration over a handful of injectable ports — the
 * {@link MetricStore} (append, period-filtered reads, and the retention seam),
 * the optional {@link ScopeAuthorizer} (the authorized {@link AnalyticsScope},
 * Req 31.7), the optional shared {@link import('../audit/index.js').AuditRecorder}
 * (denied queries and retention purges are recorded, Req 37.1), and an
 * {@link AnalyticsClock} (so retention is timed deterministically) — so it is
 * fully unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * The aggregation arithmetic itself lives in the pure helpers in
 * `./aggregation.js`; this service only resolves the authorized scope,
 * period-filters and scope-restricts the records, and applies those helpers.
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import {
  summarizeAgentRuns,
  summarizeCost,
  summarizePerformance,
  summarizeRag,
  summarizeUsage,
} from './aggregation.js';
import { UnauthorizedAnalyticsScopeError } from './errors.js';
import {
  GRANULAR_RETENTION_DAYS,
  MS_PER_DAY,
  systemAnalyticsClock,
  type AgentRunMetric,
  type AgentSummary,
  type AnalyticsClock,
  type AnalyticsPeriod,
  type AnalyticsQueryOptions,
  type AnalyticsScope,
  type AnalyticsViewer,
  type CostBreakdown,
  type MetricStore,
  type PerformanceSummary,
  type RagMetric,
  type RagSummary,
  type RequestMetric,
  type ScopeAuthorizer,
  type ScopeNarrowing,
  type UsageSummary,
} from './types.js';

/** Generates unique metric ids (injectable for deterministic tests). */
export interface AnalyticsIdGenerator {
  /** A unique metric id. */
  metricId(): string;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: AnalyticsIdGenerator = {
  metricId: () => randomUUID(),
};

/**
 * The granular per-request data to record (Req 31.1).
 *
 * The {@link AnalyticsService.recordRequest} method stamps the `id`,
 * `organizationId` (from the caller's {@link TenantContext}), and `recordedAt`,
 * so a caller supplies only the measured dimensions. `userId` / `teamId` /
 * `projectId` default to the context's when omitted; `id` / `recordedAt` may be
 * supplied for deterministic tests.
 */
export type RecordRequestInput = Omit<
  RequestMetric,
  'id' | 'organizationId' | 'recordedAt' | 'userId' | 'teamId' | 'projectId'
> & {
  /** The user who made the request; defaults to `ctx.userId`. */
  userId?: string;
  /** The owning Team; defaults to `ctx.teamId`. */
  teamId?: string;
  /** The owning Project; defaults to `ctx.projectId`. */
  projectId?: string;
  /** An explicit id (defaults to a generated id). */
  id?: string;
  /** An explicit ISO-8601 recorded instant (defaults to the clock's "now"). */
  recordedAt?: string;
};

/** The granular per-agent-run data to record (Req 31.5). */
export type RecordAgentRunInput = Omit<
  AgentRunMetric,
  'id' | 'organizationId' | 'recordedAt' | 'userId' | 'teamId' | 'projectId'
> & {
  userId?: string;
  teamId?: string;
  projectId?: string;
  id?: string;
  recordedAt?: string;
};

/** The granular RAG-retrieval data to record (Req 31.6). */
export type RecordRagInput = Omit<
  RagMetric,
  'id' | 'organizationId' | 'recordedAt' | 'userId' | 'teamId' | 'projectId'
> & {
  userId?: string;
  teamId?: string;
  projectId?: string;
  id?: string;
  recordedAt?: string;
};

/**
 * The outcome of a {@link AnalyticsService.purgeExpired} call (Req 31.8).
 *
 * The number of granular records of each kind whose 90-day retention window had
 * elapsed and were removed.
 */
export interface PurgeReport {
  /** Removed {@link RequestMetric} count. */
  requests: number;
  /** Removed {@link AgentRunMetric} count. */
  agentRuns: number;
  /** Removed {@link RagMetric} count. */
  rag: number;
}

/** Construction options for the {@link AnalyticsService}. */
export interface AnalyticsServiceOptions {
  /** The granular metric store (append + period-filtered reads + retention seam). */
  metrics: MetricStore;
  /**
   * Resolves the authorized {@link AnalyticsScope} for a viewer (Req 31.7). When
   * omitted, a viewer's authorized scope defaults to their whole Organization.
   */
  scopeAuthorizer?: ScopeAuthorizer;
  /** Optional audit sink; denied queries and retention purges are recorded (Req 37.1). */
  audit?: AuditRecorder;
  /** Optional clock for "now" (defaults to {@link systemAnalyticsClock}). */
  clock?: AnalyticsClock;
  /**
   * The granular retention window in days (Req 31.8); defaults to
   * {@link GRANULAR_RETENTION_DAYS} (90). Aggregated data is retained 2 years.
   */
  granularRetentionDays?: number;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: AnalyticsIdGenerator;
}

/**
 * The Analytics_Service: records granular per-request / agent / RAG metrics and
 * reports scope-restricted, period-bounded aggregations over them
 * (Req 31.1-31.8).
 */
export class AnalyticsService {
  private readonly metrics: MetricStore;
  private readonly scopeAuthorizer: ScopeAuthorizer | undefined;
  private readonly audit: AuditRecorder | undefined;
  private readonly clock: AnalyticsClock;
  private readonly granularRetentionDays: number;
  private readonly ids: AnalyticsIdGenerator;

  constructor(options: AnalyticsServiceOptions) {
    this.metrics = options.metrics;
    this.scopeAuthorizer = options.scopeAuthorizer;
    this.audit = options.audit;
    this.clock = options.clock ?? systemAnalyticsClock;
    this.granularRetentionDays = options.granularRetentionDays ?? GRANULAR_RETENTION_DAYS;
    this.ids = options.idGenerator ?? defaultIdGenerator;
  }

  // --- recording (Req 31.1, 31.5, 31.6) ---------------------------------

  /**
   * Record a granular per-request metric when a billable or trackable request
   * completes (Req 31.1).
   *
   * Captures the model, provider, input/output tokens, cost, latency, request
   * type, and tool-call count — plus the optional time-to-first-token and error
   * flag — stamping the id, the Organization (from `ctx`), and the recorded
   * instant. The Team / Project / user default to the context's when omitted.
   *
   * @param ctx The tenant scope the request belonged to.
   * @param input The measured request dimensions.
   * @returns The persisted {@link RequestMetric}.
   */
  async recordRequest(ctx: TenantContext, input: RecordRequestInput): Promise<RequestMetric> {
    const metric: RequestMetric = {
      id: input.id ?? this.ids.metricId(),
      organizationId: ctx.organizationId,
      userId: input.userId ?? ctx.userId,
      model: input.model,
      provider: input.provider,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costUsd: input.costUsd,
      latencyMs: input.latencyMs,
      requestType: input.requestType,
      toolCallCount: input.toolCallCount,
      recordedAt: input.recordedAt ?? this.nowIso(),
    };
    const teamId = input.teamId ?? ctx.teamId;
    if (teamId !== undefined) {
      metric.teamId = teamId;
    }
    const projectId = input.projectId ?? ctx.projectId;
    if (projectId !== undefined) {
      metric.projectId = projectId;
    }
    if (input.timeToFirstTokenMs !== undefined) {
      metric.timeToFirstTokenMs = input.timeToFirstTokenMs;
    }
    if (input.error !== undefined) {
      metric.error = input.error;
    }
    await this.metrics.appendRequest(metric);
    return metric;
  }

  /**
   * Record a granular per-agent-run metric when a run finishes (Req 31.5).
   *
   * @param ctx The tenant scope the run belonged to.
   * @param input The run's id, step count, success flag, and cost.
   * @returns The persisted {@link AgentRunMetric}.
   */
  async recordAgentRun(ctx: TenantContext, input: RecordAgentRunInput): Promise<AgentRunMetric> {
    const metric: AgentRunMetric = {
      id: input.id ?? this.ids.metricId(),
      organizationId: ctx.organizationId,
      userId: input.userId ?? ctx.userId,
      runId: input.runId,
      steps: input.steps,
      success: input.success,
      costUsd: input.costUsd,
      recordedAt: input.recordedAt ?? this.nowIso(),
    };
    const teamId = input.teamId ?? ctx.teamId;
    if (teamId !== undefined) {
      metric.teamId = teamId;
    }
    const projectId = input.projectId ?? ctx.projectId;
    if (projectId !== undefined) {
      metric.projectId = projectId;
    }
    await this.metrics.appendAgentRun(metric);
    return metric;
  }

  /**
   * Record a granular RAG-retrieval metric (Req 31.6).
   *
   * @param ctx The tenant scope the retrieval belonged to.
   * @param input The retrieval's relevance score and source-attribution flag.
   * @returns The persisted {@link RagMetric}.
   */
  async recordRag(ctx: TenantContext, input: RecordRagInput): Promise<RagMetric> {
    const metric: RagMetric = {
      id: input.id ?? this.ids.metricId(),
      organizationId: ctx.organizationId,
      userId: input.userId ?? ctx.userId,
      relevanceScore: input.relevanceScore,
      sourceAttributed: input.sourceAttributed,
      recordedAt: input.recordedAt ?? this.nowIso(),
    };
    const teamId = input.teamId ?? ctx.teamId;
    if (teamId !== undefined) {
      metric.teamId = teamId;
    }
    const projectId = input.projectId ?? ctx.projectId;
    if (projectId !== undefined) {
      metric.projectId = projectId;
    }
    await this.metrics.appendRag(metric);
    return metric;
  }

  // --- aggregated queries (Req 31.2-31.7) -------------------------------

  /**
   * The aggregated usage metrics — total requests, tokens, cost, and active
   * users — for the selected period within the viewer's authorized scope
   * (Req 31.2, 31.7).
   */
  async usageSummary(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<UsageSummary> {
    const records = await this.scopedRequests(viewer, period, options.scope);
    return summarizeUsage(records);
  }

  /**
   * The cost report grouped by model, Team, Project, and user for the selected
   * period within the viewer's authorized scope (Req 31.3, 31.7).
   */
  async costBreakdown(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<CostBreakdown> {
    const records = await this.scopedRequests(viewer, period, options.scope);
    return summarizeCost(records);
  }

  /**
   * The performance report — p50/p95/p99 latency, average time-to-first-token,
   * and error rate — for the selected period within the viewer's authorized
   * scope (Req 31.4, 31.7).
   */
  async performance(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<PerformanceSummary> {
    const records = await this.scopedRequests(viewer, period, options.scope);
    return summarizePerformance(records);
  }

  /**
   * The agent report — run count, average steps per run, success rate, and
   * average cost per run — for the selected period within the viewer's
   * authorized scope (Req 31.5, 31.7).
   */
  async agentMetrics(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<AgentSummary> {
    const scope = await this.resolveScope(viewer, options.scope);
    const all = await this.metrics.queryAgentRuns({
      organizationId: scope.organizationId,
      period,
    });
    return summarizeAgentRuns(all.filter((m) => inScope(m, scope)));
  }

  /**
   * The RAG report — average retrieval relevance and source-attribution rate —
   * for the selected period within the viewer's authorized scope (Req 31.6,
   * 31.7).
   */
  async ragMetrics(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<RagSummary> {
    const scope = await this.resolveScope(viewer, options.scope);
    const all = await this.metrics.queryRag({ organizationId: scope.organizationId, period });
    return summarizeRag(all.filter((m) => inScope(m, scope)));
  }

  // --- retention (Req 31.8) ---------------------------------------------

  /**
   * Purge granular records whose 90-day retention window has elapsed (Req 31.8).
   *
   * A granular {@link RequestMetric} / {@link AgentRunMetric} / {@link RagMetric}
   * recorded strictly before `now - 90 days` is removed; one recorded within the
   * window is retained. Aggregated rollups are NOT purged here — they are
   * retained for 2 years (see {@link import('./types.js').AGGREGATED_RETENTION_DAYS}),
   * and the {@link import('./types.js').GRANULAR_RETENTION_DAYS} window governs
   * only the granular purge. The purge is recorded through the audit sink when
   * one is configured (Req 37.1).
   *
   * @param now Optional override for "now" (epoch ms); defaults to the clock.
   * @returns The number of records of each kind that were purged.
   */
  async purgeExpired(now?: number): Promise<PurgeReport> {
    const nowMs = now ?? this.clock.now();
    const cutoffMs = nowMs - this.granularRetentionDays * MS_PER_DAY;
    const [requests, agentRuns, rag] = await Promise.all([
      this.metrics.purgeRequestsBefore(cutoffMs),
      this.metrics.purgeAgentRunsBefore(cutoffMs),
      this.metrics.purgeRagBefore(cutoffMs),
    ]);
    const report: PurgeReport = { requests, agentRuns, rag };
    if (this.audit !== undefined && requests + agentRuns + rag > 0) {
      await this.audit.record(
        { organizationId: 'platform', userId: 'system' },
        {
          action: 'analytics.retention_purge',
          resourceType: 'usage_record',
          resourceId: 'analytics',
          timestamp: new Date(nowMs).toISOString(),
          metadata: {
            cutoff: new Date(cutoffMs).toISOString(),
            requests,
            agentRuns,
            rag,
          },
        },
      );
    }
    return report;
  }

  // --- internals --------------------------------------------------------

  /** Resolve, period-filter, and scope-restrict the request records for a query (Req 31.7). */
  private async scopedRequests(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    narrowing: ScopeNarrowing | undefined,
  ): Promise<RequestMetric[]> {
    const scope = await this.resolveScope(viewer, narrowing);
    const all = await this.metrics.queryRequests({
      organizationId: scope.organizationId,
      period,
    });
    return all.filter((m) => inScope(m, scope));
  }

  /**
   * Resolve the viewer's authorized scope and intersect it with an optional
   * requested narrowing, failing closed if the narrowing names an unauthorized
   * Team or Project (Req 31.7).
   */
  private async resolveScope(
    viewer: AnalyticsViewer,
    narrowing: ScopeNarrowing | undefined,
  ): Promise<AnalyticsScope> {
    const authorized =
      this.scopeAuthorizer !== undefined
        ? await this.scopeAuthorizer.authorizedScope(viewer)
        : { organizationId: viewer.organizationId };

    if (narrowing === undefined) {
      return authorized;
    }

    const effective: AnalyticsScope = { organizationId: authorized.organizationId };

    if (narrowing.teamIds !== undefined) {
      for (const teamId of narrowing.teamIds) {
        if (!isAuthorized(authorized.teamIds, teamId)) {
          await this.recordDenied(viewer, 'team', teamId);
          throw new UnauthorizedAnalyticsScopeError('team', teamId);
        }
      }
      effective.teamIds = [...narrowing.teamIds];
    } else if (authorized.teamIds !== undefined) {
      effective.teamIds = [...authorized.teamIds];
    }

    if (narrowing.projectIds !== undefined) {
      for (const projectId of narrowing.projectIds) {
        if (!isAuthorized(authorized.projectIds, projectId)) {
          await this.recordDenied(viewer, 'project', projectId);
          throw new UnauthorizedAnalyticsScopeError('project', projectId);
        }
      }
      effective.projectIds = [...narrowing.projectIds];
    } else if (authorized.projectIds !== undefined) {
      effective.projectIds = [...authorized.projectIds];
    }

    return effective;
  }

  /** Record a denied out-of-scope query through the audit sink, when configured (Req 37.1). */
  private async recordDenied(
    viewer: AnalyticsViewer,
    dimension: 'team' | 'project',
    requestedId: string,
  ): Promise<void> {
    if (this.audit === undefined) {
      return;
    }
    await this.audit.record(
      { organizationId: viewer.organizationId, userId: viewer.userId },
      {
        action: 'analytics.scope_denied',
        resourceType: dimension === 'team' ? 'team' : 'project',
        resourceId: requestedId,
        timestamp: this.nowIso(),
        metadata: { dimension },
      },
    );
  }

  /** The clock's current instant as an ISO-8601 string. */
  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

/** Whether `id` is permitted by an authorized id list (`undefined` ⇒ all permitted). */
function isAuthorized(authorizedIds: readonly string[] | undefined, id: string): boolean {
  return authorizedIds === undefined || authorizedIds.includes(id);
}

/**
 * Whether a scoped record falls within an {@link AnalyticsScope} (Req 31.7).
 *
 * The record must be in the scope's Organization; if the scope restricts Teams,
 * the record's Team must be one of them (a record with no Team is excluded —
 * fail-closed); likewise for Projects.
 */
function inScope(
  record: { organizationId: string; teamId?: string; projectId?: string },
  scope: AnalyticsScope,
): boolean {
  if (record.organizationId !== scope.organizationId) {
    return false;
  }
  if (scope.teamIds !== undefined) {
    if (record.teamId === undefined || !scope.teamIds.includes(record.teamId)) {
      return false;
    }
  }
  if (scope.projectIds !== undefined) {
    if (record.projectId === undefined || !scope.projectIds.includes(record.projectId)) {
      return false;
    }
  }
  return true;
}
