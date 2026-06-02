/**
 * Analytics_Service (Req 31.1-31.8): the platform's usage, cost, performance,
 * agent, and RAG analytics aggregation and query layer.
 *
 * The {@link AnalyticsService} records a granular per-request metric when a
 * billable or trackable request completes — the model, provider, input/output
 * tokens, cost, latency, request type, and tool-call count (Req 31.1) — plus
 * granular agent-run (Req 31.5) and RAG (Req 31.6) metrics, and reports the
 * dashboard's aggregations over an authorized, time-bounded view:
 *   - {@link AnalyticsService.usageSummary} — total requests, tokens, cost, and
 *     active users for the selected period (Req 31.2);
 *   - {@link AnalyticsService.costBreakdown} — cost grouped by model, Team,
 *     Project, and user (Req 31.3);
 *   - {@link AnalyticsService.performance} — p50/p95/p99 latency,
 *     time-to-first-token, and error rate (Req 31.4);
 *   - {@link AnalyticsService.agentMetrics} — agent run count, steps per run,
 *     success rate, and cost per run (Req 31.5);
 *   - {@link AnalyticsService.ragMetrics} — retrieval relevance and
 *     source-attribution rate (Req 31.6).
 *
 * Every query is restricted to the Organization, Teams, and Projects the
 * administrator is authorized to view through the injectable
 * {@link ScopeAuthorizer}; a query that names an out-of-scope Team or Project
 * fails closed with an {@link UnauthorizedAnalyticsScopeError}, so a query never
 * returns data outside the viewer's authorized scope (Req 31.7). Granular data
 * is purged once its 90-day window elapses
 * ({@link AnalyticsService.purgeExpired}) while aggregated data is retained for
 * 2 years — the windows are the exported {@link GRANULAR_RETENTION_DAYS} and
 * {@link AGGREGATED_RETENTION_DAYS} constants (Req 31.8).
 *
 * It is the AGGREGATION / QUERY layer over the request outcomes the Model_Router
 * already records (Req 3.9); it never re-routes or re-prices a request. The
 * aggregation arithmetic is the pure, separately-tested core in
 * `./aggregation.js` ({@link percentile}, {@link errorRate},
 * {@link activeUserCount}, {@link groupCostBy}, and the `summarize*` helpers).
 *
 * Every external capability is a narrow injectable port — the {@link MetricStore}
 * (append, period-filtered reads, and the retention seam), the
 * {@link ScopeAuthorizer} (Req 31.7), the shared
 * {@link import('../audit/index.js').AuditRecorder} (denied queries and purges
 * are recorded, Req 37.1), and an {@link AnalyticsClock} — so the service is pure
 * orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`. Those fakes ({@link import('./fakes.js').InMemoryMetricStore},
 * a fixed {@link ScopeAuthorizer}, an advanceable clock, and the builders) are
 * intentionally NOT re-exported from this barrel — following the established
 * convention, the tests import them directly from `./fakes.js`.
 *
 * The injectable clock is surfaced as {@link AnalyticsClock} /
 * {@link systemAnalyticsClock} and the window type as {@link AnalyticsPeriod}
 * (rather than a bare `Clock` / `Period`) so they never collide with the
 * Model_Router's, Scheduler's, Cache_Manager's, Budget_Manager's,
 * Document_Management_Service's, or Backup_Service's identically-purposed clocks
 * or types in the shared `@auxify/core` barrel.
 */

export {
  AnalyticsService,
  type AnalyticsServiceOptions,
  type AnalyticsIdGenerator,
  type RecordRequestInput,
  type RecordAgentRunInput,
  type RecordRagInput,
  type PurgeReport,
} from './analytics-service.js';

export {
  percentile,
  errorRate,
  activeUserCount,
  groupCostBy,
  summarizeUsage,
  summarizeCost,
  summarizePerformance,
  summarizeAgentRuns,
  summarizeRag,
  UNATTRIBUTED_GROUP_KEY,
} from './aggregation.js';

export {
  UnauthorizedAnalyticsScopeError,
  UNAUTHORIZED_ANALYTICS_SCOPE_CODE,
  type AnalyticsScopeDimension,
} from './errors.js';

export {
  systemAnalyticsClock,
  REQUEST_TYPES,
  isRequestType,
  GRANULAR_RETENTION_DAYS,
  AGGREGATED_RETENTION_DAYS,
  type RequestType,
  type RequestMetric,
  type AgentRunMetric,
  type RagMetric,
  type AnalyticsPeriod,
  type AnalyticsScope,
  type AnalyticsViewer,
  type ScopeAuthorizer,
  type ScopeNarrowing,
  type AnalyticsQueryOptions,
  type MetricStore,
  type MetricQuery,
  type AnalyticsClock,
  type UsageSummary,
  type CostGroup,
  type CostBreakdown,
  type PerformanceSummary,
  type AgentSummary,
  type RagSummary,
} from './types.js';
