/**
 * A pure, dependency-free CSV serializer for report sections and documents
 * (Req 32.1).
 *
 * {@link toCsv} turns a single {@link ReportSection} or a whole
 * {@link ReportDocument} into one RFC-4180-style CSV string with correct
 * escaping, and {@link toCsvBytes} encodes that string to UTF-8 bytes for a
 * {@link import('./types.js').GeneratedReport}.
 *
 * Conventions (documented and fixed so the output is deterministic):
 *   - Line endings are CRLF (`\r\n`), per RFC 4180.
 *   - A field is quoted iff it contains a comma, a double-quote, a carriage
 *     return, or a line feed; an embedded double-quote is escaped by doubling it
 *     (`"` -> `""`).
 *   - A number cell is rendered with the JavaScript default string form.
 *   - A SINGLE section serializes as a plain header row followed by its data
 *     rows (so a one-section report round-trips as ordinary CSV).
 *   - A DOCUMENT (or any multi-section input) introduces each section with a
 *     single field row carrying the section heading, followed by its header row
 *     and data rows; sections are separated by one blank line.
 */

import type { ReportDocument, ReportSection } from './types.js';

/** The RFC-4180 record separator used by {@link toCsv}. */
const CRLF = '\r\n';

/**
 * Escape a single CSV field (Req 32.1).
 *
 * Quotes the field iff it contains a comma, a double-quote, a CR, or an LF, and
 * doubles any embedded double-quote, so the produced CSV round-trips exactly.
 *
 * @param value The cell value (a string or number).
 * @returns The escaped field text.
 */
export function escapeCsvField(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value;
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Render a single row of already-typed cells to an escaped CSV line. */
function renderRow(cells: readonly (string | number)[]): string {
  return cells.map(escapeCsvField).join(',');
}

/** Render one section's header + data rows (no heading row) to CSV lines. */
function renderSectionLines(section: ReportSection): string[] {
  const lines: string[] = [renderRow(section.columns)];
  for (const row of section.rows) {
    lines.push(renderRow(row));
  }
  return lines;
}

/** Type guard distinguishing a {@link ReportDocument} from a {@link ReportSection}. */
function isDocument(value: ReportSection | ReportDocument): value is ReportDocument {
  return Array.isArray((value as ReportDocument).sections);
}

/**
 * Serialize a {@link ReportSection} or a whole {@link ReportDocument} to a single
 * RFC-4180-style CSV string with correct escaping (Req 32.1).
 *
 * A single section serializes as a plain header row followed by its data rows. A
 * document (or any multi-section input) serializes each section as a heading
 * row, its header row, and its data rows, with sections separated by a blank
 * line — so a multi-section report stays a single, well-formed CSV document.
 *
 * @param input One report section, or an assembled report document.
 * @returns The CSV text (CRLF line endings).
 */
export function toCsv(input: ReportSection | ReportDocument): string {
  const sections = isDocument(input) ? input.sections : [input];
  if (sections.length === 1 && sections[0] !== undefined) {
    return renderSectionLines(sections[0]).join(CRLF);
  }

  const blocks: string[] = [];
  for (const section of sections) {
    const lines: string[] = [renderRow([section.heading]), ...renderSectionLines(section)];
    blocks.push(lines.join(CRLF));
  }
  // A blank line separates sections (the blank record is the empty join).
  return blocks.join(CRLF + CRLF);
}

/**
 * Serialize a report section or document to UTF-8 CSV bytes for a
 * {@link import('./types.js').GeneratedReport} (Req 32.1).
 *
 * @param input One report section, or an assembled report document.
 * @returns The CSV payload encoded as UTF-8 bytes.
 */
export function toCsvBytes(input: ReportSection | ReportDocument): Uint8Array {
  return new TextEncoder().encode(toCsv(input));
}
