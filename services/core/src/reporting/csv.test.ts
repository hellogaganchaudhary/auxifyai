/**
 * Unit tests for the pure CSV serializer (Req 32.1).
 *
 * These exercise {@link toCsv} / {@link escapeCsvField} / {@link toCsvBytes}
 * directly, covering:
 *   - a single section serializes as a header row plus data rows;
 *   - fields containing a comma, a double-quote, or a newline are correctly
 *     quoted and embedded quotes are doubled (the escaping round-trips);
 *   - CRLF line endings;
 *   - numbers serialize as their default string form;
 *   - a whole document serializes each section under its heading.
 */

import { describe, expect, it } from 'vitest';

import { escapeCsvField, toCsv, toCsvBytes } from './csv.js';
import type { ReportDocument, ReportSection } from './types.js';

/** A tiny RFC-4180 parser for round-trip assertions (CRLF-delimited, double-quote escaping). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    field += ch;
    i += 1;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

describe('escapeCsvField (Req 32.1)', () => {
  it('leaves a plain field unquoted', () => {
    expect(escapeCsvField('hello')).toBe('hello');
  });

  it('quotes a field containing a comma', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('quotes and doubles an embedded double-quote', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a field containing a newline', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('renders a number as its default string form', () => {
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(3.5)).toBe('3.5');
  });
});

describe('toCsv (Req 32.1)', () => {
  it('serializes a single section as a header row plus data rows with CRLF endings', () => {
    const section: ReportSection = {
      heading: 'Usage',
      columns: ['Metric', 'Value'],
      rows: [
        ['Total Requests', 120],
        ['Total Cost (USD)', '12.5000'],
      ],
    };

    const csv = toCsv(section);

    expect(csv).toBe('Metric,Value\r\nTotal Requests,120\r\nTotal Cost (USD),12.5000');
    expect(csv.includes('\r\n')).toBe(true);
  });

  it('round-trips fields with commas, quotes, and newlines', () => {
    const section: ReportSection = {
      heading: 'Edge',
      columns: ['Key', 'Note'],
      rows: [
        ['a,b', 'has,comma'],
        ['quote', 'say "hi"'],
        ['newline', 'line1\nline2'],
      ],
    };

    const csv = toCsv(section);
    const parsed = parseCsv(csv);

    expect(parsed).toEqual([
      ['Key', 'Note'],
      ['a,b', 'has,comma'],
      ['quote', 'say "hi"'],
      ['newline', 'line1\nline2'],
    ]);
  });

  it('serializes a whole document, introducing each section with its heading', () => {
    const document: ReportDocument = {
      type: 'cost_report',
      title: 'Cost Report',
      generatedAt: '2026-01-01T00:00:00.000Z',
      organizationId: 'org-1',
      scope: { organizationId: 'org-1' },
      sections: [
        { heading: 'First', columns: ['A'], rows: [['1']] },
        { heading: 'Second', columns: ['B'], rows: [['2']] },
      ],
    };

    const csv = toCsv(document);

    expect(csv).toContain('First\r\nA\r\n1');
    expect(csv).toContain('Second\r\nB\r\n2');
    // The two sections are separated by a blank line.
    expect(csv).toContain('1\r\n\r\nSecond');
  });

  it('serializes a single-section document as plain header+rows (no heading row)', () => {
    const document: ReportDocument = {
      type: 'knowledge_base_health',
      title: 'Knowledge Base Health Report',
      generatedAt: '2026-01-01T00:00:00.000Z',
      organizationId: 'org-1',
      scope: { organizationId: 'org-1' },
      sections: [
        {
          heading: 'Knowledge Base Health',
          columns: ['Metric', 'Value'],
          rows: [['Collections', 5]],
        },
      ],
    };

    const csv = toCsv(document);

    expect(csv).toBe('Metric,Value\r\nCollections,5');
  });

  it('toCsvBytes encodes the same text as UTF-8 bytes', () => {
    const section: ReportSection = { heading: 'T', columns: ['X'], rows: [['v']] };
    const bytes = toCsvBytes(section);
    expect(new TextDecoder().decode(bytes)).toBe(toCsv(section));
  });
});
