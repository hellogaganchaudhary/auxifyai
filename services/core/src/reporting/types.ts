/**
 * Report_Generator domain types and injectable ports (Req 32.1-32.3).
 *
 * The Report_Generator produces a downloadable platform report — in PDF or CSV
 * (Req 32.1) — across the seven required report types (Req 32.2), restricting
 * every report's content to the data the requesting administrator is authorized
 * to view (Req 32.3). It sits ALONGSIDE the Analytics_Service and reuses the
 * SAME authorized-scope model (Req 32.3 is the Analytics_Service's Req 31.7
 * scoping applied to exports): it resolves the requesting {@link AnalyticsViewer}'s
 * authorized {@link AnalyticsScope} through the shared {@link ScopeAuthorizer},
 * intersects it with the request's optional {@link ScopeNarrowing} (failing
 * closed on any out-of-scope Team / Project), and then pulls only
 * scope-restricted data from a handful of narrow injectable sources.
 *
 * The pipeline is deliberately two-staged so a new format never touches the
 * per-report assembly:
 *
 *   1. assemble a structured, FORMAT-AGNOSTIC {@link ReportDocument} — a title,
 *      the generated-at instant, the resolved {@link AnalyticsScope}, and an
 *      ordered list of {@link ReportSection} tables — from the scope-restricted
 *      sources;
 *   2. SERIALIZE that document to the requested {@link ReportFormat}: CSV is
 *      produced purely in-module (`./csv.js`, RFC-4180 quoting), while PDF is
 *      delegated to the injectable {@link ReportRenderer} port (no PDF engine is
 *      bundled in `@auxify/core`).
 *
 * Everything the generator cannot do purely is a narrow injectable port so it
 * stays pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`:
 *
 *   - the {@link ScopeAuthorizer} (reused from the Analytics_Service) — resolves
 *     the Organization, Teams, and Projects the viewer may view (Req 32.3);
 *   - the {@link AnalyticsDataSource} — the scope-restricted usage / cost /
 *     performance / agent summaries the cost / usage / performance reports draw
 *     from. It mirrors the Analytics_Service's read surface, so production can
 *     pass the real {@link import('../analytics/index.js').AnalyticsService}
 *     directly;
 *   - the {@link SecurityAuditSource} — the authorized recent audit rows the
 *     security_audit report renders (production wraps the Audit_Service query);
 *   - the {@link KnowledgeHealthSource} — the source / document counts and
 *     staleness the knowledge_base_health report renders;
 *   - the {@link ReportRenderer} — the PDF rendering seam (production wires a
 *     real PDF engine; tests substitute a deterministic text-bytes renderer);
 *   - a {@link ReportClock} — so the generated-at instant (and therefore the
 *     filename) is deterministic in tests.
 */

import type {
  AnalyticsPeriod,
  AnalyticsQueryOptions,
  AnalyticsScope,
  AnalyticsViewer,
  AgentSummary,
  CostBreakdown,
  PerformanceSummary,
  ScopeAuthorizer,
  ScopeNarrowing,
  UsageSummary,
} from '../analytics/index.js';

// Re-export the analytics scope model these types build on, so a consumer of the
// reporting module gets the shared authorized-scope vocabulary from one place.
export type {
  AnalyticsPeriod,
  AnalyticsQueryOptions,
  AnalyticsScope,
  AnalyticsViewer,
  ScopeAuthorizer,
  ScopeNarrowing,
} from '../analytics/index.js';

/**
 * The downloadable format a report is produced in (Req 32.1).
 *
 * `pdf` is rendered through the injectable {@link ReportRenderer} port; `csv` is
 * produced purely in-module (`./csv.js`) as RFC-4180 comma-separated values.
 */
export type ReportFormat = 'pdf' | 'csv';

/** All {@link ReportFormat} values, for iteration, validation, and test generators. */
export const REPORT_FORMATS: readonly ReportFormat[] = ['pdf', 'csv'] as const;

/** Narrow runtime guard that a value is a supported {@link ReportFormat} (fail-closed, Req 32.1). */
export function isReportFormat(value: unknown): value is ReportFormat {
  return typeof value === 'string' && (REPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * The kind of report the generator produces (Req 32.2).
 *
 * Exactly the seven required types: an `executive_summary` (the headline usage /
 * cost / performance digest), a `cost_report` (cost grouped by model, Team,
 * Project, and user), a `team_usage` and a `project_usage` report, a
 * `model_performance` report, a `security_audit` report, and a
 * `knowledge_base_health` report.
 */
export type ReportType =
  | 'executive_summary'
  | 'cost_report'
  | 'team_usage'
  | 'project_usage'
  | 'model_performance'
  | 'security_audit'
  | 'knowledge_base_health';

/** All {@link ReportType} values (the seven required types), for iteration and validation (Req 32.2). */
export const REPORT_TYPES: readonly ReportType[] = [
  'executive_summary',
  'cost_report',
  'team_usage',
  'project_usage',
  'model_performance',
  'security_audit',
  'knowledge_base_health',
] as const;

/** Narrow runtime guard that a value is a supported {@link ReportType} (fail-closed, Req 32.2). */
export function isReportType(value: unknown): value is ReportType {
  return typeof value === 'string' && (REPORT_TYPES as readonly string[]).includes(value);
}

/**
 * A request to export a report (Req 32.1, 32.2, 32.3).
 *
 * Names the {@link type} and {@link format} to produce, the {@link period} the
 * report covers, and an optional {@link scope} narrowing the report to a subset
 * of the viewer's authorized Teams / Projects. The narrowing is intersected with
 * the viewer's authorized scope, so it can never widen the view; an out-of-scope
 * narrowing fails closed (Req 32.3).
 */
export interface ReportRequest {
  /** The report to produce (Req 32.2). */
  type: ReportType;
  /** The format to produce it in (Req 32.1). */
  format: ReportFormat;
  /** The time window the report covers. */
  period: AnalyticsPeriod;
  /** An optional narrowing to a subset of the viewer's authorized Teams / Projects (Req 32.3). */
  scope?: ScopeNarrowing;
}

/**
 * One assembled, format-agnostic report section (Req 32.2).
 *
 * A titled table of named {@link columns} and {@link rows} of string / number
 * cells. Both serializers consume it: the CSV serializer emits the columns then
 * the rows, and the {@link ReportRenderer} lays the heading, columns, and rows
 * out on the page. Keeping reports as tables at the data layer means the
 * per-report assembly never has to know which format is being produced.
 */
export interface ReportSection {
  /** The section's human-readable heading. */
  heading: string;
  /** The column headers, left to right. */
  columns: string[];
  /** The data rows; each is one cell per column. */
  rows: (string | number)[][];
}

/**
 * The structured, format-agnostic assembled report a serializer turns into bytes
 * (Req 32.2, 32.3).
 *
 * Carries the report's {@link type} and overall {@link title}, the
 * {@link generatedAt} instant (an ISO-8601 string from the {@link ReportClock}),
 * the {@link organizationId} the report belongs to, the resolved
 * {@link AnalyticsScope} the content was restricted to (so the report records
 * exactly what authorized view it represents, Req 32.3), and its ordered
 * {@link sections}.
 */
export interface ReportDocument {
  /** The report type that was assembled (Req 32.2). */
  type: ReportType;
  /** The report's overall title. */
  title: string;
  /** The ISO-8601 instant the report was generated (from the clock). */
  generatedAt: string;
  /** The Organization the report belongs to (its tenant scope, Req 1.4). */
  organizationId: string;
  /** The resolved authorized scope the report's content was restricted to (Req 32.3). */
  scope: AnalyticsScope;
  /** The ordered table sections that make up the report body. */
  sections: ReportSection[];
}

/**
 * A produced, downloadable report artifact (Req 32.1).
 *
 * The {@link bytes} are the rendered PDF or CSV payload; {@link contentType} is
 * `application/pdf` or `text/csv`; {@link filename} carries the matching
 * extension.
 */
export interface GeneratedReport {
  /** The report type that was produced (Req 32.2). */
  type: ReportType;
  /** The format that was produced (Req 32.1). */
  format: ReportFormat;
  /** A suggested download filename, with the format's extension. */
  filename: string;
  /** The MIME content type — `application/pdf` or `text/csv` (Req 32.1). */
  contentType: string;
  /** The rendered report payload. */
  bytes: Uint8Array;
}

/**
 * The scope-restricted analytics summaries the cost / usage / performance
 * reports draw from (Req 32.3, reusing Req 31.2-31.7).
 *
 * This port mirrors the Analytics_Service's read surface — same method names and
 * signatures — so a production wiring can pass the real
 * {@link import('../analytics/index.js').AnalyticsService} directly as this
 * source, inheriting its authorized-scope restriction (Req 31.7) for free, while
 * a unit test substitutes the canned-summary
 * {@link import('./fakes.js').FakeAnalyticsDataSource}. Every method takes the
 * requesting {@link AnalyticsViewer} and the optional {@link AnalyticsQueryOptions}
 * narrowing, so the generator never fetches data outside the viewer's authorized
 * scope (Req 32.3).
 */
export interface AnalyticsDataSource {
  /** The authorized usage summary for the period (Req 31.2). */
  usageSummary(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options?: AnalyticsQueryOptions,
  ): Promise<UsageSummary>;
  /** The authorized cost breakdown for the period (Req 31.3). */
  costBreakdown(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options?: AnalyticsQueryOptions,
  ): Promise<CostBreakdown>;
  /** The authorized performance summary for the period (Req 31.4). */
  performance(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options?: AnalyticsQueryOptions,
  ): Promise<PerformanceSummary>;
  /** The authorized agent summary for the period (Req 31.5). */
  agentMetrics(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options?: AnalyticsQueryOptions,
  ): Promise<AgentSummary>;
}

/**
 * One authorized recent audit event row the security_audit report renders
 * (Req 32.2, 32.3).
 *
 * A flattened, secret-free projection of an Audit_Service event: when it
 * happened, who the actor was, the action, the resource it touched, and the
 * outcome. The {@link SecurityAuditSource} confines the rows to the viewer's
 * authorized scope.
 */
export interface SecurityAuditRow {
  /** The ISO-8601 instant the event occurred. */
  timestamp: string;
  /** The actor (user id) that performed the action. */
  actor: string;
  /** The audited action, e.g. `access.denied`. */
  action: string;
  /** The kind of resource the action targeted, e.g. `model`. */
  resourceType: string;
  /** The id of the resource the action targeted. */
  resourceId: string;
  /** The event outcome, e.g. `allowed` or `denied`. */
  outcome: string;
}

/**
 * The seam that resolves the authorized {@link SecurityAuditRow}s for a report
 * (Req 32.2, 32.3).
 *
 * A narrow port over the Audit_Service: production wraps the Audit_Service query
 * and restricts it to the viewer's authorized scope; a test substitutes the
 * in-memory {@link import('./fakes.js').FakeSecurityAuditSource}. Takes the
 * requesting {@link AnalyticsViewer} and the optional scope narrowing so the
 * rows are confined to the data the administrator is authorized to view
 * (Req 32.3).
 */
export interface SecurityAuditSource {
  /** The authorized recent audit rows for the period within the viewer's scope. */
  recentEvents(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options?: AnalyticsQueryOptions,
  ): Promise<SecurityAuditRow[]>;
}

/**
 * The authorized knowledge-base health statistics the knowledge_base_health
 * report renders (Req 32.2, 32.3).
 *
 * The collection / source / document counts plus the stale and duplicate counts
 * that signal the health of the knowledge base the administrator is authorized
 * to view.
 */
export interface KnowledgeHealthStats {
  /** The number of knowledge collections in scope. */
  collectionCount: number;
  /** The number of connected sources in scope. */
  sourceCount: number;
  /** The number of indexed documents in scope. */
  documentCount: number;
  /** The number of documents whose content is stale (out of date). */
  staleCount: number;
  /** The number of documents detected as duplicates. */
  duplicateCount: number;
}

/**
 * The seam that resolves the {@link KnowledgeHealthStats} for a report
 * (Req 32.2, 32.3).
 *
 * Takes the requesting {@link AnalyticsViewer} and the optional scope narrowing
 * so the statistics are confined to the data the administrator is authorized to
 * view (Req 32.3).
 */
export interface KnowledgeHealthSource {
  /** The authorized knowledge-base health statistics for the period. */
  knowledgeHealth(
    viewer: AnalyticsViewer,
    period: AnalyticsPeriod,
    options?: AnalyticsQueryOptions,
  ): Promise<KnowledgeHealthStats>;
}

/**
 * A rendered PDF payload returned by the {@link ReportRenderer}.
 *
 * A renderer may return raw {@link bytes} directly, or this download-ref-like
 * wrapper carrying the bytes plus an optional overriding {@link contentType} and
 * {@link filename}. The generator extracts the bytes and prefers the wrapper's
 * content type / filename when present.
 */
export interface RenderedReportFile {
  /** The rendered PDF payload. */
  bytes: Uint8Array;
  /** An optional content type overriding the default `application/pdf`. */
  contentType?: string;
  /** An optional suggested download filename overriding the generator's default. */
  filename?: string;
}

/**
 * The injectable PDF rendering seam (Req 32.1).
 *
 * No PDF engine is bundled in `@auxify/core`, so PDF rendering is modelled as a
 * narrow port: the generator assembles the format-agnostic {@link ReportDocument}
 * and hands it to {@link renderPdf}, which lays it out and returns the PDF bytes
 * (or a {@link RenderedReportFile} wrapper). Production wires a real PDF engine;
 * tests substitute the deterministic {@link import('./fakes.js').TextReportRenderer}
 * that emits a stable text-bytes representation so the suite runs without a PDF
 * dependency.
 */
export interface ReportRenderer {
  /**
   * Render an assembled report document to PDF bytes (Req 32.1).
   *
   * @param document The format-agnostic assembled report.
   * @returns The rendered PDF payload, as raw bytes or a {@link RenderedReportFile}.
   */
  renderPdf(document: ReportDocument): Promise<Uint8Array | RenderedReportFile>;
}

/**
 * The injectable clock the generator reads to stamp the generated-at instant
 * (Req 32.1).
 *
 * Injectable so unit tests get a deterministic generated-at instant (and
 * therefore a deterministic filename). Named {@link ReportClock} (not `Clock`)
 * so it never collides with the Model_Router's, Scheduler's, Cache_Manager's,
 * Budget_Manager's, Analytics_Service's, or Backup_Service's identically-purposed
 * clocks in the shared `@auxify/core` barrel.
 */
export interface ReportClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link ReportClock}, backed by the global `Date.now`. */
export const systemReportClock: ReportClock = { now: () => Date.now() };
