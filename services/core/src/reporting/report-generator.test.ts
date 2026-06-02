/**
 * Unit tests for the Report_Generator (Req 32.1-32.3).
 *
 * These drive the REAL {@link ReportGenerator} over the in-memory fakes
 * (imported directly from `./fakes.js`, never the barrel) with a hand-fixed
 * {@link MutableReportClock} as the only source of time, covering:
 *
 *   - every one of the seven required report types (Req 32.2) generates a
 *     non-empty document with the expected sections in BOTH formats (Req 32.1);
 *   - a CSV report's content matches the scoped source data;
 *   - a PDF report routes through the injected {@link ReportRenderer} and returns
 *     its bytes with `application/pdf` (Req 32.1);
 *   - the report's content is restricted to the viewer's authorized scope
 *     (the scope narrowing reaches the scope-restricted source, Req 32.3), an
 *     out-of-scope narrowing fails closed, and a scoped viewer's report carries
 *     the smaller, scope-restricted data;
 *   - an unsupported type / format fails closed with the typed error;
 *   - a report whose data source is not configured fails closed.
 */

import { describe, expect, it } from 'vitest';

import type { AnalyticsPeriod } from '../analytics/index.js';
import {
  ReportSourceUnavailableError,
  UnauthorizedReportScopeError,
  UnsupportedReportError,
} from './errors.js';
import {
  FakeAnalyticsDataSource,
  FakeKnowledgeHealthSource,
  FakeSecurityAuditSource,
  FixedScopeAuthorizer,
  MutableReportClock,
  TextReportRenderer,
  makeCannedAnalytics,
  makeReportViewer,
} from './fakes.js';
import { ReportGenerator } from './report-generator.js';
import { REPORT_FORMATS, REPORT_TYPES, type ReportFormat, type ReportType } from './types.js';

const START = Date.UTC(2026, 0, 1, 0, 0, 0);
const PERIOD: AnalyticsPeriod = { fromMs: START, toMs: START + 7 * 24 * 60 * 60 * 1000 };

interface Harness {
  generator: ReportGenerator;
  analytics: FakeAnalyticsDataSource;
  security: FakeSecurityAuditSource;
  kb: FakeKnowledgeHealthSource;
  renderer: TextReportRenderer;
  scopes: FixedScopeAuthorizer;
  clock: MutableReportClock;
}

/** Wire the real generator over in-memory fakes with a fixed clock. */
function makeHarness(): Harness {
  const analytics = new FakeAnalyticsDataSource();
  const security = new FakeSecurityAuditSource();
  const kb = new FakeKnowledgeHealthSource();
  const renderer = new TextReportRenderer();
  const scopes = new FixedScopeAuthorizer();
  const clock = new MutableReportClock(START);
  const generator = new ReportGenerator({
    analytics,
    securityAudit: security,
    knowledgeHealth: kb,
    renderer,
    scopeAuthorizer: scopes,
    clock,
  });
  return { generator, analytics, security, kb, renderer, scopes, clock };
}

const CONTENT_TYPE: Readonly<Record<ReportFormat, string>> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
};

/** The headings every report type is expected to carry (Req 32.2). */
const EXPECTED_HEADINGS: Readonly<Record<ReportType, string[]>> = {
  executive_summary: ['Usage Summary', 'Top Cost by Model', 'Performance Summary'],
  cost_report: ['Cost by Model', 'Cost by Team', 'Cost by Project', 'Cost by User'],
  team_usage: ['Usage Summary', 'Cost by Team'],
  project_usage: ['Usage Summary', 'Cost by Project'],
  model_performance: ['Performance Summary', 'Cost by Model', 'Agent Summary'],
  security_audit: ['Recent Security Events'],
  knowledge_base_health: ['Knowledge Base Health'],
};

describe('ReportGenerator format + type coverage (Req 32.1, 32.2)', () => {
  for (const type of REPORT_TYPES) {
    for (const format of REPORT_FORMATS) {
      it(`generates the ${type} report as ${format}`, async () => {
        const h = makeHarness();
        const report = await h.generator.generate(makeReportViewer(), {
          type,
          format,
          period: PERIOD,
        });

        expect(report.type).toBe(type);
        expect(report.format).toBe(format);
        expect(report.contentType).toBe(CONTENT_TYPE[format]);
        expect(report.filename.endsWith(`.${format}`)).toBe(true);
        expect(report.bytes.byteLength).toBeGreaterThan(0);

        if (format === 'pdf') {
          // The PDF path routed through the injected renderer.
          expect(h.renderer.rendered).toHaveLength(1);
          expect(h.renderer.rendered[0]?.type).toBe(type);
        }
      });
    }
  }

  // The "non-empty document with the expected sections" check is performed on
  // the structured document (captured by the renderer), since a single-section
  // CSV report intentionally omits the heading row per the CSV convention.
  for (const type of REPORT_TYPES) {
    it(`assembles the ${type} report with exactly the expected sections (Req 32.2)`, async () => {
      const h = makeHarness();
      await h.generator.generate(makeReportViewer(), { type, format: 'pdf', period: PERIOD });

      const document = h.renderer.rendered[0];
      expect(document).toBeDefined();
      expect(document?.sections.length).toBeGreaterThan(0);
      expect(document?.sections.map((s) => s.heading)).toEqual(EXPECTED_HEADINGS[type]);
      // Every section has columns (a non-empty table shape).
      for (const section of document?.sections ?? []) {
        expect(section.columns.length).toBeGreaterThan(0);
      }
    });
  }
});

describe('ReportGenerator content (Req 32.2)', () => {
  it('renders the executive summary CSV with the scoped usage/cost/performance data', async () => {
    const h = makeHarness();
    const report = await h.generator.generate(makeReportViewer(), {
      type: 'executive_summary',
      format: 'csv',
      period: PERIOD,
    });

    const text = new TextDecoder().decode(report.bytes);
    expect(text).toContain('Usage Summary');
    expect(text).toContain('Total Requests,120');
    expect(text).toContain('Total Cost (USD),12.5000');
    expect(text).toContain('Top Cost by Model');
    expect(text).toContain('gpt-premium,8.2500');
    expect(text).toContain('Performance Summary');
    expect(text).toContain('p95 Latency (ms),880');
  });

  it('renders the cost report CSV with all four cost groupings (Req 31.3)', async () => {
    const h = makeHarness();
    const report = await h.generator.generate(makeReportViewer(), {
      type: 'cost_report',
      format: 'csv',
      period: PERIOD,
    });

    const text = new TextDecoder().decode(report.bytes);
    expect(text).toContain('Cost by Model');
    expect(text).toContain('Cost by Team');
    expect(text).toContain('Cost by Project');
    expect(text).toContain('Cost by User');
    expect(text).toContain('team-eng,9.0000');
    expect(text).toContain('project-apollo,12.5000');
  });

  it('renders the security audit report from the security source (Req 32.2)', async () => {
    const h = makeHarness();
    const report = await h.generator.generate(makeReportViewer(), {
      type: 'security_audit',
      format: 'csv',
      period: PERIOD,
    });

    const text = new TextDecoder().decode(report.bytes);
    // A single-section report serializes as plain header+rows (heading omitted
    // per the CSV convention), so assert on the column header and the rows.
    expect(text).toContain('Timestamp,Actor,Action,Resource Type,Resource ID,Outcome');
    expect(text).toContain('access.denied');
    expect(text).toContain('access.granted');
    expect(h.security.calls).toHaveLength(1);
  });

  it('renders the knowledge base health report from the KB source (Req 32.2)', async () => {
    const h = makeHarness();
    const report = await h.generator.generate(makeReportViewer(), {
      type: 'knowledge_base_health',
      format: 'csv',
      period: PERIOD,
    });

    const text = new TextDecoder().decode(report.bytes);
    expect(text).toContain('Collections,5');
    expect(text).toContain('Stale Documents,8');
    expect(text).toContain('Duplicate Documents,2');
    expect(h.kb.calls).toHaveLength(1);
  });
});

describe('ReportGenerator PDF rendering routes through the renderer (Req 32.1)', () => {
  it('returns the renderer bytes with application/pdf', async () => {
    const h = makeHarness();
    const report = await h.generator.generate(makeReportViewer(), {
      type: 'executive_summary',
      format: 'pdf',
      period: PERIOD,
    });

    expect(report.contentType).toBe('application/pdf');
    expect(h.renderer.rendered).toHaveLength(1);

    // The returned bytes are exactly what the renderer produced for the document.
    const document = h.renderer.rendered[0];
    expect(document).toBeDefined();
    const text = new TextDecoder().decode(report.bytes);
    expect(text).toContain('%PDF-');
    expect(text).toContain('Executive Summary');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('honors a RenderedReportFile wrapper from a custom renderer', async () => {
    const analytics = new FakeAnalyticsDataSource();
    const generator = new ReportGenerator({
      analytics,
      renderer: {
        // eslint-disable-next-line @typescript-eslint/require-await -- inline fake
        async renderPdf() {
          return {
            bytes: new TextEncoder().encode('wrapped'),
            contentType: 'application/pdf; charset=binary',
            filename: 'custom.pdf',
          };
        },
      },
      clock: new MutableReportClock(START),
    });

    const report = await generator.generate(makeReportViewer(), {
      type: 'cost_report',
      format: 'pdf',
      period: PERIOD,
    });

    expect(report.filename).toBe('custom.pdf');
    expect(report.contentType).toBe('application/pdf; charset=binary');
    expect(new TextDecoder().decode(report.bytes)).toBe('wrapped');
  });
});

describe('ReportGenerator authorized-scope restriction (Req 32.3)', () => {
  it('forwards the requesting viewer and scope narrowing to every data fetch', async () => {
    const h = makeHarness();
    const viewer = makeReportViewer({ userId: 'admin-7', organizationId: 'org-9' });
    h.scopes.setScope('admin-7', {
      organizationId: 'org-9',
      teamIds: ['team-eng'],
      projectIds: ['project-apollo'],
    });
    const scope = { teamIds: ['team-eng'], projectIds: ['project-apollo'] };

    const report = await h.generator.generate(viewer, {
      type: 'executive_summary',
      format: 'csv',
      period: PERIOD,
      scope,
    });

    expect(h.analytics.calls.length).toBeGreaterThan(0);
    for (const call of h.analytics.calls) {
      expect(call.viewer.userId).toBe('admin-7');
      expect(call.viewer.organizationId).toBe('org-9');
      // The scope narrowing reaches the scope-restricted source (Req 32.3).
      expect(call.options.scope).toEqual(scope);
    }
    expect(report.type).toBe('executive_summary');
  });

  it('omits the scope option entirely when the request carries no narrowing', async () => {
    const h = makeHarness();
    await h.generator.generate(makeReportViewer(), {
      type: 'cost_report',
      format: 'csv',
      period: PERIOD,
    });

    for (const call of h.analytics.calls) {
      expect(call.options.scope).toBeUndefined();
    }
  });

  it('fails closed when the request narrows to an unauthorized team (Req 32.3)', async () => {
    const h = makeHarness();
    // The viewer is authorized for team-eng only.
    h.scopes.setScope('admin-1', { organizationId: 'org-1', teamIds: ['team-eng'] });

    await expect(
      h.generator.generate(makeReportViewer(), {
        type: 'cost_report',
        format: 'csv',
        period: PERIOD,
        scope: { teamIds: ['team-secret'] },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedReportScopeError);

    // Fail-closed: no data was fetched.
    expect(h.analytics.calls).toHaveLength(0);
  });

  it('a scoped viewer receives the smaller, scope-restricted data', async () => {
    const h = makeHarness();
    const scope = { teamIds: ['team-eng'] };
    h.scopes.setScope('admin-1', { organizationId: 'org-1', teamIds: ['team-eng'] });
    // The scope-restricted source returns LESS data for the narrowed scope.
    h.analytics.setScopedAnalytics(
      { scope },
      makeCannedAnalytics({
        cost: {
          byModel: [{ key: 'gpt-economy', costUsd: 1.0 }],
          byTeam: [{ key: 'team-eng', costUsd: 1.0 }],
          byProject: [{ key: 'project-apollo', costUsd: 1.0 }],
          byUser: [{ key: 'user-1', costUsd: 1.0 }],
        },
      }),
    );

    const scoped = await h.generator.generate(makeReportViewer(), {
      type: 'cost_report',
      format: 'csv',
      period: PERIOD,
      scope,
    });
    const unscoped = await h.generator.generate(makeReportViewer(), {
      type: 'cost_report',
      format: 'csv',
      period: PERIOD,
    });

    const scopedText = new TextDecoder().decode(scoped.bytes);
    const unscopedText = new TextDecoder().decode(unscoped.bytes);

    expect(scopedText).toContain('team-eng,1.0000');
    expect(scopedText).not.toContain('team-sales');
    expect(unscopedText).toContain('team-sales,3.5000');
  });

  it('records the resolved scope on the assembled document (Req 32.3)', async () => {
    const h = makeHarness();
    h.scopes.setScope('admin-1', { organizationId: 'org-1', teamIds: ['team-eng'] });

    await h.generator.generate(makeReportViewer(), {
      type: 'executive_summary',
      format: 'pdf',
      period: PERIOD,
    });

    const document = h.renderer.rendered[0];
    expect(document?.organizationId).toBe('org-1');
    expect(document?.scope.teamIds).toEqual(['team-eng']);
  });
});

describe('ReportGenerator fail-closed validation (Req 32.1, 32.2)', () => {
  it('throws UnsupportedReportError for an unknown report type', async () => {
    const h = makeHarness();
    await expect(
      h.generator.generate(makeReportViewer(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard
        type: 'not_a_report' as any,
        format: 'csv',
        period: PERIOD,
      }),
    ).rejects.toBeInstanceOf(UnsupportedReportError);
  });

  it('throws UnsupportedReportError for an unknown format', async () => {
    const h = makeHarness();
    await expect(
      h.generator.generate(makeReportViewer(), {
        type: 'executive_summary',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exercising the runtime guard
        format: 'xlsx' as any,
        period: PERIOD,
      }),
    ).rejects.toBeInstanceOf(UnsupportedReportError);
  });

  it('fails closed when a report type lacks its configured data source', async () => {
    const analytics = new FakeAnalyticsDataSource();
    // No securityAudit / knowledgeHealth source wired.
    const generator = new ReportGenerator({
      analytics,
      renderer: new TextReportRenderer(),
      clock: new MutableReportClock(START),
    });

    await expect(
      generator.generate(makeReportViewer(), {
        type: 'security_audit',
        format: 'csv',
        period: PERIOD,
      }),
    ).rejects.toBeInstanceOf(ReportSourceUnavailableError);

    await expect(
      generator.generate(makeReportViewer(), {
        type: 'knowledge_base_health',
        format: 'csv',
        period: PERIOD,
      }),
    ).rejects.toBeInstanceOf(ReportSourceUnavailableError);
  });

  it('projects the unsupported-report error into a serializable PlatformError (Req 46.8)', () => {
    const error = new UnsupportedReportError('type', 'not_a_report');
    const platform = error.toPlatformError('corr-1');
    expect(platform.category).toBe('validation');
    expect(platform.code).toBe('REPORT_UNSUPPORTED');
    expect(platform.details).toEqual({ dimension: 'type', value: 'not_a_report' });
  });

  it('projects the unauthorized-scope error into a serializable PlatformError (Req 46.8)', () => {
    const error = new UnauthorizedReportScopeError('team', 'team-secret');
    const platform = error.toPlatformError('corr-2');
    expect(platform.category).toBe('authorization');
    expect(platform.code).toBe('REPORT_SCOPE_UNAUTHORIZED');
    expect(platform.details).toEqual({ dimension: 'team', requestedId: 'team-secret' });
  });
});
