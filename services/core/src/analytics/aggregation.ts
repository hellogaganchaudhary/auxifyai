/**
 * The pure aggregation core of the Analytics_Service (Req 31.2-31.6).
 *
 * These functions turn a list of granular records — {@link RequestMetric},
 * {@link AgentRunMetric}, {@link RagMetric} — into the aggregated report shapes
 * the dashboard presents. They are total, deterministic, and side-effect-free:
 * no clock, no store, no I/O, so the {@link AnalyticsService} composes them over
 * already scope-restricted, period-filtered records and the unit tests exercise
 * them directly.
 *
 * Conventions shared across the helpers:
 *   - an empty input yields a well-defined zero report (no division by zero);
 *   - rates are clamped to [0, 1];
 *   - cost groupings are ordered by non-increasing cost, ties broken on the key,
 *     so the most expensive group is deterministic and first.
 */

import type {
  AgentRunMetric,
  AgentSummary,
  CostBreakdown,
  CostGroup,
  PerformanceSummary,
  RagMetric,
  RagSummary,
  RequestMetric,
  UsageSummary,
} from './types.js';

/**
 * The group key under which a record with no Team / Project is summed in a
 * {@link CostBreakdown} (Req 31.3).
 *
 * Using an explicit sentinel rather than dropping unattributed records keeps the
 * grouped totals reconciled to the overall total cost.
 */
export const UNATTRIBUTED_GROUP_KEY = '(unattributed)';

/**
 * The percentile of a numeric sample using the nearest-rank method (Req 31.4).
 *
 * The values are sorted ascending and the rank `ceil(p/100 * n)` is selected
 * (clamped to `[1, n]`), so `percentile(xs, 50)` is the median, `95` the
 * 95th-percentile, and `100` the maximum. An empty sample yields `0`. The input
 * array is not mutated.
 *
 * @param values The sample (need not be sorted).
 * @param p The percentile in `[0, 100]`.
 * @returns The value at the requested percentile, or `0` for an empty sample.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const clampedP = Math.min(100, Math.max(0, p));
  if (clampedP === 0) {
    return sorted[0] as number;
  }
  const rank = Math.ceil((clampedP / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] as number;
}

/**
 * The error rate of a request sample in `[0, 1]` (Req 31.4).
 *
 * The fraction of records whose `error` flag is `true`. An empty sample has a
 * rate of `0`.
 */
export function errorRate(metrics: readonly RequestMetric[]): number {
  if (metrics.length === 0) {
    return 0;
  }
  const errors = metrics.reduce((count, m) => count + (m.error === true ? 1 : 0), 0);
  return errors / metrics.length;
}

/**
 * The number of distinct users in a record sample — the active-user count
 * (Req 31.2).
 *
 * Generic over any record carrying a `userId`, so it counts active users across
 * request, agent-run, or RAG records alike.
 */
export function activeUserCount(records: readonly { userId: string }[]): number {
  const users = new Set<string>();
  for (const r of records) {
    users.add(r.userId);
  }
  return users.size;
}

/**
 * Sum the cost of request records grouped by a derived key, ordered by
 * non-increasing cost (Req 31.3).
 *
 * The `keyOf` selector returns the grouping key for a record, or `undefined`
 * for an unattributed record (summed under {@link UNATTRIBUTED_GROUP_KEY}). The
 * result is ordered by non-increasing summed cost, ties broken on the key
 * ascending, so it is deterministic.
 *
 * @param metrics The request records to group.
 * @param keyOf Derives the group key for a record (`undefined` ⇒ unattributed).
 * @returns The cost groups, most expensive first.
 */
export function groupCostBy(
  metrics: readonly RequestMetric[],
  keyOf: (metric: RequestMetric) => string | undefined,
): CostGroup[] {
  const totals = new Map<string, number>();
  for (const metric of metrics) {
    const key = keyOf(metric) ?? UNATTRIBUTED_GROUP_KEY;
    totals.set(key, (totals.get(key) ?? 0) + metric.costUsd);
  }
  return [...totals.entries()]
    .map(([key, costUsd]) => ({ key, costUsd }))
    .sort((a, b) => (b.costUsd !== a.costUsd ? b.costUsd - a.costUsd : a.key < b.key ? -1 : 1));
}

/**
 * Aggregate request records into the {@link UsageSummary} for a period
 * (Req 31.2).
 *
 * Totals the request count, the input/output/total token counts and cost, and
 * counts the distinct active users.
 */
export function summarizeUsage(metrics: readonly RequestMetric[]): UsageSummary {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  for (const m of metrics) {
    totalInputTokens += m.inputTokens;
    totalOutputTokens += m.outputTokens;
    totalCostUsd += m.costUsd;
  }
  return {
    totalRequests: metrics.length,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCostUsd,
    activeUsers: activeUserCount(metrics),
  };
}

/**
 * Aggregate request records into the full {@link CostBreakdown} — by model, by
 * Team, by Project, and by user (Req 31.3).
 */
export function summarizeCost(metrics: readonly RequestMetric[]): CostBreakdown {
  return {
    byModel: groupCostBy(metrics, (m) => m.model),
    byTeam: groupCostBy(metrics, (m) => m.teamId),
    byProject: groupCostBy(metrics, (m) => m.projectId),
    byUser: groupCostBy(metrics, (m) => m.userId),
  };
}

/**
 * Aggregate request records into the {@link PerformanceSummary} for a period
 * (Req 31.4).
 *
 * Computes the p50/p95/p99 latency over every record, the average
 * time-to-first-token over the records that reported one, and the error rate.
 */
export function summarizePerformance(metrics: readonly RequestMetric[]): PerformanceSummary {
  const latencies = metrics.map((m) => m.latencyMs);
  const ttfts = metrics
    .map((m) => m.timeToFirstTokenMs)
    .filter((v): v is number => typeof v === 'number');
  const avgTimeToFirstTokenMs =
    ttfts.length === 0 ? 0 : ttfts.reduce((sum, v) => sum + v, 0) / ttfts.length;
  return {
    sampleCount: metrics.length,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    avgTimeToFirstTokenMs,
    errorRate: errorRate(metrics),
  };
}

/**
 * Aggregate agent-run records into the {@link AgentSummary} for a period
 * (Req 31.5).
 *
 * Computes the run count, the average steps per run, the success rate, and the
 * average cost per run. An empty sample yields an all-zero summary.
 */
export function summarizeAgentRuns(metrics: readonly AgentRunMetric[]): AgentSummary {
  if (metrics.length === 0) {
    return { runCount: 0, avgStepsPerRun: 0, successRate: 0, avgCostPerRun: 0 };
  }
  let totalSteps = 0;
  let successes = 0;
  let totalCost = 0;
  for (const m of metrics) {
    totalSteps += m.steps;
    successes += m.success ? 1 : 0;
    totalCost += m.costUsd;
  }
  return {
    runCount: metrics.length,
    avgStepsPerRun: totalSteps / metrics.length,
    successRate: successes / metrics.length,
    avgCostPerRun: totalCost / metrics.length,
  };
}

/**
 * Aggregate RAG records into the {@link RagSummary} for a period (Req 31.6).
 *
 * Computes the average retrieval relevance score and the source-attribution
 * rate. An empty sample yields an all-zero summary.
 */
export function summarizeRag(metrics: readonly RagMetric[]): RagSummary {
  if (metrics.length === 0) {
    return { sampleCount: 0, avgRelevanceScore: 0, sourceAttributionRate: 0 };
  }
  let totalRelevance = 0;
  let attributed = 0;
  for (const m of metrics) {
    totalRelevance += m.relevanceScore;
    attributed += m.sourceAttributed ? 1 : 0;
  }
  return {
    sampleCount: metrics.length,
    avgRelevanceScore: totalRelevance / metrics.length,
    sourceAttributionRate: attributed / metrics.length,
  };
}
