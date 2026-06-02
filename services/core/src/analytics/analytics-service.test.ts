/**
 * Unit tests for the Analytics_Service (Req 31.1-31.8).
 *
 * These drive the REAL {@link AnalyticsService} over the in-memory fakes
 * (imported directly from `./fakes.js`, never the barrel) with a hand-advanced
 * {@link MutableAnalyticsClock} as the only source of time, covering:
 *
 *   - recordRequest captures every Req 31.1 dimension (Req 31.1);
 *   - usageSummary aggregates requests/tokens/cost/active-users (Req 31.2);
 *   - costBreakdown groups by model/Team/Project/user (Req 31.3);
 *   - performance reports p50/p95/p99/TTFT/error-rate (Req 31.4);
 *   - agentMetrics + ragMetrics aggregate granular records (Req 31.5, 31.6);
 *   - a viewer's query excludes Orgs/Teams/Projects outside their authorized
 *     scope, and an out-of-scope narrowing fails closed (Req 31.7);
 *   - purgeExpired removes only records older than 90 days (Req 31.8).
 */

import { describe, expect, it } from 'vitest';

import { AnalyticsService } from './analytics-service.js';
import { UnauthorizedAnalyticsScopeError } from './errors.js';
import {
  CapturingAuditRecorder,
  FixedScopeAuthorizer,
  InMemoryMetricStore,
  MutableAnalyticsClock,
  makeTenantContext,
  makeViewer,
  sequentialAnalyticsIdGenerator,
} from './fakes.js';
import { GRANULAR_RETENTION_DAYS, MS_PER_DAY, type AnalyticsPeriod } from './types.js';

const START = Date.UTC(2026, 0, 1, 0, 0, 0);
const FULL_PERIOD: AnalyticsPeriod = { fromMs: 0, toMs: Date.UTC(2030, 0, 1) };

interface Harness {
  service: AnalyticsService;
  metrics: InMemoryMetricStore;
  audit: CapturingAuditRecorder;
  clock: MutableAnalyticsClock;
  scopes: FixedScopeAuthorizer;
}

function makeHarness(options: { granularRetentionDays?: number } = {}): Harness {
  const metrics = new InMemoryMetricStore();
  const audit = new CapturingAuditRecorder();
  const clock = new MutableAnalyticsClock(START);
  const scopes = new FixedScopeAuthorizer();
  const service = new AnalyticsService({
    metrics,
    scopeAuthorizer: scopes,
    audit,
    clock,
    idGenerator: sequentialAnalyticsIdGenerator(),
    ...(options.granularRetentionDays !== undefined
      ? { granularRetentionDays: options.granularRetentionDays }
      : {}),
  });
  return { service, metrics, audit, clock, scopes };
}

describe('AnalyticsService.recordRequest (Req 31.1)', () => {
  it('records every Req 31.1 dimension and stamps id/org/recordedAt', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1', userId: 'u1', teamId: 't1', projectId: 'p1' });

    const metric = await h.service.recordRequest(ctx, {
      model: 'gpt-pro',
      provider: 'azure',
      inputTokens: 120,
      outputTokens: 60,
      costUsd: 0.42,
      latencyMs: 850,
      timeToFirstTokenMs: 120,
      requestType: 'chat',
      toolCallCount: 2,
      error: false,
    });

    expect(metric.id).toBe('metric-1');
    expect(metric.organizationId).toBe('org-1');
    expect(metric.teamId).toBe('t1');
    expect(metric.projectId).toBe('p1');
    expect(metric.userId).toBe('u1');
    expect(metric.model).toBe('gpt-pro');
    expect(metric.provider).toBe('azure');
    expect(metric.inputTokens).toBe(120);
    expect(metric.outputTokens).toBe(60);
    expect(metric.costUsd).toBe(0.42);
    expect(metric.latencyMs).toBe(850);
    expect(metric.timeToFirstTokenMs).toBe(120);
    expect(metric.requestType).toBe('chat');
    expect(metric.toolCallCount).toBe(2);
    expect(metric.error).toBe(false);
    expect(metric.recordedAt).toBe(new Date(START).toISOString());
    expect(h.metrics.totalCount).toBe(1);
  });
});

describe('AnalyticsService.usageSummary (Req 31.2)', () => {
  it('aggregates total requests, tokens, cost, and active users for the period', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });
    await h.service.recordRequest(ctx, baseReq({ userId: 'u1', inputTokens: 100, outputTokens: 50, costUsd: 1 }));
    await h.service.recordRequest(ctx, baseReq({ userId: 'u2', inputTokens: 200, outputTokens: 80, costUsd: 2 }));
    await h.service.recordRequest(ctx, baseReq({ userId: 'u1', inputTokens: 10, outputTokens: 5, costUsd: 0.5 }));

    const usage = await h.service.usageSummary(makeViewer({ organizationId: 'org-1' }), FULL_PERIOD);

    expect(usage.totalRequests).toBe(3);
    expect(usage.totalInputTokens).toBe(310);
    expect(usage.totalOutputTokens).toBe(135);
    expect(usage.totalTokens).toBe(445);
    expect(usage.totalCostUsd).toBeCloseTo(3.5, 10);
    expect(usage.activeUsers).toBe(2);
  });

  it('only counts records within the queried period', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });
    await h.service.recordRequest(ctx, baseReq({ recordedAt: new Date(START).toISOString() }));
    await h.service.recordRequest(ctx, baseReq({ recordedAt: new Date(START + 10 * MS_PER_DAY).toISOString() }));

    const period: AnalyticsPeriod = { fromMs: START - MS_PER_DAY, toMs: START + MS_PER_DAY };
    const usage = await h.service.usageSummary(makeViewer({ organizationId: 'org-1' }), period);
    expect(usage.totalRequests).toBe(1);
  });
});

describe('AnalyticsService.costBreakdown (Req 31.3)', () => {
  it('reports cost grouped by model, Team, Project, and user', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });
    await h.service.recordRequest(ctx, baseReq({ model: 'm1', teamId: 't1', projectId: 'p1', userId: 'u1', costUsd: 1 }));
    await h.service.recordRequest(ctx, baseReq({ model: 'm2', teamId: 't1', projectId: 'p2', userId: 'u2', costUsd: 3 }));
    await h.service.recordRequest(ctx, baseReq({ model: 'm1', teamId: 't2', projectId: 'p1', userId: 'u1', costUsd: 2 }));

    const breakdown = await h.service.costBreakdown(makeViewer({ organizationId: 'org-1' }), FULL_PERIOD);

    expect(breakdown.byModel).toEqual([
      { key: 'm1', costUsd: 3 },
      { key: 'm2', costUsd: 3 },
    ]);
    expect(breakdown.byTeam).toContainEqual({ key: 't1', costUsd: 4 });
    expect(breakdown.byTeam).toContainEqual({ key: 't2', costUsd: 2 });
    expect(breakdown.byProject).toContainEqual({ key: 'p1', costUsd: 3 });
    expect(breakdown.byUser).toContainEqual({ key: 'u1', costUsd: 3 });
    expect(breakdown.byUser).toContainEqual({ key: 'u2', costUsd: 3 });
  });
});

describe('AnalyticsService.performance (Req 31.4)', () => {
  it('reports p50/p95/p99 latency, TTFT, and error rate over the period', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });
    for (let i = 0; i < 100; i += 1) {
      await h.service.recordRequest(
        ctx,
        baseReq({ latencyMs: i + 1, timeToFirstTokenMs: 20, error: i < 10 }),
      );
    }

    const perf = await h.service.performance(makeViewer({ organizationId: 'org-1' }), FULL_PERIOD);
    expect(perf.sampleCount).toBe(100);
    expect(perf.p50LatencyMs).toBe(50);
    expect(perf.p95LatencyMs).toBe(95);
    expect(perf.p99LatencyMs).toBe(99);
    expect(perf.avgTimeToFirstTokenMs).toBe(20);
    expect(perf.errorRate).toBeCloseTo(0.1, 10);
  });
});

describe('AnalyticsService.agentMetrics + ragMetrics (Req 31.5, 31.6)', () => {
  it('aggregates agent runs (count, steps, success, cost)', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });
    await h.service.recordAgentRun(ctx, { runId: 'r1', steps: 2, success: true, costUsd: 0.1 });
    await h.service.recordAgentRun(ctx, { runId: 'r2', steps: 4, success: false, costUsd: 0.3 });

    const agent = await h.service.agentMetrics(makeViewer({ organizationId: 'org-1' }), FULL_PERIOD);
    expect(agent.runCount).toBe(2);
    expect(agent.avgStepsPerRun).toBe(3);
    expect(agent.successRate).toBeCloseTo(0.5, 10);
    expect(agent.avgCostPerRun).toBeCloseTo(0.2, 10);
  });

  it('aggregates RAG retrievals (relevance, attribution rate)', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });
    await h.service.recordRag(ctx, { relevanceScore: 0.6, sourceAttributed: true });
    await h.service.recordRag(ctx, { relevanceScore: 1.0, sourceAttributed: false });

    const rag = await h.service.ragMetrics(makeViewer({ organizationId: 'org-1' }), FULL_PERIOD);
    expect(rag.sampleCount).toBe(2);
    expect(rag.avgRelevanceScore).toBeCloseTo(0.8, 10);
    expect(rag.sourceAttributionRate).toBeCloseTo(0.5, 10);
  });
});

describe('AnalyticsService scope restriction (Req 31.7)', () => {
  it('never returns another Organization\u2019s data', async () => {
    const h = makeHarness();
    await h.service.recordRequest(makeTenantContext({ organizationId: 'org-1', userId: 'a' }), baseReq({ costUsd: 5 }));
    await h.service.recordRequest(makeTenantContext({ organizationId: 'org-2', userId: 'b' }), baseReq({ costUsd: 9 }));

    // Viewer authorized for org-1 only.
    const usage = await h.service.usageSummary(makeViewer({ organizationId: 'org-1' }), FULL_PERIOD);
    expect(usage.totalRequests).toBe(1);
    expect(usage.totalCostUsd).toBe(5);
  });

  it('restricts the view to the authorized Teams/Projects of a scoped administrator', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });
    await h.service.recordRequest(ctx, baseReq({ teamId: 't1', projectId: 'p1', costUsd: 1 }));
    await h.service.recordRequest(ctx, baseReq({ teamId: 't2', projectId: 'p2', costUsd: 4 }));
    await h.service.recordRequest(ctx, baseReq({ teamId: 't1', projectId: 'p9', costUsd: 8 })); // project not allowed

    // Admin may only see team t1 + project p1.
    h.scopes.setScope('scoped-admin', { organizationId: 'org-1', teamIds: ['t1'], projectIds: ['p1'] });
    const viewer = makeViewer({ userId: 'scoped-admin', organizationId: 'org-1' });

    const usage = await h.service.usageSummary(viewer, FULL_PERIOD);
    // Only the first record (t1/p1) is in scope.
    expect(usage.totalRequests).toBe(1);
    expect(usage.totalCostUsd).toBe(1);
  });

  it('excludes records with no Team/Project when the scope restricts those dimensions (fail-closed)', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });
    await h.service.recordRequest(ctx, baseReq({ teamId: undefined, projectId: undefined, costUsd: 7 }));

    h.scopes.setScope('scoped-admin', { organizationId: 'org-1', teamIds: ['t1'] });
    const usage = await h.service.usageSummary(makeViewer({ userId: 'scoped-admin', organizationId: 'org-1' }), FULL_PERIOD);
    expect(usage.totalRequests).toBe(0);
  });

  it('fails closed when a query narrows to an unauthorized Team (Req 31.7)', async () => {
    const h = makeHarness();
    h.scopes.setScope('scoped-admin', { organizationId: 'org-1', teamIds: ['t1'] });
    const viewer = makeViewer({ userId: 'scoped-admin', organizationId: 'org-1' });

    await expect(
      h.service.usageSummary(viewer, FULL_PERIOD, { scope: { teamIds: ['t2'] } }),
    ).rejects.toBeInstanceOf(UnauthorizedAnalyticsScopeError);
    // The denial is recorded in the Audit_Service (Req 37.1).
    expect(h.audit.withAction('analytics.scope_denied')).toHaveLength(1);
  });

  it('allows a query that narrows within the authorized scope', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });
    await h.service.recordRequest(ctx, baseReq({ teamId: 't1', costUsd: 1 }));
    await h.service.recordRequest(ctx, baseReq({ teamId: 't2', costUsd: 2 }));

    h.scopes.setScope('admin', { organizationId: 'org-1', teamIds: ['t1', 't2'] });
    const viewer = makeViewer({ userId: 'admin', organizationId: 'org-1' });

    const usage = await h.service.usageSummary(viewer, FULL_PERIOD, { scope: { teamIds: ['t1'] } });
    expect(usage.totalRequests).toBe(1);
    expect(usage.totalCostUsd).toBe(1);
  });

  it('defaults to the whole Organization when no scope authorizer is configured', async () => {
    const metrics = new InMemoryMetricStore();
    const service = new AnalyticsService({ metrics, idGenerator: sequentialAnalyticsIdGenerator() });
    await service.recordRequest(makeTenantContext({ organizationId: 'org-1' }), baseReq({ costUsd: 3 }));
    await service.recordRequest(makeTenantContext({ organizationId: 'org-2' }), baseReq({ costUsd: 9 }));

    const usage = await service.usageSummary(makeViewer({ organizationId: 'org-1' }), FULL_PERIOD);
    expect(usage.totalRequests).toBe(1);
    expect(usage.totalCostUsd).toBe(3);
  });
});

describe('AnalyticsService.purgeExpired (Req 31.8)', () => {
  it('removes only granular records older than 90 days', async () => {
    const h = makeHarness();
    const ctx = makeTenantContext({ organizationId: 'org-1' });

    // One record at START, one 100 days later.
    await h.service.recordRequest(ctx, baseReq({ recordedAt: new Date(START).toISOString() }));
    await h.service.recordRequest(ctx, baseReq({ recordedAt: new Date(START + 100 * MS_PER_DAY).toISOString() }));
    await h.service.recordAgentRun(ctx, { runId: 'old', steps: 1, success: true, costUsd: 0, recordedAt: new Date(START).toISOString() });
    await h.service.recordRag(ctx, { relevanceScore: 0.5, sourceAttributed: true, recordedAt: new Date(START).toISOString() });
    expect(h.metrics.totalCount).toBe(4);

    // "Now" is START + 100 days: the cutoff is START + 10 days, so the START records expire.
    h.clock.set(START + 100 * MS_PER_DAY);
    const report = await h.service.purgeExpired();

    expect(report.requests).toBe(1);
    expect(report.agentRuns).toBe(1);
    expect(report.rag).toBe(1);
    // Only the recent request survives.
    expect(h.metrics.totalCount).toBe(1);
    expect(h.audit.withAction('analytics.retention_purge')).toHaveLength(1);
  });

  it('retains a record exactly at the 90-day boundary and purges one millisecond past it', async () => {
    // Exactly 90 days old: cutoff = now - 90d equals recordedAt, and purge is strict (< cutoff) -> retained.
    {
      const h = makeHarness();
      const ctx = makeTenantContext({ organizationId: 'org-1' });
      await h.service.recordRequest(ctx, baseReq({ recordedAt: new Date(START).toISOString() }));
      h.clock.set(START + GRANULAR_RETENTION_DAYS * MS_PER_DAY);
      const report = await h.service.purgeExpired();
      expect(report.requests).toBe(0);
      expect(h.metrics.totalCount).toBe(1);
    }
    // One millisecond past 90 days: recordedAt < cutoff -> purged.
    {
      const h = makeHarness();
      const ctx = makeTenantContext({ organizationId: 'org-1' });
      await h.service.recordRequest(ctx, baseReq({ recordedAt: new Date(START).toISOString() }));
      h.clock.set(START + GRANULAR_RETENTION_DAYS * MS_PER_DAY + 1);
      const report = await h.service.purgeExpired();
      expect(report.requests).toBe(1);
      expect(h.metrics.totalCount).toBe(0);
    }
  });

  it('does not audit when nothing was purged', async () => {
    const h = makeHarness();
    await h.service.recordRequest(makeTenantContext({ organizationId: 'org-1' }), baseReq({ recordedAt: new Date(START).toISOString() }));
    h.clock.set(START + MS_PER_DAY); // well within retention
    const report = await h.service.purgeExpired();
    expect(report).toEqual({ requests: 0, agentRuns: 0, rag: 0 });
    expect(h.audit.withAction('analytics.retention_purge')).toHaveLength(0);
  });
});

/** A base recordRequest input with sensible defaults; override per test. */
function baseReq(
  overrides: Partial<Parameters<AnalyticsService['recordRequest']>[1]> = {},
): Parameters<AnalyticsService['recordRequest']>[1] {
  return {
    model: 'gpt-economy',
    provider: 'openai',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.01,
    latencyMs: 200,
    requestType: 'chat',
    toolCallCount: 0,
    ...overrides,
  };
}
