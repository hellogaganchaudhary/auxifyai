/**
 * The Report_Generator (Req 32.1-32.3).
 *
 * Produces a downloadable report — in PDF or CSV (Req 32.1) — across the seven
 * required report types (Req 32.2), restricting every report's content to the
 * data the requesting administrator is authorized to view (Req 32.3). It sits
 * ALONGSIDE the Analytics_Service and reuses the SAME authorized-scope model:
 * {@link ReportGenerator.generate} resolves the requesting {@link AnalyticsViewer}'s
 * authorized {@link AnalyticsScope} through the injectable {@link ScopeAuthorizer},
 * intersects it with the request's optional {@link ScopeNarrowing} (failing
 * closed with an {@link UnauthorizedReportScopeError} on any out-of-scope Team /
 * Project — the same fail-closed behaviour the Analytics_Service enforces under
 * Req 31.7), assembles a structured, format-agnostic {@link ReportDocument} from
 * the scope-restricted sources, then SERIALIZES it to the requested format: CSV
 * purely in-module (`./csv.js`), PDF through the injectable {@link ReportRenderer}
 * port (no PDF engine is bundled).
 *
 * The authorized-scope restriction (Req 32.3) is structural, not incidental:
 * EVERY data fetch for a report passes the requesting viewer plus the request's
 * effective scope narrowing to a scope-restricted source, and the generator has
 * no path that reads data without a viewer, so a report can never include data
 * outside the viewer's authorized Organization, Teams, and Projects.
 *
 * It is pure orchestration over its injectable ports — an
 * {@link AnalyticsDataSource} (the scope-restricted usage / cost / performance /
 * agent summaries, satisfiable by the real
 * {@link import('../analytics/index.js').AnalyticsService}), an optional
 * {@link SecurityAuditSource}, an optional {@link KnowledgeHealthSource}, the
 * {@link ReportRenderer}, an optional {@link ScopeAuthorizer}, and an optional
 * {@link ReportClock} — so it is fully unit-testable with the in-memory fakes in
 * `./fakes.js`.
 */

import type {
  AgentSummary,
  AnalyticsPeriod,
  AnalyticsQueryOptions,
  AnalyticsScope,
  AnalyticsViewer,
  CostGroup,
  PerformanceSummary,
  ScopeAuthorizer,
  ScopeNarrowing,
  UsageSummary,
} from '../analytics/index.js';
import { toCsvBytes } from './csv.js';
import {
  ReportSourceUnavailableError,
  UnauthorizedReportScopeError,
  UnsupportedReportError,
} from './errors.js';
import {
  isReportFormat,
  isReportType,
  systemReportClock,
  type AnalyticsDataSource,
  type GeneratedReport,
  type KnowledgeHealthSource,
  type KnowledgeHealthStats,
  type RenderedReportFile,
  type ReportClock,
  type ReportDocument,
  type ReportFormat,
  type ReportRenderer,
  type ReportRequest,
  type ReportSection,
  type ReportType,
  type SecurityAuditRow,
  type SecurityAuditSource,
} from './types.js';

/** The MIME content type for each {@link ReportFormat} (Req 32.1). */
const CONTENT_TYPES: Readonly<Record<ReportFormat, string>> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
};

/** The download filename extension for each {@link ReportFormat}. */
const FILE_EXTENSIONS: Readonly<Record<ReportFormat, string>> = {
  pdf: 'pdf',
  csv: 'csv',
};

/** The human-readable overall title for each {@link ReportType} (Req 32.2). */
const REPORT_TITLES: Readonly<Record<ReportType, string>> = {
  executive_summary: 'Executive Summary',
  cost_report: 'Cost Report',
  team_usage: 'Team Usage Report',
  project_usage: 'Project Usage Report',
  model_performance: 'Model Performance Report',
  security_audit: 'Security Audit Report',
  knowledge_base_health: 'Knowledge Base Health Report',
};

/** Construction options for the {@link ReportGenerator}. */
export interface ReportGeneratorOptions {
  /**
   * The scope-restricted analytics summaries the cost / usage / performance /
   * agent reports draw from (Req 31.2-31.7). The real
   * {@link import('../analytics/index.js').AnalyticsService} satisfies this port
   * directly.
   */
  analytics: AnalyticsDataSource;
  /**
   * The authorized recent-audit-row source for the security_audit report
   * (Req 32.2). Optional: when omitted, requesting a security_audit report fails
   * closed with a {@link ReportSourceUnavailableError}.
   */
  securityAudit?: SecurityAuditSource;
  /**
   * The authorized knowledge-base health source for the knowledge_base_health
   * report (Req 32.2). Optional: when omitted, requesting a
   * knowledge_base_health report fails closed with a
   * {@link ReportSourceUnavailableError}.
   */
  knowledgeHealth?: KnowledgeHealthSource;
  /** The injectable PDF rendering seam (Req 32.1). */
  renderer: ReportRenderer;
  /**
   * Resolves the authorized {@link AnalyticsScope} for a viewer (Req 32.3). When
   * omitted, a viewer's authorized scope defaults to their whole Organization.
   */
  scopeAuthorizer?: ScopeAuthorizer;
  /** Optional clock for the generated-at instant (defaults to {@link systemReportClock}). */
  clock?: ReportClock;
}

/**
 * The Report_Generator: resolves the viewer's authorized scope, assembles a
 * scope-restricted report document, and serializes it to the requested PDF or
 * CSV format (Req 32.1-32.3).
 */
export class ReportGenerator {
  private readonly analytics: AnalyticsDataSource;
  private readonly securityAudit: SecurityAuditSource | undefined;
  private readonly knowledgeHealth: KnowledgeHealthSource | undefined;
  private readonly renderer: ReportRenderer;
  private readonly scopeAuthorizer: ScopeAuthorizer | undefined;
  private readonly clock: ReportClock;

  constructor(options: ReportGeneratorOptions) {
    this.analytics = options.analytics;
    this.securityAudit = options.securityAudit;
    this.knowledgeHealth = options.knowledgeHealth;
    this.renderer = options.renderer;
    this.scopeAuthorizer = options.scopeAuthorizer;
    this.clock = options.clock ?? systemReportClock;
  }

  /**
   * Produce a report in the requested format, scoped to the viewer's authorized
   * data (Req 32.1, 32.2, 32.3).
   *
   * Validates the requested {@link ReportRequest.type} and
   * {@link ReportRequest.format} (failing closed with {@link UnsupportedReportError}
   * on an unsupported value), resolves the viewer's authorized
   * {@link AnalyticsScope} and intersects it with the request's optional scope
   * narrowing (failing closed with {@link UnauthorizedReportScopeError} on an
   * out-of-scope Team / Project, Req 32.3), assembles the report's
   * {@link ReportSection} sections from the scope-restricted sources into a
   * {@link ReportDocument}, then serializes it to the requested format — CSV
   * in-module, PDF through the {@link ReportRenderer} — and returns a
   * downloadable {@link GeneratedReport}.
   *
   * @param viewer The administrator requesting the export (their authorized
   *   scope bounds the report's content, Req 32.3).
   * @param request The report type, format, period, and optional scope narrowing.
   * @returns The rendered, downloadable report artifact.
   * @throws {UnsupportedReportError} If the type or format is not supported.
   * @throws {UnauthorizedReportScopeError} If the request narrows to an unauthorized Team / Project.
   * @throws {ReportSourceUnavailableError} If the report type's data source is not configured.
   */
  async generate(viewer: AnalyticsViewer, request: ReportRequest): Promise<GeneratedReport> {
    if (!isReportType(request.type)) {
      throw new UnsupportedReportError('type', String(request.type));
    }
    if (!isReportFormat(request.format)) {
      throw new UnsupportedReportError('format', String(request.format));
    }

    // Resolve and pin the authorized scope up front (Req 32.3): an out-of-scope
    // narrowing fails closed here, before any data is fetched.
    const scope = await this.resolveScope(viewer, request.scope);
    const options: AnalyticsQueryOptions =
      request.scope !== undefined ? { scope: request.scope } : {};

    const sections = await this.buildSections(request.type, viewer, request.period, options);

    const document: ReportDocument = {
      type: request.type,
      title: REPORT_TITLES[request.type],
      generatedAt: new Date(this.clock.now()).toISOString(),
      organizationId: scope.organizationId,
      scope,
      sections,
    };

    return request.format === 'pdf' ? this.renderToPdf(document) : this.renderToCsv(document);
  }

  // --- serialization (Req 32.1) -----------------------------------------

  /** Serialize the document to CSV purely in-module (Req 32.1). */
  private renderToCsv(document: ReportDocument): GeneratedReport {
    return {
      type: document.type,
      format: 'csv',
      filename: this.filenameFor(document, 'csv'),
      contentType: CONTENT_TYPES.csv,
      bytes: toCsvBytes(document),
    };
  }

  /** Serialize the document to PDF through the injectable {@link ReportRenderer} (Req 32.1). */
  private async renderToPdf(document: ReportDocument): Promise<GeneratedReport> {
    const rendered = await this.renderer.renderPdf(document);
    const file = normalizeRendered(rendered);
    return {
      type: document.type,
      format: 'pdf',
      filename: file.filename ?? this.filenameFor(document, 'pdf'),
      contentType: file.contentType ?? CONTENT_TYPES.pdf,
      bytes: file.bytes,
    };
  }

  // --- scope resolution (Req 32.3) --------------------------------------

  /**
   * Resolve the viewer's authorized scope and intersect it with an optional
   * requested narrowing, failing closed if the narrowing names an unauthorized
   * Team or Project (Req 32.3). Mirrors the Analytics_Service's scope-deny
   * behaviour (Req 31.7) so reports and analytics share one authorization model.
   */
  private async resolveScope(
    viewer: AnalyticsViewer,
    narrowing: ScopeNarrowing | undefined,
  ): Promise<AnalyticsScope> {
    const authorized: AnalyticsScope =
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
          throw new UnauthorizedReportScopeError('team', teamId);
        }
      }
      effective.teamIds = [...narrowing.teamIds];
    } else if (authorized.teamIds !== undefined) {
      effective.teamIds = [...authorized.teamIds];
    }

    if (narrowing.projectIds !== undefined) {
      for (const projectId of narrowing.projectIds) {
        if (!isAuthorized(authorized.projectIds, projectId)) {
          throw new UnauthorizedReportScopeError('project', projectId);
        }
      }
      effective.projectIds = [...narrowing.projectIds];
    } else if (authorized.projectIds !== undefined) {
      effective.projectIds = [...authorized.projectIds];
    }

    return effective;
  }

  // --- per-report assembly (every fetch is scope-restricted, Req 32.3) ----

  /** Dispatch on the report type to assemble its scope-restricted sections. */
  private async buildSections(
    type: ReportType,
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions,
  ): Promise<ReportSection[]> {
    switch (type) {
      case 'executive_summary':
        return this.executiveSummarySections(viewer, period, options);
      case 'cost_report':
        return this.costReportSections(viewer, period, options);
      case 'team_usage':
        return this.teamUsageSections(viewer, period, options);
      case 'project_usage':
        return this.projectUsageSections(viewer, period, options);
      case 'model_performance':
        return this.modelPerformanceSections(viewer, period, options);
      case 'security_audit':
        return this.securityAuditSections(viewer, period, options);
      case 'knowledge_base_health':
        return this.knowledgeHealthSections(viewer, period, options);
    }
  }

  /** The executive summary: headline usage, cost, and performance digest. */
  private async executiveSummarySections(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions,
  ): Promise<ReportSection[]> {
    const [usage, cost, performance] = await Promise.all([
      this.analytics.usageSummary(viewer, period, options),
      this.analytics.costBreakdown(viewer, period, options),
      this.analytics.performance(viewer, period, options),
    ]);
    return [
      usageSection(usage),
      costGroupSection('Top Cost by Model', 'Model', cost.byModel),
      performanceSection(performance),
    ];
  }

  /** The cost report: cost grouped by model, Team, Project, and user (Req 31.3). */
  private async costReportSections(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions,
  ): Promise<ReportSection[]> {
    const cost = await this.analytics.costBreakdown(viewer, period, options);
    return [
      costGroupSection('Cost by Model', 'Model', cost.byModel),
      costGroupSection('Cost by Team', 'Team', cost.byTeam),
      costGroupSection('Cost by Project', 'Project', cost.byProject),
      costGroupSection('Cost by User', 'User', cost.byUser),
    ];
  }

  /** The team usage report: usage totals plus cost grouped by Team. */
  private async teamUsageSections(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions,
  ): Promise<ReportSection[]> {
    const [usage, cost] = await Promise.all([
      this.analytics.usageSummary(viewer, period, options),
      this.analytics.costBreakdown(viewer, period, options),
    ]);
    return [usageSection(usage), costGroupSection('Cost by Team', 'Team', cost.byTeam)];
  }

  /** The project usage report: usage totals plus cost grouped by Project. */
  private async projectUsageSections(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions,
  ): Promise<ReportSection[]> {
    const [usage, cost] = await Promise.all([
      this.analytics.usageSummary(viewer, period, options),
      this.analytics.costBreakdown(viewer, period, options),
    ]);
    return [usageSection(usage), costGroupSection('Cost by Project', 'Project', cost.byProject)];
  }

  /** The model performance report: latency percentiles, error rate, and per-model cost. */
  private async modelPerformanceSections(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions,
  ): Promise<ReportSection[]> {
    const [performance, cost, agent] = await Promise.all([
      this.analytics.performance(viewer, period, options),
      this.analytics.costBreakdown(viewer, period, options),
      this.analytics.agentMetrics(viewer, period, options),
    ]);
    return [
      performanceSection(performance),
      costGroupSection('Cost by Model', 'Model', cost.byModel),
      agentSection(agent),
    ];
  }

  /** The security audit report: recent audit rows from the {@link SecurityAuditSource} (Req 32.2, 32.3). */
  private async securityAuditSections(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions,
  ): Promise<ReportSection[]> {
    if (this.securityAudit === undefined) {
      throw new ReportSourceUnavailableError('security_audit', 'securityAudit');
    }
    const rows = await this.securityAudit.recentEvents(viewer, period, options);
    return [securityAuditSection(rows)];
  }

  /** The knowledge base health report: stats from the {@link KnowledgeHealthSource} (Req 32.2, 32.3). */
  private async knowledgeHealthSections(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options: AnalyticsQueryOptions,
  ): Promise<ReportSection[]> {
    if (this.knowledgeHealth === undefined) {
      throw new ReportSourceUnavailableError('knowledge_base_health', 'knowledgeHealth');
    }
    const stats = await this.knowledgeHealth.knowledgeHealth(viewer, period, options);
    return [knowledgeHealthSection(stats)];
  }

  // --- internals --------------------------------------------------------

  /** A deterministic, filesystem-safe download filename for a report. */
  private filenameFor(document: ReportDocument, format: ReportFormat): string {
    const stamp = document.generatedAt.replace(/[:.]/g, '-');
    return `${document.type}-${stamp}.${FILE_EXTENSIONS[format]}`;
  }
}

/** Whether `id` is within an authorized set; an `undefined` set authorizes everything. */
function isAuthorized(authorized: readonly string[] | undefined, id: string): boolean {
  return authorized === undefined || authorized.includes(id);
}

/** Normalize a {@link ReportRenderer} result to a {@link RenderedReportFile}. */
function normalizeRendered(rendered: Uint8Array | RenderedReportFile): RenderedReportFile {
  return rendered instanceof Uint8Array ? { bytes: rendered } : rendered;
}

// --- pure section builders (format-agnostic, Req 32.2) ------------------

/** Format a USD amount to a stable 4-decimal string. */
function usd(amount: number): string {
  return amount.toFixed(4);
}

/** Format a ratio in [0, 1] as a stable 4-decimal string. */
function ratio(value: number): string {
  return value.toFixed(4);
}

/** The usage-summary section (Req 31.2). */
function usageSection(usage: UsageSummary): ReportSection {
  return {
    heading: 'Usage Summary',
    columns: ['Metric', 'Value'],
    rows: [
      ['Total Requests', usage.totalRequests],
      ['Total Input Tokens', usage.totalInputTokens],
      ['Total Output Tokens', usage.totalOutputTokens],
      ['Total Tokens', usage.totalTokens],
      ['Total Cost (USD)', usd(usage.totalCostUsd)],
      ['Active Users', usage.activeUsers],
    ],
  };
}

/** A cost-grouping section (Req 31.3). */
function costGroupSection(
  heading: string,
  keyLabel: string,
  groups: readonly CostGroup[],
): ReportSection {
  return {
    heading,
    columns: [keyLabel, 'Cost (USD)'],
    rows: groups.map((group) => [group.key, usd(group.costUsd)]),
  };
}

/** The performance-summary section (Req 31.4). */
function performanceSection(performance: PerformanceSummary): ReportSection {
  return {
    heading: 'Performance Summary',
    columns: ['Metric', 'Value'],
    rows: [
      ['Sample Count', performance.sampleCount],
      ['p50 Latency (ms)', performance.p50LatencyMs],
      ['p95 Latency (ms)', performance.p95LatencyMs],
      ['p99 Latency (ms)', performance.p99LatencyMs],
      ['Avg Time To First Token (ms)', performance.avgTimeToFirstTokenMs],
      ['Error Rate', ratio(performance.errorRate)],
    ],
  };
}

/** The agent-summary section (Req 31.5). */
function agentSection(agent: AgentSummary): ReportSection {
  return {
    heading: 'Agent Summary',
    columns: ['Metric', 'Value'],
    rows: [
      ['Run Count', agent.runCount],
      ['Avg Steps Per Run', agent.avgStepsPerRun],
      ['Success Rate', ratio(agent.successRate)],
      ['Avg Cost Per Run (USD)', usd(agent.avgCostPerRun)],
    ],
  };
}

/** The security-audit section: one row per recent audited event (Req 32.2). */
function securityAuditSection(rows: readonly SecurityAuditRow[]): ReportSection {
  return {
    heading: 'Recent Security Events',
    columns: ['Timestamp', 'Actor', 'Action', 'Resource Type', 'Resource ID', 'Outcome'],
    rows: rows.map((row) => [
      row.timestamp,
      row.actor,
      row.action,
      row.resourceType,
      row.resourceId,
      row.outcome,
    ]),
  };
}

/** The knowledge-base health section (Req 32.2). */
function knowledgeHealthSection(stats: KnowledgeHealthStats): ReportSection {
  return {
    heading: 'Knowledge Base Health',
    columns: ['Metric', 'Value'],
    rows: [
      ['Collections', stats.collectionCount],
      ['Sources', stats.sourceCount],
      ['Documents', stats.documentCount],
      ['Stale Documents', stats.staleCount],
      ['Duplicate Documents', stats.duplicateCount],
    ],
  };
}
