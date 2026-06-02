/**
 * Report_Generator typed errors (Req 32.1, 32.2, 32.3).
 *
 * These are the *rejection* errors the Report_Generator raises when an export
 * request cannot be served. Each projects into the platform-wide serializable
 * {@link PlatformError} (Req 46.8) so the same wire shape crosses the REST_API,
 * the WebSocket_Gateway, and the SDK, carrying structured, secret-free
 * `details`:
 *
 *  - {@link UnsupportedReportError} — a report was requested for a
 *    {@link ReportType} the generator does not produce, or in a
 *    {@link ReportFormat} it does not render, so it fails closed rather than
 *    emitting an empty or wrong report (Req 32.1, 32.2).
 *  - {@link UnauthorizedReportScopeError} — the request narrowed to a Team or
 *    Project outside the viewer's authorized scope, so serving it would leak
 *    data across a tenant boundary (fail-closed, Req 32.3).
 *  - {@link ReportSourceUnavailableError} — the report type's data source was
 *    not configured on the generator, so the report cannot be assembled; it
 *    fails closed rather than silently emitting an empty report.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** Which dimension of a report request was unsupported (Req 32.1, 32.2). */
export type UnsupportedReportDimension = 'type' | 'format';

/** The stable machine-readable code for an unsupported report type or format (Req 32.1, 32.2). */
export const UNSUPPORTED_REPORT_CODE = 'REPORT_UNSUPPORTED' as const;

/** The stable machine-readable code for an out-of-scope report request (Req 32.3). */
export const UNAUTHORIZED_REPORT_SCOPE_CODE = 'REPORT_SCOPE_UNAUTHORIZED' as const;

/** The stable machine-readable code for a report whose data source is not configured. */
export const REPORT_SOURCE_UNAVAILABLE_CODE = 'REPORT_SOURCE_UNAVAILABLE' as const;

/**
 * Thrown when a report is requested for a {@link ReportType} the generator does
 * not produce, or in a {@link ReportFormat} it does not render (Req 32.1, 32.2).
 *
 * The generator supports exactly the seven required report types and the two
 * formats (PDF, CSV); any other value fails closed. Categorized `validation`
 * (an unserviceable request).
 */
export class UnsupportedReportError extends Error {
  /** Which dimension was unsupported — the report `type` or the `format`. */
  readonly dimension: UnsupportedReportDimension;
  /** The requested value that is not supported. */
  readonly value: string;

  constructor(dimension: UnsupportedReportDimension, value: string) {
    super(`Unsupported report ${dimension} "${value}"`);
    this.name = 'UnsupportedReportError';
    this.dimension = dimension;
    this.value = value;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link UNSUPPORTED_REPORT_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNSUPPORTED_REPORT_CODE,
      message: this.message,
      correlationId,
      details: { dimension: this.dimension, value: this.value },
    });
  }
}

/**
 * Thrown when a report request narrows to a Team or Project outside the
 * requesting viewer's authorized scope (Req 32.3).
 *
 * The generator restricts every report to the data the administrator is
 * authorized to view; a narrowing that names an unauthorized Team / Project
 * fails closed rather than widening the view. Categorized `authorization`.
 */
export class UnauthorizedReportScopeError extends Error {
  /** The scope dimension that was violated — a `team` or a `project`. */
  readonly dimension: 'team' | 'project';
  /** The specific id the request narrowed to that fell outside the authorized scope. */
  readonly requestedId: string;

  constructor(dimension: 'team' | 'project', requestedId: string) {
    super(`Report ${dimension} "${requestedId}" is outside the authorized scope`);
    this.name = 'UnauthorizedReportScopeError';
    this.dimension = dimension;
    this.requestedId = requestedId;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `authorization`, code {@link UNAUTHORIZED_REPORT_SCOPE_CODE})
   * (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authorization',
      code: UNAUTHORIZED_REPORT_SCOPE_CODE,
      message: this.message,
      correlationId,
      details: { dimension: this.dimension, requestedId: this.requestedId },
    });
  }
}

/**
 * Thrown when a report is requested whose required data source is not configured
 * on the generator.
 *
 * For example, a `security_audit` report when no {@link SecurityAuditSource} was
 * wired, or a `knowledge_base_health` report with no {@link KnowledgeHealthSource}.
 * The generator fails closed rather than silently emitting an empty report.
 * Categorized `validation` (an unserviceable request for this deployment).
 */
export class ReportSourceUnavailableError extends Error {
  /** The report type that could not be assembled. */
  readonly reportType: string;
  /** The name of the missing source, e.g. `securityAudit`. */
  readonly source: string;

  constructor(reportType: string, source: string) {
    super(`No "${source}" data source is configured for the "${reportType}" report`);
    this.name = 'ReportSourceUnavailableError';
    this.reportType = reportType;
    this.source = source;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link REPORT_SOURCE_UNAVAILABLE_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: REPORT_SOURCE_UNAVAILABLE_CODE,
      message: this.message,
      correlationId,
      details: { reportType: this.reportType, source: this.source },
    });
  }
}
