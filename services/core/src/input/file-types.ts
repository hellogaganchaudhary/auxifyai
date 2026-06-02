/**
 * File-type classification for the Input_Processor (Req 7.1).
 *
 * Req 7.1 requires the Input_Processor to accept image, PDF, CSV, spreadsheet,
 * and code file types and associate each with the message. {@link
 * classifyFile} maps an {@link UploadedFile} (by MIME type first, then by file
 * extension) onto one of those {@link AttachmentKind}s, returning `null` for an
 * unsupported type so the processor can reject it explicitly rather than store
 * an unknown blob.
 *
 * Classification is intentionally pure and table-driven so the accepted set is
 * easy to read, test, and extend.
 */

import type { AttachmentKind, UploadedFile } from './types.js';

/** MIME types accepted as images (Req 7.1). */
const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

/** File extensions accepted as images (Req 7.1). */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);

/** MIME types accepted as spreadsheets (XLSX/XLS/ODS) (Req 7.1). */
const SPREADSHEET_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
]);

/** File extensions accepted as spreadsheets (Req 7.1). */
const SPREADSHEET_EXT = new Set(['xlsx', 'xls', 'ods']);

/**
 * File extensions accepted as code (Req 7.1).
 *
 * A representative set across the common languages and config formats; the
 * Input_Processor treats any of these as a `code` attachment when the MIME type
 * is generic (`text/plain`) or absent.
 */
const CODE_EXT = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cpp',
  'cc',
  'hpp',
  'cs',
  'php',
  'swift',
  'scala',
  'sh',
  'bash',
  'zsh',
  'sql',
  'html',
  'css',
  'scss',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'md',
]);

/** Extract the lower-cased file extension (without the dot), or `''` when none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1 || dot === fileName.length - 1) {
    return '';
  }
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * Classify an uploaded file into an accepted {@link AttachmentKind}, or `null`
 * when its type is not one of the kinds Req 7.1 accepts.
 *
 * MIME type is consulted first (most authoritative), then the file extension as
 * a fallback for generic or missing MIME types.
 *
 * @param file The uploaded file to classify.
 * @returns The classified kind, or `null` for an unsupported type.
 */
export function classifyFile(file: UploadedFile): AttachmentKind | null {
  const mime = file.contentType?.toLowerCase().split(';')[0]?.trim() ?? '';
  const ext = extensionOf(file.fileName);

  // Authoritative MIME matches first.
  if (IMAGE_MIME.has(mime)) {
    return 'image';
  }
  if (mime === 'application/pdf') {
    return 'pdf';
  }
  if (mime === 'text/csv') {
    return 'csv';
  }
  if (SPREADSHEET_MIME.has(mime)) {
    return 'spreadsheet';
  }

  // Extension fallbacks (covers generic `text/plain` and missing MIME types).
  if (IMAGE_EXT.has(ext)) {
    return 'image';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (ext === 'csv') {
    return 'csv';
  }
  if (SPREADSHEET_EXT.has(ext)) {
    return 'spreadsheet';
  }
  if (CODE_EXT.has(ext)) {
    return 'code';
  }

  return null;
}
