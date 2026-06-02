/**
 * Analytics_Service domain types and injectable ports (Req 31.1-31.8).
 *
 * The Analytics_Service is the AGGREGATION and QUERY layer over the request
 * outcomes the platform already records — the Model_Router records the selected
 * model, latency, tokens, and cost of every routed request (Req 3.9), and this
 * service captures those (plus the request type and tool-call count, Req 31.1)
 * as granular per-request {@link RequestMetric} records, then reports aggregated
 * usage, cost, performance, agent, and RAG metrics over an authorized,
 * time-bounded view (Req 31.2-31.6). It never re-routes or re-prices a request;
 * it only records and aggregates.
 *
 * Everything the service cannot do purely is a narrow injectable port so it
 * stays pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`:
 *
 *   - the tenant/scope/time-filtered {@link MetricStore} — where granular
 *     {@link RequestMetric} / {@link AgentRunMetric} / {@link RagMetric} records
 *     are appended and read back for an Organization over an
 *     {@link AnalyticsPeriod}, and aged out under the retention policy
 *     (the retention seam, Req 31.8);
 *   - the {@link ScopeAuthorizer} — resolves the Organization, Teams, and
 *     Projects an {@link AnalyticsViewer} is authorized to view, so a query can
 *     never return data outside that scope (Req 31.7);
 *   - the shared {@link import('../audit/index.js').AuditRecorder} — every
 *     retention purge and every denied out-of-scope query is recorded (Req 37.1);
 *   - an {@link AnalyticsClock} — so "now" (and therefore the 90-day retention
 *     window) is deterministic in tests.
 *
 * Tenancy: every granular record carries its `organizationId`; the
 * {@link MetricStore} confines reads to a single Organization and the service
 * additionally restricts every query to the viewer's authorized
 * {@link AnalyticsScope}, so analytics never crosses a tenant boundary
 * (Req 1.2, 1.4, 31.7).
 */

/**
 * The kind of request a {@link RequestMetric} measures (Req 31.1).
 *
 * Distinguishes the billable/trackable request paths so usage and cost can be
 * reported per modality. Mirrors the platform's request modalities: a chat
 * completion, an embedding, an image generation, an autonomous agent run, a
 * scheduled workflow run, and a web/unified search.
 */
export type RequestType = 'chat' | 'embedding' | 'image' | 'agent' | 'workflow' | 'search';

/** All {@link RequestType} values, for iteration, validation, and test generators. */
export const REQUEST_TYPES: readonly RequestType[] = [
  'chat',
  'embedding',
  'image',
  'agent',
  'workflow',
  'search',
] as const;

/** Narrow runtime guard that a value is a supported {@link RequestType}. */
export function isRequestType(value: unknown): value is RequestType {
  return typeof value === 'string' && (REQUEST_TYPES as readonly string[]).includes(value);
}

/**
 * A single granular per-request metric (Req 31.1).
 *
 * Recorded when a billable or trackable request completes, it captures exactly
 * the dimensions Req 31.1 enumerates — the served model and provider, the input
 * and output token counts, the cost in USD, the end-to-end latency, the request
 * type, and the number of tool calls the request made — plus the optional
 * time-to-first-token (Req 31.4) and an `error` flag (so the error rate can be
 * reported, Req 31.4). The {@link organizationId} / {@link teamId} /
 * {@link projectId} / {@link userId} are the tenant scope a query restricts and
 * the keys a cost breakdown groups by (Req 31.3, 31.7).
 */
export interface RequestMetric {
  /** The metric's stable unique id. */
  id: string;
  /** The Organization the request belonged to (its tenant scope, Req 1.4). */
  organizationId: string;
  /** The owning Team, when the request was team-scoped. */
  teamId?: string;
  /** The owning Project, when the request was project-scoped. */
  projectId?: string;
  /** The user who made the request (the active-user and per-user cost key). */
  userId: string;
  /** The model that served the request (Req 31.1, 31.3). */
  model: string;
  /** The provider that served the request (Req 31.1). */
  provider: string;
  /** The number of input (prompt) tokens (Req 31.1). */
  inputTokens: number;
  /** The number of output (completion) tokens (Req 31.1). */
  outputTokens: number;
  /** The request's cost in USD (Req 31.1, 31.3). */
  costUsd: number;
  /** The end-to-end latency in milliseconds (Req 31.1, 31.4). */
  latencyMs: number;
  /** The time-to-first-token in milliseconds, when the request streamed (Req 31.4). */
  timeToFirstTokenMs?: number;
  /** The kind of request (Req 31.1). */
  requestType: RequestType;
  /** The number of tool calls the request made (Req 31.1). */
  toolCallCount: number;
  /** Whether the request ended in an error (drives the error rate, Req 31.4). */
  error?: boolean;
  /** The ISO-8601 instant the request completed and was recorded. */
  recordedAt: string;
}

/**
 * A single granular per-agent-run metric (Req 31.5).
 *
 * Recorded when an Agent_Runtime run finishes, it carries the run's step count,
 * whether it succeeded, and its total cost — the inputs to the agent run-count,
 * steps-per-run, success-rate, and cost-per-run report (Req 31.5).
 */
export interface AgentRunMetric {
  /** The metric's stable unique id. */
  id: string;
  /** The Organization the run belonged to (its tenant scope, Req 1.4). */
  organizationId: string;
  /** The owning Team, when the run was team-scoped. */
  teamId?: string;
  /** The owning Project, when the run was project-scoped. */
  projectId?: string;
  /** The user who started the run. */
  userId: string;
  /** The id of the agent run this metric summarizes. */
  runId: string;
  /** The number of steps the run executed (Req 31.5). */
  steps: number;
  /** Whether the run completed successfully (Req 31.5). */
  success: boolean;
  /** The run's total cost in USD (Req 31.5). */
  costUsd: number;
  /** The ISO-8601 instant the run finished and was recorded. */
  recordedAt: string;
}

/**
 * A single granular RAG-retrieval metric (Req 31.6).
 *
 * Recorded for a retrieval-augmented answer, it carries the retrieval relevance
 * score and whether the answer carried a source attribution — the inputs to the
 * average-relevance and source-attribution-rate report (Req 31.6).
 */
export interface RagMetric {
  /** The metric's stable unique id. */
  id: string;
  /** The Organization the retrieval belonged to (its tenant scope, Req 1.4). */
  organizationId: string;
  /** The owning Team, when the retrieval was team-scoped. */
  teamId?: string;
  /** The owning Project, when the retrieval was project-scoped. */
  projectId?: string;
  /** The user the retrieval served. */
  userId: string;
  /** The retrieval relevance score, conventionally in [0, 1] (Req 31.6). */
  relevanceScore: number;
  /** Whether the answer carried a source attribution (Req 31.6). */
  sourceAttributed: boolean;
  /** The ISO-8601 instant the retrieval was recorded. */
  recordedAt: string;
}

/**
 * A half-open-agnostic time window an aggregation is computed over.
 *
 * A granular record is in the window iff its recorded instant is within
 * `[fromMs, toMs]` inclusive of both ends. Named {@link AnalyticsPeriod} (rather
 * than a bare `Period`) so it never collides with sibling modules in the shared
 * `@auxify/core` barrel.
 */
export interface AnalyticsPeriod {
  /** The inclusive start of the window, in epoch milliseconds. */
  fromMs: number;
  /** The inclusive end of the window, in epoch milliseconds. */
  toMs: number;
}

/**
 * The Organization, Teams, and Projects an administrator is authorized to view
 * (Req 31.7).
 *
 * {@link organizationId} is always present and is the hard tenant boundary every
 * query is confined to. {@link teamIds} / {@link projectIds} are OPTIONAL
 * narrowing filters: when `undefined` the viewer may see every Team / Project in
 * the Organization (an Organization-wide administrator); when present (even when
 * empty) they restrict the view to exactly those Teams / Projects (a scoped
 * administrator) — a granular record is then included only if it falls within an
 * authorized Team AND an authorized Project, so the view fails closed.
 */
export interface AnalyticsScope {
  /** The Organization the view is confined to (always required, Req 1.4, 31.7). */
  organizationId: string;
  /** The authorized Teams, or `undefined` for every Team in the Organization. */
  teamIds?: readonly string[];
  /** The authorized Projects, or `undefined` for every Project in the Organization. */
  projectIds?: readonly string[];
}

/**
 * The administrator on whose behalf an analytics query is made.
 *
 * Identity only — the authorized {@link AnalyticsScope} is resolved from it by
 * the {@link ScopeAuthorizer}, so a caller can never widen their own view. The
 * {@link userId} is also the actor recorded on a denied-query audit event
 * (Req 37.1).
 */
export interface AnalyticsViewer {
  /** The administrator's user id. */
  userId: string;
  /** The Organization the administrator belongs to. */
  organizationId: string;
}

/**
 * The seam that resolves the {@link AnalyticsScope} an {@link AnalyticsViewer}
 * is authorized to view (Req 31.7).
 *
 * Modelling authorization as a narrow port keeps the Analytics_Service decoupled
 * from Access_Control / the Tenancy_Service: production wires an adapter that
 * derives the scope from the viewer's role and memberships, while tests
 * substitute a fake that returns a fixed scope. The service treats the returned
 * scope as the single source of truth for what the viewer may see and never
 * widens it.
 */
export interface ScopeAuthorizer {
  /**
   * Resolve the Organization, Teams, and Projects the viewer may view (Req 31.7).
   *
   * @param viewer The administrator making the query.
   * @returns The authorized scope; its `organizationId` is the hard tenant boundary.
   */
  authorizedScope(viewer: AnalyticsViewer): Promise<AnalyticsScope>;
}

/**
 * An optional narrowing of an authorized query to specific Teams / Projects.
 *
 * A query may ask to see only a subset of the viewer's authorized scope. Any
 * requested Team / Project that is NOT within the authorized scope causes the
 * query to fail closed with an
 * {@link import('./errors.js').UnauthorizedAnalyticsScopeError}; otherwise the
 * effective scope is the intersection of the authorized scope and the request.
 */
export interface ScopeNarrowing {
  /** Restrict the query to these Teams (each must be authorized). */
  teamIds?: readonly string[];
  /** Restrict the query to these Projects (each must be authorized). */
  projectIds?: readonly string[];
}

/** Options narrowing a single analytics query within the viewer's authorized scope. */
export interface AnalyticsQueryOptions {
  /** An optional narrowing to a subset of the authorized Teams / Projects. */
  scope?: ScopeNarrowing;
}

/**
 * The tenant/scope/time-filtered store of granular analytics records and the
 * retention seam (Req 31.1, 31.8).
 *
 * The three append methods record one granular event each; the three query
 * methods read an Organization's records over an {@link AnalyticsPeriod}
 * (Team/Project scope narrowing is applied by the service, defensively, over the
 * returned records); and the three purge methods are the retention seam that
 * deletes granular records recorded strictly before a cutoff instant (Req 31.8).
 * The concrete implementation is the tenant-scoped repository; tests substitute
 * the in-memory {@link import('./fakes.js').InMemoryMetricStore}.
 */
export interface MetricStore {
  /** Append one granular {@link RequestMetric}. */
  appendRequest(metric: RequestMetric): Promise<void>;
  /** Append one granular {@link AgentRunMetric}. */
  appendAgentRun(metric: AgentRunMetric): Promise<void>;
  /** Append one granular {@link RagMetric}. */
  appendRag(metric: RagMetric): Promise<void>;
  /** Read an Organization's {@link RequestMetric}s over the query's period. */
  queryRequests(query: MetricQuery): Promise<RequestMetric[]>;
  /** Read an Organization's {@link AgentRunMetric}s over the query's period. */
  queryAgentRuns(query: MetricQuery): Promise<AgentRunMetric[]>;
  /** Read an Organization's {@link RagMetric}s over the query's period. */
  queryRag(query: MetricQuery): Promise<RagMetric[]>;
  /** Delete {@link RequestMetric}s recorded strictly before `cutoffMs`; returns the count removed (Req 31.8). */
  purgeRequestsBefore(cutoffMs: number): Promise<number>;
  /** Delete {@link AgentRunMetric}s recorded strictly before `cutoffMs`; returns the count removed (Req 31.8). */
  purgeAgentRunsBefore(cutoffMs: number): Promise<number>;
  /** Delete {@link RagMetric}s recorded strictly before `cutoffMs`; returns the count removed (Req 31.8). */
  purgeRagBefore(cutoffMs: number): Promise<number>;
}

/**
 * The tenant- and time-bounded read selector the {@link MetricStore} resolves.
 *
 * The store filters its records to the {@link organizationId} (the hard tenant
 * boundary) and the {@link period}; the service applies the remaining Team /
 * Project scope restriction over the result (Req 31.7).
 */
export interface MetricQuery {
  /** The Organization whose records to read (Req 1.4). */
  organizationId: string;
  /** The time window to read over. */
  period: AnalyticsPeriod;
}

/**
 * The injectable clock the service reads for "now" (drives retention, Req 31.8).
 *
 * Injectable so unit tests can age records deterministically without real time.
 * Named {@link AnalyticsClock} (not `Clock`) so it never collides with the
 * Model_Router's, Scheduler's, Cache_Manager's, Budget_Manager's,
 * Document_Management_Service's, or Backup_Service's identically-purposed clocks
 * in the shared `@auxify/core` barrel.
 */
export interface AnalyticsClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link AnalyticsClock}, backed by the global `Date.now`. */
export const systemAnalyticsClock: AnalyticsClock = { now: () => Date.now() };

/**
 * The aggregated usage report for a period (Req 31.2).
 *
 * The total request count, the input/output/total token counts, the total cost,
 * and the number of distinct active users over the selected period within the
 * authorized scope.
 */
export interface UsageSummary {
  /** The number of requests in the period. */
  totalRequests: number;
  /** The total input (prompt) tokens. */
  totalInputTokens: number;
  /** The total output (completion) tokens. */
  totalOutputTokens: number;
  /** The total tokens (input + output). */
  totalTokens: number;
  /** The total cost in USD. */
  totalCostUsd: number;
  /** The number of distinct users who made a request (active users, Req 31.2). */
  activeUsers: number;
}

/** One cost-grouping bucket: a group key and its summed cost in USD (Req 31.3). */
export interface CostGroup {
  /** The group key — a model, Team, Project, or user id (or the unattributed sentinel). */
  key: string;
  /** The summed cost in USD for the key. */
  costUsd: number;
}

/**
 * The cost report grouped by model, by Team, by Project, and by user (Req 31.3).
 *
 * Each grouping sums {@link RequestMetric.costUsd} per key and is ordered by
 * non-increasing cost, ties broken on the key, so the most expensive group is
 * first. Records with no Team / Project are summed under the
 * {@link import('./aggregation.js').UNATTRIBUTED_GROUP_KEY} sentinel so the
 * grouped totals always reconcile to the overall total.
 */
export interface CostBreakdown {
  /** Cost grouped by model. */
  byModel: CostGroup[];
  /** Cost grouped by Team. */
  byTeam: CostGroup[];
  /** Cost grouped by Project. */
  byProject: CostGroup[];
  /** Cost grouped by user. */
  byUser: CostGroup[];
}

/**
 * The performance report for a period (Req 31.4).
 *
 * Response latency at the 50th, 95th, and 99th percentiles, the average
 * time-to-first-token, and the error rate over the selected period within the
 * authorized scope.
 */
export interface PerformanceSummary {
  /** The number of requests the percentiles were computed over. */
  sampleCount: number;
  /** The 50th-percentile (median) latency in milliseconds. */
  p50LatencyMs: number;
  /** The 95th-percentile latency in milliseconds. */
  p95LatencyMs: number;
  /** The 99th-percentile latency in milliseconds. */
  p99LatencyMs: number;
  /** The average time-to-first-token in milliseconds over the requests that reported one. */
  avgTimeToFirstTokenMs: number;
  /** The error rate in [0, 1] — the fraction of requests that ended in an error. */
  errorRate: number;
}

/**
 * The agent report for a period (Req 31.5).
 *
 * The run count, the average number of steps per run, the success rate, and the
 * average cost per run over the selected period within the authorized scope.
 */
export interface AgentSummary {
  /** The number of agent runs in the period. */
  runCount: number;
  /** The average number of steps per run. */
  avgStepsPerRun: number;
  /** The success rate in [0, 1] — the fraction of runs that succeeded. */
  successRate: number;
  /** The average cost per run in USD. */
  avgCostPerRun: number;
}

/**
 * The RAG report for a period (Req 31.6).
 *
 * The average retrieval relevance score and the source-attribution rate over the
 * selected period within the authorized scope.
 */
export interface RagSummary {
  /** The number of retrievals the averages were computed over. */
  sampleCount: number;
  /** The average retrieval relevance score. */
  avgRelevanceScore: number;
  /** The source-attribution rate in [0, 1] — the fraction of answers carrying a source. */
  sourceAttributionRate: number;
}

/**
 * The number of days granular analytics data is retained (Req 31.8).
 *
 * A granular {@link RequestMetric} / {@link AgentRunMetric} / {@link RagMetric}
 * recorded within this window is retained; one recorded strictly before the
 * window's start is eligible for purge by
 * {@link import('./analytics-service.js').AnalyticsService.purgeExpired}.
 */
export const GRANULAR_RETENTION_DAYS = 90;

/**
 * The number of days aggregated analytics data is retained (2 years, Req 31.8).
 *
 * Aggregated rollups (usage / cost / performance / agent / RAG summaries) remain
 * derivable for this period; the constant documents the policy the production
 * rollup store honours. The granular purge
 * ({@link import('./analytics-service.js').AnalyticsService.purgeExpired})
 * respects the shorter {@link GRANULAR_RETENTION_DAYS} window only.
 */
export const AGGREGATED_RETENTION_DAYS = 730;

/** The number of milliseconds in one day, used to convert the retention windows. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
