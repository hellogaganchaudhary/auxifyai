/**
 * Report_Generator (Req 32.1-32.3): the platform's downloadable-report
 * production service.
 *
 * The {@link ReportGenerator} produces a downloadable report — in PDF or CSV
 * (Req 32.1) — across the seven required report types (Req 32.2): an
 * `executive_summary`, a `cost_report`, a `team_usage` and a `project_usage`
 * report, a `model_performance` report, a `security_audit` report, and a
 * `knowledge_base_health` report. {@link ReportGenerator.generate} resolves the
 * requesting administrator's authorized {@link AnalyticsScope} through the shared
 * {@link ScopeAuthorizer}, intersects it with the request's optional scope
 * narrowing (failing closed with an {@link UnauthorizedReportScopeError} on any
 * out-of-scope Team / Project, Req 32.3), assembles the report's
 * format-agnostic {@link ReportDocument} (its {@link ReportSection} tables) from
 * its scope-restricted sources, then serializes it to the requested
 * {@link ReportFormat} and returns a downloadable {@link GeneratedReport} (the
 * rendered `bytes`, the matching `application/pdf` / `text/csv` `contentType`,
 * and a `filename`). An unsupported type or format fails closed with the typed
 * {@link UnsupportedReportError}, and a report whose required data source is not
 * configured fails closed with a {@link ReportSourceUnavailableError}.
 *
 * It REUSES the Analytics_Service's authorized-scope model to satisfy Req 32.3
 * (the same scoping the Analytics_Service enforces under Req 31.7): every data
 * fetch passes the requesting {@link AnalyticsViewer} plus the request's optional
 * scope narrowing to a scope-restricted source, so a report can never include
 * data outside the viewer's authorized Organization, Teams, and Projects. The
 * cost / usage / performance / agent reports draw from the
 * {@link AnalyticsDataSource} — a port mirroring the Analytics_Service's read
 * surface, so the real {@link import('../analytics/index.js').AnalyticsService}
 * satisfies it directly — while the security_audit and knowledge_base_health
 * reports draw from the narrow {@link SecurityAuditSource} and
 * {@link KnowledgeHealthSource}.
 *
 * The format rendering is split by responsibility: CSV is produced PURELY
 * IN-MODULE by {@link toCsv} (RFC-4180 quoting — fields containing a comma,
 * quote, or newline are quoted and embedded quotes are doubled; CRLF line
 * endings), while PDF is delegated to the injectable {@link ReportRenderer} port
 * (NO PDF dependency is bundled in `@auxify/core`; production wires a real PDF
 * engine and tests substitute a deterministic text-bytes renderer).
 *
 * Every external capability is a narrow injectable port — the
 * {@link AnalyticsDataSource}, the optional {@link SecurityAuditSource}, the
 * optional {@link KnowledgeHealthSource}, the {@link ReportRenderer}, the
 * optional {@link ScopeAuthorizer}, and a {@link ReportClock} — so the generator
 * is pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`. Those fakes (the canned-summary sources, the deterministic
 * {@link import('./fakes.js').TextReportRenderer}, the
 * {@link import('./fakes.js').MutableReportClock}, and the builders) are
 * intentionally NOT re-exported from this barrel — following the established
 * convention, the tests import them directly from `./fakes.js`.
 *
 * The injectable clock is surfaced as {@link ReportClock} /
 * {@link systemReportClock} and the domain names are `Report`-prefixed so they
 * never collide with sibling modules' identically-purposed clocks in the shared
 * `@auxify/core` barrel. The {@link AnalyticsScope} / {@link AnalyticsViewer} /
 * {@link ScopeAuthorizer} / {@link ScopeNarrowing} / {@link AnalyticsPeriod}
 * vocabulary is IMPORTED from the Analytics_Service (it is the shared scope
 * model, not a redefinition) and re-exported here for convenience.
 */

export { ReportGenerator, type ReportGeneratorOptions } from './report-generator.js';

export { toCsv, toCsvBytes, escapeCsvField } from './csv.js';

export {
  UnsupportedReportError,
  UnauthorizedReportScopeError,
  ReportSourceUnavailableError,
  UNSUPPORTED_REPORT_CODE,
  UNAUTHORIZED_REPORT_SCOPE_CODE,
  REPORT_SOURCE_UNAVAILABLE_CODE,
  type UnsupportedReportDimension,
} from './errors.js';

export {
  systemReportClock,
  REPORT_FORMATS,
  REPORT_TYPES,
  isReportFormat,
  isReportType,
  type ReportFormat,
  type ReportType,
  type ReportRequest,
  type ReportSection,
  type ReportDocument,
  type GeneratedReport,
  type AnalyticsDataSource,
  type SecurityAuditSource,
  type SecurityAuditRow,
  type KnowledgeHealthSource,
  type KnowledgeHealthStats,
  type ReportRenderer,
  type RenderedReportFile,
  type ReportClock,
  // Re-exported analytics scope vocabulary the reporting surface builds on.
  type AnalyticsPeriod,
  type AnalyticsQueryOptions,
  type AnalyticsScope,
  type AnalyticsViewer,
  type ScopeAuthorizer,
  type ScopeNarrowing,
} from './types.js';
