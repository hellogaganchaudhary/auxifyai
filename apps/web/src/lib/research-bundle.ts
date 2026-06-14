/**
 * Research bundle assembly — turn a finished deep-research report into a rich,
 * multi-artifact ZIP (an "extraordinary project report").
 *
 * The bundle gathers everything the research produced into one archive:
 *   report.md / report.pdf / report.docx  — the report in three forms
 *   data/*.xlsx                            — the report's tables as a workbook
 *   charts/*.svg                           — bar charts rendered from numeric
 *                                            tables, plus any inline SVG figures
 *   sources/sources.csv + sources.md       — the cited web/KB sources
 *   README.txt                             — a manifest of the contents
 *
 * The pure helpers here (table parsing, chart rendering, CSV/manifest building)
 * are dependency-free and unit-testable; the binary report renders (PDF/DOCX/
 * XLSX) are produced by the caller via the file-generation API and passed in.
 */

import type { ZipEntry } from './zip';

/** A parsed Markdown table. */
export interface ParsedTable {
  /** Column headers. */
  header: string[];
  /** Data rows (each the same width as {@link header}, best-effort). */
  rows: string[][];
}

/** Split a single Markdown table row into trimmed cells. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Whether a line is a Markdown table separator (e.g. `| --- | :--: |`). */
function isSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/**
 * Extract every GitHub-flavored Markdown table from a document. A table is a
 * header row, a `---` separator row, then one or more data rows.
 */
export function extractMarkdownTables(markdown: string): ParsedTable[] {
  const lines = markdown.split('\n');
  const tables: ParsedTable[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const headerLine = lines[i] ?? '';
    const sepLine = lines[i + 1] ?? '';
    if (!headerLine.includes('|') || !isSeparator(sepLine)) continue;
    const header = splitRow(headerLine);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const row = lines[j] ?? '';
      if (!row.includes('|') || row.trim().length === 0) break;
      rows.push(splitRow(row));
    }
    if (rows.length > 0) tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

/** Parse a numeric value from a cell (strips $, %, commas). Returns NaN if none. */
function parseNumber(cell: string): number {
  const cleaned = cell.replace(/[$,%\s]/g, '').replace(/[^0-9.+-]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** XML-escape a string for safe inclusion in SVG. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Theme palette for generated charts. */
const CHART_COLORS = ['#6366F1', '#06B6D4', '#8B5CF6', '#22D3EE', '#A855F7', '#14B8A6'];

/**
 * Render a numeric Markdown table as a grouped bar-chart SVG. Uses the first
 * column as category labels and the first numeric column as the series. Returns
 * `null` when the table has no usable numeric column.
 */
export function tableToBarChartSvg(table: ParsedTable, title: string): string | null {
  if (table.header.length < 2 || table.rows.length === 0) return null;

  // Find the first column whose data parses as numbers in most rows.
  let valueCol = -1;
  for (let c = 1; c < table.header.length; c++) {
    const nums = table.rows.map((r) => parseNumber(r[c] ?? ''));
    const ok = nums.filter((n) => !Number.isNaN(n)).length;
    if (ok >= Math.max(1, Math.ceil(table.rows.length * 0.6))) {
      valueCol = c;
      break;
    }
  }
  if (valueCol === -1) return null;

  const points = table.rows
    .map((r) => ({ label: r[0] ?? '', value: parseNumber(r[valueCol] ?? '') }))
    .filter((p) => !Number.isNaN(p.value))
    .slice(0, 16);
  if (points.length === 0) return null;

  const W = 720;
  const H = 420;
  const pad = { top: 56, right: 32, bottom: 90, left: 64 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxVal = Math.max(...points.map((p) => p.value), 0);
  const minVal = Math.min(...points.map((p) => p.value), 0);
  const range = maxVal - minVal || 1;
  const barGap = 12;
  const barW = Math.max(6, plotW / points.length - barGap);

  const yFor = (v: number): number => pad.top + plotH - ((v - minVal) / range) * plotH;
  const zeroY = yFor(0);

  const bars = points
    .map((p, i) => {
      const x = pad.left + i * (barW + barGap) + barGap / 2;
      const y = p.value >= 0 ? yFor(p.value) : zeroY;
      const h = Math.abs(yFor(p.value) - zeroY);
      const color = CHART_COLORS[i % CHART_COLORS.length];
      const labelText = p.label.length > 12 ? `${p.label.slice(0, 11)}…` : p.label;
      return [
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}"/>`,
        `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="11" fill="#334155" text-anchor="middle">${esc(String(p.value))}</text>`,
        `<text x="${(x + barW / 2).toFixed(1)}" y="${(H - pad.bottom + 18).toFixed(1)}" font-size="11" fill="#64748B" text-anchor="middle" transform="rotate(35 ${(x + barW / 2).toFixed(1)} ${(H - pad.bottom + 18).toFixed(1)})">${esc(labelText)}</text>`,
      ].join('');
    })
    .join('');

  const valueTitle = table.header[valueCol] ?? 'Value';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#FFFFFF"/>`,
    `<text x="${pad.left}" y="32" font-size="17" font-weight="bold" fill="#0F172A">${esc(title)}</text>`,
    `<text x="${pad.left}" y="${pad.top - 14}" font-size="12" fill="#64748B">${esc(valueTitle)} by ${esc(table.header[0] ?? 'category')}</text>`,
    `<line x1="${pad.left}" y1="${zeroY.toFixed(1)}" x2="${(W - pad.right).toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="#CBD5E1" stroke-width="1"/>`,
    bars,
    '</svg>',
  ].join('');
}

/** Extract inline SVG figures the report author may have embedded. */
export function extractSvgFigures(markdown: string): string[] {
  const figures: string[] = [];
  const fence = /```(?:svg|xml)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) {
    const body = m[1] ?? '';
    if (/<svg[\s>]/i.test(body)) figures.push(body.trim());
  }
  const bare = /<svg\b[\s\S]*?<\/svg\s*>/gi;
  while ((m = bare.exec(markdown)) !== null) {
    if (!figures.some((f) => f.includes(m![0].slice(0, 40)))) figures.push(m[0]);
  }
  return figures;
}

/** A cited source for the bundle. */
export interface BundleSource {
  index: number;
  title: string;
  url: string;
  snippet?: string;
}

/** Escape a CSV field (quote when it contains a comma, quote, or newline). */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Build a `sources.csv` from the cited sources. */
export function sourcesToCsv(sources: BundleSource[]): string {
  const rows = [['#', 'title', 'url', 'snippet'].join(',')];
  for (const s of sources) {
    rows.push(
      [csvField(String(s.index)), csvField(s.title), csvField(s.url), csvField(s.snippet ?? '')].join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}

/** Build a `sources.md` from the cited sources. */
export function sourcesToMarkdown(sources: BundleSource[]): string {
  if (sources.length === 0) return '# Sources\n\n_No external sources were cited._\n';
  const lines = ['# Sources', ''];
  for (const s of sources) {
    lines.push(`${s.index}. [${s.title || s.url}](${s.url})`);
    if (s.snippet) lines.push(`   - ${s.snippet}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The pieces the caller has already produced for the bundle. */
export interface BundleInput {
  /** The research question / title. */
  title: string;
  /** The full report Markdown. */
  reportMarkdown: string;
  /** Cited sources. */
  sources: BundleSource[];
  /** Pre-rendered binary report files (base64) keyed by archive filename. */
  files: { name: string; base64: string }[];
}

/**
 * Assemble the full set of {@link ZipEntry} items for a research bundle: the
 * report (md + provided binaries), generated charts from numeric tables, any
 * inline SVG figures, a per-table data note, the sources, and a README manifest.
 */
export function buildBundleEntries(input: BundleInput): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const safeTitle = input.title.trim().length > 0 ? input.title.trim() : 'Research report';

  // 1) The report, in every produced form.
  entries.push({ name: 'report.md', content: input.reportMarkdown });
  for (const f of input.files) {
    entries.push({ name: f.name, base64: f.base64 });
  }

  // 2) Charts rendered from numeric tables in the report.
  const tables = extractMarkdownTables(input.reportMarkdown);
  const chartNames: string[] = [];
  tables.forEach((table, i) => {
    const svg = tableToBarChartSvg(table, `Figure ${i + 1}: ${table.header[0] ?? 'Data'}`);
    if (svg !== null) {
      const name = `charts/figure-${i + 1}.svg`;
      entries.push({ name, content: svg });
      chartNames.push(name);
    }
  });

  // 3) Any inline SVG figures the author embedded.
  extractSvgFigures(input.reportMarkdown).forEach((svg, i) => {
    const name = `charts/figure-inline-${i + 1}.svg`;
    entries.push({ name, content: svg });
    chartNames.push(name);
  });

  // 4) Sources.
  entries.push({ name: 'sources/sources.csv', content: sourcesToCsv(input.sources) });
  entries.push({ name: 'sources/sources.md', content: sourcesToMarkdown(input.sources) });

  // 5) Manifest.
  const manifest = [
    safeTitle,
    '='.repeat(safeTitle.length),
    '',
    'Contents of this research bundle:',
    ...entries.map((e) => `  - ${e.name}`),
    '',
    `Tables found: ${tables.length}`,
    `Charts generated: ${chartNames.length}`,
    `Sources cited: ${input.sources.length}`,
    '',
    `Generated by Auxify on ${new Date().toISOString()}.`,
  ].join('\n');
  entries.push({ name: 'README.txt', content: `${manifest}\n` });

  return entries;
}
