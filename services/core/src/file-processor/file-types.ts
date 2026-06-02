/**
 * File-type detection for the File_Processor (Req 11.1, 11.6).
 *
 * Req 11.6 enumerates the formats the File_Processor must support:
 *
 *  - documents:    PDF, DOCX, PPTX, TXT, Markdown
 *  - spreadsheets: XLSX, CSV
 *  - images:       PNG, JPG, WEBP, SVG, GIF
 *  - data:         JSON, XML, YAML, TOML
 *  - archives:     ZIP
 *  - audio:        MP3, WAV
 *
 * {@link detectFileType} maps a {@link RawFile} (by MIME type first, then by
 * file extension) onto one of those formats and its owning
 * {@link SupportedCategory}, returning `null` for any format outside the
 * catalog so the processor can skip or reject it explicitly rather than store
 * an unknown blob. Detection is intentionally pure and table-driven so the
 * supported set is easy to read, test, and extend.
 */

import type { DetectedFileType, RawFile, SupportedCategory } from './types.js';

/** A single entry in the format catalog: its category and accepted MIME types. */
interface FormatSpec {
  /** The category the format belongs to. */
  category: SupportedCategory;
  /** The MIME types that authoritatively identify the format. */
  mimes: readonly string[];
}

/**
 * The supported-format catalog, keyed by the normalized format token and the
 * file extension that maps to it (Req 11.6).
 *
 * The key is both the canonical `format` token returned in
 * {@link DetectedFileType.format} and the file extension matched as a fallback
 * (`jpg`/`jpeg` and `yaml`/`yml` are aliased below).
 */
const FORMATS: Readonly<Record<string, FormatSpec>> = {
  // Documents (Req 11.6).
  pdf: { category: 'document', mimes: ['application/pdf'] },
  docx: {
    category: 'document',
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  pptx: {
    category: 'document',
    mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  },
  txt: { category: 'document', mimes: ['text/plain'] },
  md: { category: 'document', mimes: ['text/markdown', 'text/x-markdown'] },
  // Spreadsheets (Req 11.6).
  xlsx: {
    category: 'spreadsheet',
    mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  },
  csv: { category: 'spreadsheet', mimes: ['text/csv'] },
  // Images (Req 11.6).
  png: { category: 'image', mimes: ['image/png'] },
  jpg: { category: 'image', mimes: ['image/jpeg', 'image/jpg'] },
  webp: { category: 'image', mimes: ['image/webp'] },
  svg: { category: 'image', mimes: ['image/svg+xml'] },
  gif: { category: 'image', mimes: ['image/gif'] },
  // Data (Req 11.6).
  json: { category: 'data', mimes: ['application/json', 'text/json'] },
  xml: { category: 'data', mimes: ['application/xml', 'text/xml'] },
  yaml: { category: 'data', mimes: ['application/yaml', 'text/yaml', 'application/x-yaml'] },
  toml: { category: 'data', mimes: ['application/toml', 'text/toml'] },
  // Archives (Req 11.6, 11.7).
  zip: { category: 'archive', mimes: ['application/zip', 'application/x-zip-compressed'] },
  // Audio (Req 11.6).
  mp3: { category: 'audio', mimes: ['audio/mpeg', 'audio/mp3'] },
  wav: { category: 'audio', mimes: ['audio/wav', 'audio/x-wav', 'audio/wave'] },
};

/** Extension aliases that map to a canonical format token in {@link FORMATS}. */
const EXTENSION_ALIASES: Readonly<Record<string, string>> = {
  jpeg: 'jpg',
  yml: 'yaml',
  markdown: 'md',
  htm: 'html',
};

/** MIME → canonical format token, derived once from {@link FORMATS}. */
const MIME_TO_FORMAT: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [format, spec] of Object.entries(FORMATS)) {
    for (const mime of spec.mimes) {
      map.set(mime, format);
    }
  }
  return map;
})();

/** Extract the lower-cased file extension (without the dot), or `''` when none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1 || dot === fileName.length - 1) {
    return '';
  }
  return fileName.slice(dot + 1).toLowerCase();
}

/** Normalize an extension through the alias table to a canonical format token. */
function canonicalFormat(ext: string): string | undefined {
  const aliased = EXTENSION_ALIASES[ext] ?? ext;
  return aliased in FORMATS ? aliased : undefined;
}

/**
 * Detect the type of an uploaded file (Req 11.1, 11.6), or `null` when its
 * format is outside the supported catalog.
 *
 * MIME type is consulted first (most authoritative); the file extension is the
 * fallback for generic or missing MIME types. The returned
 * {@link DetectedFileType} records which signal matched.
 *
 * @param file The file to detect.
 * @returns The detected type, or `null` for an unsupported format.
 */
export function detectFileType(file: RawFile): DetectedFileType | null {
  const mime = file.contentType?.toLowerCase().split(';')[0]?.trim() ?? '';
  const ext = extensionOf(file.fileName);

  // Authoritative MIME match first.
  const byMime = MIME_TO_FORMAT.get(mime);
  if (byMime !== undefined) {
    const spec = FORMATS[byMime]!;
    return { category: spec.category, format: byMime, mime, extension: ext || undefined };
  }

  // Extension fallback (covers generic `text/plain`, `application/octet-stream`,
  // and missing MIME types).
  const byExt = canonicalFormat(ext);
  if (byExt !== undefined) {
    const spec = FORMATS[byExt]!;
    return {
      category: spec.category,
      format: byExt,
      extension: ext,
      ...(mime !== '' ? { mime } : {}),
    };
  }

  return null;
}

/** True iff the file's detected category is `image` (Req 11.3 — OCR route). */
export function isImageType(type: DetectedFileType): boolean {
  return type.category === 'image';
}

/** True iff the file's detected category is `archive` (Req 11.7 — expansion route). */
export function isArchiveType(type: DetectedFileType): boolean {
  return type.category === 'archive';
}
