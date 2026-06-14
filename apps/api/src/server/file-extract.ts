/**
 * Server-side text extraction for uploaded files.
 *
 * Turns an uploaded file (base64 bytes + MIME type/name) into model-ready text
 * so the chat model can reason over PDFs, spreadsheets, Word docs, CSVs, code,
 * and plain text. Images are NOT handled here — they are passed straight to a
 * vision-capable model as image content parts by the chat path.
 *
 * Each binary parser is loaded lazily so a malformed/oversized file in one
 * format never blocks the others, and so the parsers' heavy deps are only
 * touched when actually needed.
 */

/** A decoded upload to extract text from. */
export interface UploadInput {
  /** The original file name (used for extension-based detection + labelling). */
  name: string;
  /** The file MIME type as reported by the browser. */
  mimeType: string;
  /** Base64-encoded file bytes. */
  base64: string;
}

/** The result of extracting text from an upload. */
export interface ExtractResult {
  /** The file name. */
  name: string;
  /** The extracted, model-ready text (may be truncated). */
  text: string;
  /** True when extraction failed; `text` then holds an explanatory note. */
  failed?: boolean;
}

/** Cap extracted text per file so a huge document cannot blow the context window. */
const MAX_CHARS = 60_000;

/**
 * A much larger ceiling for "deep" extraction (e.g. ingesting a multi-sheet
 * workbook into the knowledge base, where the text is chunked + embedded rather
 * than stuffed into a single chat context). Still bounded so a pathological
 * file can't exhaust memory.
 */
const MAX_CHARS_DEEP = 5_000_000;

/**
 * Hard cap on the decoded size of one uploaded file. The binary parsers
 * (pdf-parse, xlsx) are not hardened against decompression bombs, so oversized
 * payloads are rejected BEFORE any decoding or parsing happens.
 */
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Truncate text to the given cap, noting how much was dropped. */
function cap(text: string, maxChars: number = MAX_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n…[truncated ${text.length - maxChars} more characters]`;
}

/** Lower-cased file extension (without the dot), or ''. */
function ext(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Extract text from a PDF using `pdf-parse`. */
async function extractPdf(buf: Buffer): Promise<string> {
  // pdf-parse's index has a debug side-effect on import; import the lib file.
  const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
    default: (data: Buffer) => Promise<{ text: string }>;
  };
  const result = await mod.default(buf);
  return result.text;
}

/** Extract text from an Excel/CSV workbook using `xlsx`, one section per sheet. */
async function extractSpreadsheet(buf: Buffer): Promise<string> {
  const xlsx = (await import('xlsx')) as typeof import('xlsx');
  const wb = xlsx.read(buf, { type: 'buffer', cellDates: true, cellText: true });
  const parts: string[] = [];
  const sheetNames = wb.SheetNames;
  parts.push(`Workbook with ${sheetNames.length} sheet(s): ${sheetNames.join(', ')}`);
  for (const sheetName of sheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (sheet === undefined) {
      continue;
    }
    // Dimensions help the model reason about the sheet's shape.
    const ref = typeof sheet['!ref'] === 'string' ? sheet['!ref'] : 'empty';
    const csv = xlsx.utils.sheet_to_csv(sheet, { blankrows: false });
    parts.push(`# Sheet: ${sheetName} (range ${ref})\n${csv}`);
  }
  return parts.join('\n\n');
}

/** Extract text from a Word .docx using `mammoth`. */
async function extractDocx(buf: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')) as typeof import('mammoth');
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

/**
 * Extract model-ready text from one uploaded file. Detects the format from the
 * MIME type and extension and dispatches to the right parser; on any failure it
 * returns a `failed` result with a short note rather than throwing.
 *
 * Pass `{ deep: true }` for knowledge-base ingestion, where the text is chunked
 * and embedded rather than placed in a single chat context — this raises the
 * per-file character cap so large, multi-sheet workbooks and long documents are
 * captured in full.
 */
export async function extractText(
  upload: UploadInput,
  options: { deep?: boolean } = {},
): Promise<ExtractResult> {
  const maxChars = options.deep === true ? MAX_CHARS_DEEP : MAX_CHARS;
  // Size gate first: estimate the decoded size from the base64 length so a
  // multi-hundred-MB upload is refused without allocating its buffer.
  const approxBytes = Math.floor(upload.base64.length * 0.75);
  if (approxBytes > MAX_FILE_BYTES) {
    return {
      name: upload.name,
      text: `[File too large (~${Math.round(approxBytes / (1024 * 1024))} MB; limit ${
        MAX_FILE_BYTES / (1024 * 1024)
      } MB).]`,
      failed: true,
    };
  }
  const buf = Buffer.from(upload.base64, 'base64');
  const e = ext(upload.name);
  const mime = upload.mimeType.toLowerCase();

  try {
    // PDF.
    if (mime === 'application/pdf' || e === 'pdf') {
      return { name: upload.name, text: cap(await extractPdf(buf), maxChars) };
    }
    // Excel / spreadsheets.
    if (
      e === 'xlsx' ||
      e === 'xls' ||
      mime.includes('spreadsheetml') ||
      mime === 'application/vnd.ms-excel'
    ) {
      return { name: upload.name, text: cap(await extractSpreadsheet(buf), maxChars) };
    }
    // Word documents.
    if (e === 'docx' || mime.includes('wordprocessingml')) {
      return { name: upload.name, text: cap(await extractDocx(buf), maxChars) };
    }
    // CSV and any text-like / code / JSON / markdown content.
    if (
      e === 'csv' ||
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      mime === 'application/xml' ||
      mime === 'application/javascript' ||
      isProbablyText(buf)
    ) {
      return { name: upload.name, text: cap(buf.toString('utf8'), maxChars) };
    }
    return {
      name: upload.name,
      text: `[Unsupported file type "${upload.mimeType || e || 'unknown'}" — could not extract text.]`,
      failed: true,
    };
  } catch (error) {
    return {
      name: upload.name,
      text: `[Failed to read "${upload.name}": ${error instanceof Error ? error.message : 'error'}]`,
      failed: true,
    };
  }
}

/** Heuristic: treat bytes as text when the first chunk is mostly printable. */
function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 1024);
  if (sample.length === 0) {
    return false;
  }
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) {
      printable += 1;
    }
  }
  return printable / sample.length > 0.85;
}

/** Build a single context block from several extracted files. */
export function buildAttachmentContext(results: ExtractResult[]): string {
  if (results.length === 0) {
    return '';
  }
  const sections = results.map(
    (r) => `--- Attached file: ${r.name} ---\n${r.text}`,
  );
  return [
    'The user attached the following file(s). Use their content to answer:',
    ...sections,
  ].join('\n\n');
}
