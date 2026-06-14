import { describe, expect, it } from 'vitest';

import {
  buildBundleEntries,
  extractMarkdownTables,
  sourcesToCsv,
  tableToBarChartSvg,
} from './research-bundle';

const REPORT = `# Market Report

Intro text.

## Revenue by region

| Region | Revenue ($M) | Growth |
| --- | --- | --- |
| North | 4.2 | 12% |
| South | 3.1 | 8% |
| West | 5.6 | 21% |

Some closing prose.
`;

describe('extractMarkdownTables', () => {
  it('parses a GFM table into header + rows', () => {
    const tables = extractMarkdownTables(REPORT);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.header).toEqual(['Region', 'Revenue ($M)', 'Growth']);
    expect(tables[0]?.rows).toHaveLength(3);
    expect(tables[0]?.rows[0]).toEqual(['North', '4.2', '12%']);
  });

  it('returns nothing when there is no table', () => {
    expect(extractMarkdownTables('just prose, no tables')).toHaveLength(0);
  });
});

describe('tableToBarChartSvg', () => {
  it('renders an SVG bar chart from the first numeric column', () => {
    const table = extractMarkdownTables(REPORT)[0]!;
    const svg = tableToBarChartSvg(table, 'Figure 1');
    expect(svg).not.toBeNull();
    expect(svg!.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<rect'); // bars present
    expect(svg).toContain('North');
  });

  it('returns null for a table with no numeric column', () => {
    const svg = tableToBarChartSvg({ header: ['A', 'B'], rows: [['x', 'y']] }, 'T');
    expect(svg).toBeNull();
  });
});

describe('sourcesToCsv', () => {
  it('escapes commas and quotes', () => {
    const csv = sourcesToCsv([{ index: 1, title: 'A, B', url: 'http://x', snippet: 'he said "hi"' }]);
    expect(csv).toContain('"A, B"');
    expect(csv).toContain('"he said ""hi"""');
  });
});

describe('buildBundleEntries', () => {
  it('assembles report, charts, sources, and a manifest', () => {
    const entries = buildBundleEntries({
      title: 'Market Report',
      reportMarkdown: REPORT,
      sources: [{ index: 1, title: 'Src', url: 'http://x' }],
      files: [{ name: 'report.pdf', base64: 'AAAA' }],
    });
    const names = entries.map((e) => e.name);
    expect(names).toContain('report.md');
    expect(names).toContain('report.pdf');
    expect(names).toContain('charts/figure-1.svg');
    expect(names).toContain('sources/sources.csv');
    expect(names).toContain('README.txt');
  });
});
