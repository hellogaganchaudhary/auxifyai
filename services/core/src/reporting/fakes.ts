/**
 * Test fakes and builders for the Report_Generator (Req 32.1-32.3).
 *
 * The Report_Generator composes its ports — an {@link AnalyticsDataSource}, an
 * optional {@link SecurityAuditSource}, an optional {@link KnowledgeHealthSource},
 * a {@link ReportRenderer}, an optional {@link ScopeAuthorizer}, and a
 * {@link ReportClock}. These in-memory fakes let unit tests drive the generator
 * deterministically and, crucially, ASSERT THE AUTHORIZED-SCOPE RESTRICTION
 * (Req 32.3): every data-source fake records the {@link AnalyticsViewer} and the
 * {@link AnalyticsQueryOptions} (the scope narrowing) it was called with, so a
 * test can prove the generator only ever fetched data within the viewer's
 * authorized scope — and can return different canned data per requested scope to
 * model a scoped administrator seeing less data:
 *
 *   - {@link FakeAnalyticsDataSource} returns canned usage / cost / performance /
 *     agent summaries and records every call;
 *   - {@link FakeSecurityAuditSource} returns canned audit rows and records every call;
 *   - {@link FakeKnowledgeHealthSource} returns canned KB-health stats and records every call;
 *   - {@link TextReportRenderer} is a deterministic PDF renderer that emits a
 *     stable UTF-8 text-bytes representation of the document, so the suite runs
 *     without a real PDF engine;
 *   - {@link FixedScopeAuthorizer} returns a per-viewer fixed {@link AnalyticsScope}
 *     so a test can model an Org-wide or a Team/Project-scoped administrator (Req 32.3);
 *   - {@link MutableReportClock} is a hand-advanceable clock so the generated-at
 *     instant (and therefore the filename) is deterministic;
 *   - {@link makeReportViewer} is a small viewer builder with sensible defaults.
 *
 * These are imported directly from `./fakes.js` by the tests (never from the
 * package barrel), matching the established convention.
 */

import type {
  AgentSummary,
  AnalyticsPeriod,
  AnalyticsQueryOptions,
  AnalyticsScope,
  AnalyticsViewer,
  CostBreakdown,
  PerformanceSummary,
  ScopeAuthorizer,
  UsageSummary,
} from '../analytics/index.js';
import type {
  AnalyticsDataSource,
  KnowledgeHealthSource,
  KnowledgeHealthStats,
  ReportClock,
  ReportDocument,
  ReportRenderer,
  SecurityAuditRow,
  SecurityAuditSource,
} from './types.js';

/** A recorded `(method, viewer, period, options)` tuple as seen by a source port. */
export interface RecordedSourceCall {
  /** The method that was invoked, e.g. `usageSummary`. */
  method: string;
  /** The viewer the call was made on behalf of. */
  viewer: AnalyticsViewer;
  /** The period the call covered. */
  period: AnalyticsPeriod;
  /** The query options (the scope narrowing) the call carried. */
  options: AnalyticsQueryOptions;
}

/** A canned set of analytics summaries the {@link FakeAnalyticsDataSource} returns. */
export interface CannedAnalytics {
  /** The usage summary to return (Req 31.2). */
  usage: UsageSummary;
  /** The cost breakdown to return (Req 31.3). */
  cost: CostBreakdown;
  /** The performance summary to return (Req 31.4). */
  performance: PerformanceSummary;
  /** The agent summary to return (Req 31.5). */
  agent: AgentSummary;
}

/** Build a default {@link CannedAnalytics} set; override field-by-field. */
export function makeCannedAnalytics(overrides: Partial<CannedAnalytics> = {}): CannedAnalytics {
  return {
    usage: {
      totalRequests: 120,
      totalInputTokens: 40_000,
      totalOutputTokens: 18_000,
      totalTokens: 58_000,
      totalCostUsd: 12.5,
      activeUsers: 7,
    },
    cost: {
      byModel: [
        { key: 'gpt-premium', costUsd: 8.25 },
        { key: 'gpt-economy', costUsd: 4.25 },
      ],
      byTeam: [
        { key: 'team-eng', costUsd: 9.0 },
        { key: 'team-sales', costUsd: 3.5 },
      ],
      byProject: [{ key: 'project-apollo', costUsd: 12.5 }],
      byUser: [
        { key: 'user-1', costUsd: 7.0 },
        { key: 'user-2', costUsd: 5.5 },
      ],
    },
    performance: {
      sampleCount: 120,
      p50LatencyMs: 220,
      p95LatencyMs: 880,
      p99LatencyMs: 1500,
      avgTimeToFirstTokenMs: 95,
      errorRate: 0.0167,
    },
    agent: {
      runCount: 14,
      avgStepsPerRun: 6.5,
      successRate: 0.9286,
      avgCostPerRun: 0.42,
    },
    ...overrides,
  };
}

/**
 * A canned {@link AnalyticsDataSource} that returns fixed summaries and records
 * every call, so a test can assert the generator only ever fetched data within
 * the viewer's authorized scope (Req 32.3).
 *
 * A per-scope override may be registered with {@link setScopedAnalytics}, keyed
 * by the serialized scope narrowing, to model a scoped administrator seeing a
 * smaller, restricted result set.
 */
export class FakeAnalyticsDataSource implements AnalyticsDataSource {
  /** Every call made on this source, in order, with the scope it carried. */
  readonly calls: RecordedSourceCall[] = [];
  private readonly base: CannedAnalytics;
  private readonly scoped = new Map<string, CannedAnalytics>();

  constructor(base: CannedAnalytics = makeCannedAnalytics()) {
    this.base = base;
  }

  /** Register the canned summaries returned for a specific scope narrowing. */
  setScopedAnalytics(options: AnalyticsQueryOptions, canned: CannedAnalytics): this {
    this.scoped.set(scopeKey(options), canned);
    return this;
  }

  /** Every recorded call to the named method (e.g. `costBreakdown`). */
  callsTo(method: string): RecordedSourceCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The most recently recorded call, or `undefined` if none. */
  get lastCall(): RecordedSourceCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async usageSummary(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<UsageSummary> {
    return this.resolve('usageSummary', viewer, period, options).usage;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async costBreakdown(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<CostBreakdown> {
    return this.resolve('costBreakdown', viewer, period, options).cost;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async performance(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<PerformanceSummary> {
    return this.resolve('performance', viewer, period, options).performance;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async agentMetrics(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<AgentSummary> {
    return this.resolve('agentMetrics', viewer, period, options).agent;
  }

  /** Record the call and pick the canned set for its scope (the per-scope override or the base). */
  private resolve(
    method: string,
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions,
  ): CannedAnalytics {
    this.calls.push({ method, viewer: { ...viewer }, period: { ...period }, options });
    return this.scoped.get(scopeKey(options)) ?? this.base;
  }
}

/**
 * A canned {@link SecurityAuditSource} that returns fixed rows and records every
 * call with the scope it carried (Req 32.2, 32.3).
 */
export class FakeSecurityAuditSource implements SecurityAuditSource {
  /** Every call made on this source, in order, with the scope it carried. */
  readonly calls: RecordedSourceCall[] = [];
  private rows: SecurityAuditRow[];

  constructor(rows: SecurityAuditRow[] = makeSecurityAuditRows()) {
    this.rows = rows;
  }

  /** Replace the canned rows returned. */
  setRows(rows: SecurityAuditRow[]): this {
    this.rows = rows;
    return this;
  }

  /** The most recently recorded call, or `undefined` if none. */
  get lastCall(): RecordedSourceCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async recentEvents(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<SecurityAuditRow[]> {
    this.calls.push({
      method: 'recentEvents',
      viewer: { ...viewer },
      period: { ...period },
      options,
    });
    return this.rows.map((row) => ({ ...row }));
  }
}

/**
 * A canned {@link KnowledgeHealthSource} that returns fixed stats and records
 * every call with the scope it carried (Req 32.2, 32.3).
 */
export class FakeKnowledgeHealthSource implements KnowledgeHealthSource {
  /** Every call made on this source, in order, with the scope it carried. */
  readonly calls: RecordedSourceCall[] = [];
  private stats: KnowledgeHealthStats;

  constructor(stats: KnowledgeHealthStats = makeKnowledgeHealthStats()) {
    this.stats = stats;
  }

  /** Replace the canned stats returned. */
  setStats(stats: KnowledgeHealthStats): this {
    this.stats = stats;
    return this;
  }

  /** The most recently recorded call, or `undefined` if none. */
  get lastCall(): RecordedSourceCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async knowledgeHealth(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions = {},
  ): Promise<KnowledgeHealthStats> {
    this.calls.push({
      method: 'knowledgeHealth',
      viewer: { ...viewer },
      period: { ...period },
      options,
    });
    return { ...this.stats };
  }
}

/**
 * A deterministic {@link ReportRenderer} that emits a stable UTF-8 text-bytes
 * representation of the document — a `%PDF-`-prefixed text envelope embedding the
 * title, generated-at instant, and a dump of every section — so the PDF path is
 * exercised without a real PDF engine, and the output is byte-for-byte
 * reproducible for the same {@link ReportDocument}.
 *
 * Every document it renders is recorded in {@link rendered} so a test can assert
 * the PDF path routed through the renderer.
 */
export class TextReportRenderer implements ReportRenderer {
  /** Every document handed to {@link renderPdf}, in order. */
  readonly rendered: ReportDocument[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- deterministic fake
  async renderPdf(document: ReportDocument): Promise<Uint8Array> {
    this.rendered.push(document);
    return new TextEncoder().encode(renderDocumentText(document));
  }
}

/** The stable text representation {@link TextReportRenderer} encodes (also useful in assertions). */
export function renderDocumentText(document: ReportDocument): string {
  const lines: string[] = [
    '%PDF-1.4 (text representation)',
    `Title: ${document.title}`,
    `Type: ${document.type}`,
    `Generated: ${document.generatedAt}`,
    `Organization: ${document.organizationId}`,
  ];
  for (const section of document.sections) {
    lines.push('');
    lines.push(`# ${section.heading}`);
    lines.push(section.columns.join(' | '));
    for (const row of section.rows) {
      lines.push(row.map((cell) => String(cell)).join(' | '));
    }
  }
  lines.push('%%EOF');
  return lines.join('\n');
}

/**
 * A {@link ScopeAuthorizer} that returns a fixed {@link AnalyticsScope} per
 * viewer, so a test can model an Organization-wide or a Team/Project-scoped
 * administrator (Req 32.3).
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

/**
 * A hand-advanceable {@link ReportClock}: fix "now" at construction, then
 * {@link advance} it or {@link set} an absolute instant, so the generated-at
 * instant (and therefore the filename) is deterministic.
 */
export class MutableReportClock implements ReportClock {
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

/** Build a default list of {@link SecurityAuditRow}s; override by passing your own. */
export function makeSecurityAuditRows(): SecurityAuditRow[] {
  return [
    {
      timestamp: '2026-01-01T08:00:00.000Z',
      actor: 'user-1',
      action: 'access.granted',
      resourceType: 'model',
      resourceId: 'gpt-premium',
      outcome: 'allowed',
    },
    {
      timestamp: '2026-01-01T09:30:00.000Z',
      actor: 'user-2',
      action: 'access.denied',
      resourceType: 'model',
      resourceId: 'gpt-premium',
      outcome: 'denied',
    },
    {
      timestamp: '2026-01-01T10:15:00.000Z',
      actor: 'user-1',
      action: 'api_key.create',
      resourceType: 'api_key',
      resourceId: 'key-7',
      outcome: 'allowed',
    },
  ];
}

/** Build default {@link KnowledgeHealthStats}; override field-by-field. */
export function makeKnowledgeHealthStats(
  overrides: Partial<KnowledgeHealthStats> = {},
): KnowledgeHealthStats {
  return {
    collectionCount: 5,
    sourceCount: 12,
    documentCount: 340,
    staleCount: 8,
    duplicateCount: 2,
    ...overrides,
  };
}

/** Build an {@link AnalyticsViewer} with sensible defaults; override field-by-field. */
export function makeReportViewer(overrides: Partial<AnalyticsViewer> = {}): AnalyticsViewer {
  return {
    userId: 'admin-1',
    organizationId: 'org-1',
    ...overrides,
  };
}

/** A stable string key for a scope narrowing, used to register per-scope canned data. */
function scopeKey(options: AnalyticsQueryOptions): string {
  const teamIds = options.scope?.teamIds;
  const projectIds = options.scope?.projectIds;
  return JSON.stringify({
    teamIds: teamIds === undefined ? null : [...teamIds].sort(),
    projectIds: projectIds === undefined ? null : [...projectIds].sort(),
  });
}
