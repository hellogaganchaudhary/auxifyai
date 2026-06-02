/**
 * Unit tests for the pure aggregation core of the Analytics_Service
 * (Req 31.2-31.6).
 *
 * These exercise the side-effect-free helpers directly over hand-built record
 * samples, covering:
 *   - {@link percentile} on a known sample (p50/p95/p99 nearest-rank, Req 31.4);
 *   - {@link errorRate} (Req 31.4);
 *   - {@link activeUserCount} distinct-user count (Req 31.2);
 *   - {@link groupCostBy} / {@link summarizeCost} cost grouping (Req 31.3);
 *   - {@link summarizeUsage} totals + active users (Req 31.2);
 *   - {@link summarizePerformance} (Req 31.4);
 *   - {@link summarizeAgentRuns} (Req 31.5);
 *   - {@link summarizeRag} (Req 31.6).
 */

import { describe, expect, it } from 'vitest';

import {
  activeUserCount,
  errorRate,
  groupCostBy,
  percentile,
  summarizeAgentRuns,
  summarizeCost,
  summarizePerformance,
  summarizeRag,
  summarizeUsage,
  UNATTRIBUTED_GROUP_KEY,
} from './aggregation.js';
import { makeAgentRunMetric, makeRagMetric, makeRequestMetric } from './fakes.js';

describe('percentile (Req 31.4)', () => {
  it('computes p50/p95/p99 on a known 1..100 sample with nearest-rank', () => {
    const sample = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    // nearest-rank: rank = ceil(p/100 * n); index = rank - 1.
    expect(percentile(sample, 50)).toBe(50); // ceil(0.50*100)=50 -> value 50
    expect(percentile(sample, 95)).toBe(95); // ceil(0.95*100)=95 -> value 95
    expect(percentile(sample, 99)).toBe(99); // ceil(0.99*100)=99 -> value 99
    expect(percentile(sample, 100)).toBe(100);
  });

  it('is order-independent and does not mutate the input', () => {
    const sample = [30, 10, 20, 50, 40];
    const copy = [...sample];
    expect(percentile(sample, 50)).toBe(30); // sorted 10,20,30,40,50; ceil(0.5*5)=3 -> 30
    expect(sample).toEqual(copy);
  });

  it('returns 0 for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('handles a single-element sample at every percentile', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe('errorRate (Req 31.4)', () => {
  it('is the fraction of records flagged as errors', () => {
    const metrics = [
      makeRequestMetric({ id: 'a', error: true }),
      makeRequestMetric({ id: 'b', error: false }),
      makeRequestMetric({ id: 'c' }), // undefined -> not an error
      makeRequestMetric({ id: 'd', error: true }),
    ];
    expect(errorRate(metrics)).toBeCloseTo(0.5, 10);
  });

  it('is 0 for an empty sample', () => {
    expect(errorRate([])).toBe(0);
  });
});

describe('activeUserCount (Req 31.2)', () => {
  it('counts distinct user ids', () => {
    const metrics = [
      makeRequestMetric({ id: 'a', userId: 'u1' }),
      makeRequestMetric({ id: 'b', userId: 'u2' }),
      makeRequestMetric({ id: 'c', userId: 'u1' }),
      makeRequestMetric({ id: 'd', userId: 'u3' }),
    ];
    expect(activeUserCount(metrics)).toBe(3);
  });

  it('is 0 for an empty sample', () => {
    expect(activeUserCount([])).toBe(0);
  });
});

describe('groupCostBy / summarizeCost (Req 31.3)', () => {
  const metrics = [
    makeRequestMetric({ id: 'a', model: 'gpt-eco', teamId: 't1', projectId: 'p1', userId: 'u1', costUsd: 1 }),
    makeRequestMetric({ id: 'b', model: 'gpt-pro', teamId: 't1', projectId: 'p2', userId: 'u2', costUsd: 3 }),
    makeRequestMetric({ id: 'c', model: 'gpt-eco', teamId: 't2', projectId: 'p1', userId: 'u1', costUsd: 2 }),
  ];

  it('groups cost by model, ordered most-expensive first', () => {
    expect(groupCostBy(metrics, (m) => m.model)).toEqual([
      { key: 'gpt-pro', costUsd: 3 },
      { key: 'gpt-eco', costUsd: 3 },
    ].sort((x, y) => (y.costUsd !== x.costUsd ? y.costUsd - x.costUsd : x.key < y.key ? -1 : 1)));
  });

  it('breaks cost-ties on the key ascending', () => {
    // gpt-eco = 1+2 = 3, gpt-pro = 3 -> tie at 3, key order gpt-eco < gpt-pro.
    const byModel = groupCostBy(metrics, (m) => m.model);
    expect(byModel).toEqual([
      { key: 'gpt-eco', costUsd: 3 },
      { key: 'gpt-pro', costUsd: 3 },
    ]);
  });

  it('sums unattributed records under the sentinel key', () => {
    const withMissing = [
      makeRequestMetric({ id: 'a', teamId: 't1', costUsd: 1 }),
      makeRequestMetric({ id: 'b', teamId: undefined, costUsd: 5 }),
    ];
    const byTeam = groupCostBy(withMissing, (m) => m.teamId);
    expect(byTeam[0]).toEqual({ key: UNATTRIBUTED_GROUP_KEY, costUsd: 5 });
    expect(byTeam).toContainEqual({ key: 't1', costUsd: 1 });
  });

  it('summarizeCost reconciles each grouping to the overall total', () => {
    const breakdown = summarizeCost(metrics);
    const total = metrics.reduce((s, m) => s + m.costUsd, 0);
    for (const groups of [breakdown.byModel, breakdown.byTeam, breakdown.byProject, breakdown.byUser]) {
      expect(groups.reduce((s, g) => s + g.costUsd, 0)).toBeCloseTo(total, 10);
    }
    expect(breakdown.byUser).toContainEqual({ key: 'u1', costUsd: 3 });
    expect(breakdown.byProject).toContainEqual({ key: 'p1', costUsd: 3 });
  });
});

describe('summarizeUsage (Req 31.2)', () => {
  it('totals requests, tokens, and cost, and counts active users', () => {
    const metrics = [
      makeRequestMetric({ id: 'a', userId: 'u1', inputTokens: 100, outputTokens: 50, costUsd: 1 }),
      makeRequestMetric({ id: 'b', userId: 'u2', inputTokens: 200, outputTokens: 80, costUsd: 2 }),
      makeRequestMetric({ id: 'c', userId: 'u1', inputTokens: 10, outputTokens: 5, costUsd: 0.5 }),
    ];
    expect(summarizeUsage(metrics)).toEqual({
      totalRequests: 3,
      totalInputTokens: 310,
      totalOutputTokens: 135,
      totalTokens: 445,
      totalCostUsd: 3.5,
      activeUsers: 2,
    });
  });

  it('yields a zero summary for an empty sample', () => {
    expect(summarizeUsage([])).toEqual({
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      activeUsers: 0,
    });
  });
});

describe('summarizePerformance (Req 31.4)', () => {
  it('computes p50/p95/p99 latency, average TTFT, and error rate', () => {
    const metrics = Array.from({ length: 100 }, (_, i) =>
      makeRequestMetric({
        id: `r${i}`,
        latencyMs: i + 1, // 1..100
        timeToFirstTokenMs: 10,
        error: i < 5, // 5 errors -> 5%
      }),
    );
    const perf = summarizePerformance(metrics);
    expect(perf.sampleCount).toBe(100);
    expect(perf.p50LatencyMs).toBe(50);
    expect(perf.p95LatencyMs).toBe(95);
    expect(perf.p99LatencyMs).toBe(99);
    expect(perf.avgTimeToFirstTokenMs).toBe(10);
    expect(perf.errorRate).toBeCloseTo(0.05, 10);
  });

  it('averages TTFT only over records that reported one', () => {
    const metrics = [
      makeRequestMetric({ id: 'a', timeToFirstTokenMs: 100 }),
      makeRequestMetric({ id: 'b' }), // no TTFT
      makeRequestMetric({ id: 'c', timeToFirstTokenMs: 200 }),
    ];
    expect(summarizePerformance(metrics).avgTimeToFirstTokenMs).toBe(150);
  });

  it('yields a zero summary for an empty sample', () => {
    expect(summarizePerformance([])).toEqual({
      sampleCount: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
      avgTimeToFirstTokenMs: 0,
      errorRate: 0,
    });
  });
});

describe('summarizeAgentRuns (Req 31.5)', () => {
  it('computes run count, average steps, success rate, and average cost per run', () => {
    const runs = [
      makeAgentRunMetric({ id: 'a', steps: 2, success: true, costUsd: 0.1 }),
      makeAgentRunMetric({ id: 'b', steps: 4, success: false, costUsd: 0.3 }),
      makeAgentRunMetric({ id: 'c', steps: 6, success: true, costUsd: 0.2 }),
    ];
    const summary = summarizeAgentRuns(runs);
    expect(summary.runCount).toBe(3);
    expect(summary.avgStepsPerRun).toBeCloseTo(4, 10);
    expect(summary.successRate).toBeCloseTo(2 / 3, 10);
    expect(summary.avgCostPerRun).toBeCloseTo(0.2, 10);
  });

  it('yields a zero summary for an empty sample', () => {
    expect(summarizeAgentRuns([])).toEqual({
      runCount: 0,
      avgStepsPerRun: 0,
      successRate: 0,
      avgCostPerRun: 0,
    });
  });
});

describe('summarizeRag (Req 31.6)', () => {
  it('computes average relevance and source-attribution rate', () => {
    const rag = [
      makeRagMetric({ id: 'a', relevanceScore: 0.6, sourceAttributed: true }),
      makeRagMetric({ id: 'b', relevanceScore: 0.8, sourceAttributed: false }),
      makeRagMetric({ id: 'c', relevanceScore: 1.0, sourceAttributed: true }),
    ];
    const summary = summarizeRag(rag);
    expect(summary.sampleCount).toBe(3);
    expect(summary.avgRelevanceScore).toBeCloseTo(0.8, 10);
    expect(summary.sourceAttributionRate).toBeCloseTo(2 / 3, 10);
  });

  it('yields a zero summary for an empty sample', () => {
    expect(summarizeRag([])).toEqual({
      sampleCount: 0,
      avgRelevanceScore: 0,
      sourceAttributionRate: 0,
    });
  });
});
