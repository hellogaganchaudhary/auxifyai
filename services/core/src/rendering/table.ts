/**
 * Tabular-data rendering support for the Output_Renderer (Req 8.5).
 *
 * The criterion requires a table that *supports sorting and export*. The
 * renderer produces a **structured table model** — typed columns plus
 * stringified rows — that the client renders and re-sorts interactively, along
 * with two things that make sorting and export first-class on the produced
 * descriptor:
 *
 *   - `sort` metadata and a pure {@link sortRows} that normalizes a requested
 *     initial sort (numeric columns sort numerically, others lexicographically,
 *     stably), and
 *   - a CSV `csv` export ({@link toCsv}, RFC-4180 quoting) of the sorted data.
 *
 * Everything is pure and synchronous; the model is transport-stable so it
 * crosses to the web client unchanged.
 */

import type { SortDirection, TableColumn, TableRenderedBlock, TableSort } from './types.js';

/** The structured payload a `table` {@link ContentBlock} is narrowed to. */
export interface TableBlockData {
  /**
   * Column definitions. Each may be a bare key string or an object with a
   * `key`, an optional `label` (defaults to the key), and an optional `numeric`
   * override (otherwise inferred from the data).
   */
  columns: Array<string | { key: string; label?: string; numeric?: boolean }>;
  /**
   * Rows, each either an object keyed by column key or an array of cells
   * aligned to `columns` order. Cell values are stringified for the model.
   */
  rows: Array<Record<string, unknown> | unknown[]>;
  /** An optional initial sort to apply to the rows. */
  sort?: { columnKey: string; direction?: SortDirection };
}

/** Stringify an arbitrary cell value into the table model's canonical string form. */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Whether a string is a finite numeric literal (used for numeric-column inference). */
function isNumeric(value: string): boolean {
  if (value.trim() === '') return false;
  return Number.isFinite(Number(value));
}

/** Normalize the loosely-typed columns into {@link TableColumn}s, inferring `numeric` from cells. */
function normalizeColumns(data: TableBlockData, rows: string[][]): TableColumn[] {
  return data.columns.map((col, index) => {
    const key = typeof col === 'string' ? col : col.key;
    const label = typeof col === 'string' ? col : (col.label ?? col.key);
    const declaredNumeric = typeof col === 'string' ? undefined : col.numeric;
    // Infer numeric: every non-empty cell in the column parses as a number.
    const cells = rows.map((row) => row[index] ?? '').filter((cell) => cell.trim() !== '');
    const inferredNumeric = cells.length > 0 && cells.every(isNumeric);
    return { key, label, numeric: declaredNumeric ?? inferredNumeric };
  });
}

/** Project a row (object or array) into a cell array aligned to `columns` order. */
function normalizeRow(row: Record<string, unknown> | unknown[], columnKeys: string[]): string[] {
  if (Array.isArray(row)) {
    return columnKeys.map((_key, index) => stringifyCell(row[index]));
  }
  return columnKeys.map((key) => stringifyCell(row[key]));
}

/**
 * Sort a copy of `rows` by the given column (Req 8.5). Numeric columns compare
 * numerically; others compare lexicographically. The sort is **stable**, so
 * equal keys keep their source order, and `rows` is never mutated.
 *
 * @param rows The stringified rows.
 * @param columnIndex The index of the column to sort by.
 * @param direction The sort direction.
 * @param numeric Whether to compare the column's values numerically.
 * @returns A new, sorted rows array.
 */
export function sortRows(
  rows: string[][],
  columnIndex: number,
  direction: SortDirection,
  numeric: boolean,
): string[][] {
  const factor = direction === 'asc' ? 1 : -1;
  // decorate-sort-undecorate to keep the sort stable across engines
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = a.row[columnIndex] ?? '';
      const bv = b.row[columnIndex] ?? '';
      let cmp: number;
      if (numeric) {
        cmp = (Number(av) || 0) - (Number(bv) || 0);
      } else {
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
      }
      return cmp !== 0 ? cmp * factor : a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** Quote a single CSV field per RFC 4180 (wrap in quotes and double internal quotes when needed). */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Render a table model to a CSV string (Req 8.5), header row first, with
 * RFC-4180 field quoting and CRLF line endings.
 *
 * @param columns The column definitions (their labels form the header row).
 * @param rows The stringified rows.
 * @returns The CSV export.
 */
export function toCsv(columns: TableColumn[], rows: string[][]): string {
  const header = columns.map((col) => csvField(col.label)).join(',');
  const body = rows.map((row) => row.map((cell) => csvField(cell)).join(','));
  return [header, ...body].join('\r\n');
}

/**
 * Build the structured, sortable, exportable {@link TableRenderedBlock} for
 * tabular data (Req 8.5).
 *
 * Columns are normalized (numeric inference), rows are stringified and aligned,
 * any requested initial sort is applied, and a CSV export of the resulting
 * (sorted) order is attached.
 *
 * @param data The table payload.
 * @returns The rendered table block descriptor.
 */
export function renderTable(data: TableBlockData): Omit<TableRenderedBlock, 'attribution'> {
  const columnKeys = data.columns.map((col) => (typeof col === 'string' ? col : col.key));
  let rows = data.rows.map((row) => normalizeRow(row, columnKeys));
  const columns = normalizeColumns(data, rows);

  let sort: TableSort | null = null;
  if (data.sort) {
    const columnIndex = columnKeys.indexOf(data.sort.columnKey);
    if (columnIndex >= 0) {
      const direction = data.sort.direction ?? 'asc';
      rows = sortRows(rows, columnIndex, direction, columns[columnIndex]?.numeric ?? false);
      sort = { columnKey: data.sort.columnKey, direction };
    }
  }

  return { kind: 'table', columns, rows, sort, csv: toCsv(columns, rows) };
}
