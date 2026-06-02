/**
 * Domain records and injectable ports for the File_Processor ingest path
 * (Req 11.1, 11.3, 11.4, 11.5, 11.6, 11.7).
 *
 * The File_Processor turns an uploaded file into retrievable knowledge: it
 * scans the file for malware and detects its type (Req 11.1), extracts text
 * (running OCR for images and scanned pages, Req 11.3), splits the text into
 * chunks and embeds each one (Req 11.4), indexes the chunks in the Vector_Store
 * and persists the original bytes in the Object_Store (Req 11.5), supports the
 * full catalog of document, spreadsheet, image, data, archive, and audio
 * formats (Req 11.6), and expands ZIP archives to process each supported member
 * (Req 11.7).
 *
 * Every external capability it cannot perform purely — malware scanning, text
 * extraction, OCR, embedding, and archive expansion — is modelled here as a
 * narrow port, and the durable side effects go through the shared
 * {@link import('../storage/index.js').VectorStore} and
 * {@link import('../storage/index.js').ObjectStore} interfaces. The processor
 * is therefore fully unit-testable with the in-memory fakes in `./fakes.js`,
 * with no hard dependency on a scanner binary, a parser, a model, or a cloud
 * backend.
 */

/**
 * The supported file categories (Req 11.6).
 *
 * Every format the platform accepts maps to exactly one of these categories;
 * the category drives the extraction route (images go through OCR, archives are
 * expanded, everything else goes through the {@link TextExtractor}).
 */
export type SupportedCategory =
  | 'document'
  | 'spreadsheet'
  | 'image'
  | 'data'
  | 'archive'
  | 'audio';

/** All {@link SupportedCategory} values, for iteration, validation, and tests. */
export const SUPPORTED_CATEGORIES: readonly SupportedCategory[] = [
  'document',
  'spreadsheet',
  'image',
  'data',
  'archive',
  'audio',
] as const;

/**
 * A raw file supplied for processing.
 *
 * The bytes are required because the malware scan, text extraction, OCR, and
 * Object_Store persistence all operate on the payload; `contentType` (MIME) and
 * `fileName` together drive type detection (Req 11.1, 11.6).
 */
export interface RawFile {
  /** The original file name, including extension (e.g. `report.pdf`). */
  fileName: string;
  /** The declared MIME type (e.g. `application/pdf`), when known. */
  contentType?: string;
  /** The file size in bytes. */
  sizeBytes: number;
  /** The raw file payload. */
  bytes: Uint8Array;
}

/**
 * A {@link RawFile} together with the owning user and Organization (Req 11.5).
 *
 * The owner/Organization are carried so the stored {@link StoredFile} record
 * and every produced Vector_Store record are tenant-scoped (Req 1.2, 44.2).
 */
export interface IngestFileInput extends RawFile {
  /** The id of the user uploading the file. */
  ownerId: string;
  /** The Organization the upload belongs to. */
  organizationId: string;
}

/**
 * The detected type of a file (Req 11.1, 11.6).
 *
 * `category` selects the extraction route; `format` is the normalized,
 * lower-cased format token (e.g. `pdf`, `png`, `zip`); `mime`/`extension`
 * record what the detection was based on.
 */
export interface DetectedFileType {
  /** The category the format belongs to. */
  category: SupportedCategory;
  /** The normalized format token (e.g. `pdf`, `xlsx`, `png`, `zip`, `mp3`). */
  format: string;
  /** The MIME type the detection matched, when matched by MIME. */
  mime?: string;
  /** The file extension the detection matched, when matched by extension. */
  extension?: string;
}

/**
 * The outcome of a malware scan (Req 11.1).
 *
 * A `threat` result short-circuits the ingest path before any chunking,
 * embedding, indexing, or Object_Store write occurs (Req 11.1, Property 27);
 * the rejection's audit recording and storage-quota enforcement are the
 * Req 11.2 task.
 */
export interface MalwareScanResult {
  /** Whether the scan found the file clean or flagged a threat. */
  status: 'clean' | 'threat';
  /** A human-readable detail (e.g. the matched signature), when flagged. */
  detail?: string;
}

/**
 * The port that scans an uploaded file for malware (Req 11.1).
 *
 * Modelling scanning as a port keeps the File_Processor independent of any
 * concrete scanner (ClamAV, a cloud scanning API, …) and lets tests inject a
 * deterministic scanner that flags chosen inputs.
 */
export interface MalwareScanner {
  /**
   * Scan a file for malware.
   *
   * @param file The file to scan.
   * @returns The scan result; `threat` blocks all further processing.
   */
  scan(file: RawFile): Promise<MalwareScanResult>;
}

/**
 * The text extracted from a file, with a signal for whether OCR is still
 * required (Req 11.3, 11.4).
 *
 * A text-bearing document extractor returns the embedded text directly; a
 * scanned page (a PDF with no embedded text layer, an image-only document)
 * returns `needsOcr: true` so the File_Processor runs OCR over the file
 * (Req 11.3).
 */
export interface ExtractedText {
  /** The extracted text (empty when the document carries no embedded text). */
  text: string;
  /** `true` when the source is a scanned page that must go through OCR (Req 11.3). */
  needsOcr?: boolean;
}

/**
 * The port that extracts text from a non-image, text-bearing file (Req 11.4).
 *
 * Handles document, spreadsheet, data, and audio formats (a PDF/DOCX/PPTX/TXT/
 * Markdown document, an XLSX/CSV spreadsheet, a JSON/XML/YAML/TOML data file,
 * or an MP3/WAV transcription). Modelling extraction as a port keeps the
 * File_Processor independent of the many format parsers and lets tests inject
 * deterministic text.
 */
export interface TextExtractor {
  /**
   * Extract text from a file of the given detected type.
   *
   * @param file The file to extract text from.
   * @param type The file's detected type (selects the parser).
   * @returns The extracted text, optionally flagged as needing OCR (Req 11.3).
   */
  extract(file: RawFile, type: DetectedFileType): Promise<ExtractedText>;
}

/**
 * The port that performs optical character recognition (Req 11.3).
 *
 * Invoked for image files and for scanned pages a {@link TextExtractor} flags
 * with {@link ExtractedText.needsOcr}. Modelling OCR as a port keeps the
 * File_Processor independent of any concrete OCR engine and lets tests inject
 * deterministic recognized text.
 */
export interface OcrEngine {
  /**
   * Recognize the text contained in an image or scanned page.
   *
   * @param file The image / scanned file to recognize.
   * @returns The recognized text.
   */
  recognize(file: RawFile): Promise<string>;
}

/**
 * The port that embeds chunk text into vectors (Req 11.4).
 *
 * Must return exactly one embedding per input chunk, in order; the
 * File_Processor enforces this one-embedding-per-chunk invariant (Property 28)
 * and the Vector_Store enforces the fixed 1536 dimensionality (Req 44.2).
 * Modelling embedding as a port keeps the File_Processor independent of the
 * Provider_Abstraction_Layer's embedding model and lets tests inject
 * deterministic vectors.
 */
export interface Embedder {
  /**
   * Embed a batch of chunk texts into vectors.
   *
   * @param texts The chunk texts to embed, in order.
   * @returns One embedding per input, in the same order.
   */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * A single member extracted from an archive (Req 11.7).
 *
 * `path` is the member's path within the archive (used for naming and
 * provenance); `file` is the extracted member, ready to be processed exactly
 * like a directly uploaded file.
 */
export interface ArchiveMember {
  /** The member's path within the archive (e.g. `docs/readme.md`). */
  path: string;
  /** The extracted member file. */
  file: RawFile;
}

/**
 * The port that expands an archive into its members (Req 11.7).
 *
 * Modelling expansion as a port keeps the File_Processor independent of any
 * concrete archive library and lets tests inject deterministic members
 * (including nested archives and unsupported members).
 */
export interface ArchiveExpander {
  /**
   * Expand an archive file into its member files.
   *
   * @param file The archive to expand.
   * @returns The archive's members.
   */
  expand(file: RawFile): Promise<ArchiveMember[]>;
}

/**
 * The port that tracks and bounds cumulative file storage (Req 11.8, 11.9).
 *
 * The File_Processor consults this store before persisting a file's bytes so it
 * can reject an upload that would push a user past the fixed 10 GB per-user
 * quota (Req 11.8) or an Organization past its configured quota (Req 11.9), and
 * records the file's bytes against both scopes once the file is durably stored
 * so usage accumulates across uploads.
 *
 * Modelling accounting as a port keeps the File_Processor independent of where
 * usage actually lives (a `SUM(size_bytes)` over the tenant-scoped `files`
 * table, the Organization's `storageQuotaBytes` column) and lets tests inject a
 * deterministic in-memory store. The per-user quota is a fixed platform
 * constant supplied to the processor; the per-Organization quota is configured
 * per Organization and resolved here.
 */
export interface StorageUsageStore {
  /**
   * Return the total bytes a user has already stored within an Organization.
   *
   * @param organizationId The owning Organization.
   * @param ownerId The owning user.
   * @returns The user's current stored bytes (0 when the user has stored nothing).
   */
  getUserUsage(organizationId: string, ownerId: string): Promise<number>;

  /**
   * Return the total bytes an Organization has already stored.
   *
   * @param organizationId The Organization.
   * @returns The Organization's current stored bytes (0 when it has stored nothing).
   */
  getOrganizationUsage(organizationId: string): Promise<number>;

  /**
   * Return the Organization's configured storage quota in bytes (Req 11.9).
   *
   * @param organizationId The Organization.
   * @returns The Organization's configured quota in bytes.
   */
  getOrganizationQuotaBytes(organizationId: string): Promise<number>;

  /**
   * Record that a file's bytes were durably stored, against both the user and
   * the Organization, so subsequent quota checks see the accumulated usage.
   *
   * Called only after the Object_Store persist and Vector_Store index succeed,
   * so a rejected or failed upload never inflates usage.
   *
   * @param organizationId The owning Organization.
   * @param ownerId The owning user.
   * @param bytes The number of bytes that were stored.
   */
  recordUsage(organizationId: string, ownerId: string, bytes: number): Promise<void>;
}

/**
 * A persisted file record produced for a successfully processed file
 * (Req 11.5).
 *
 * Mirrors the design's `FileObject`: the original bytes live in the
 * Object_Store under {@link objectKey}, and the record is tenant-scoped by
 * {@link organizationId}. Because the ingest path only reaches this point for a
 * clean file, {@link malwareScan} is always `clean` here (Req 11.1).
 */
export interface StoredFile {
  /** The file's stable unique id (also the owner id of its chunk vectors). */
  id: string;
  /** The id of the user who uploaded the file. */
  ownerId: string;
  /** The Organization that owns the file. */
  organizationId: string;
  /** The file name (the member path, for a file extracted from an archive). */
  name: string;
  /** The resolved content type stored alongside the object. */
  contentType: string;
  /** The file size in bytes. */
  sizeBytes: number;
  /** The Object_Store key the original bytes were persisted under (Req 11.5). */
  objectKey: string;
  /** Always `clean` — a threat never reaches persistence (Req 11.1). */
  malwareScan: 'clean';
  /** The detected category (Req 11.6). */
  category: SupportedCategory;
  /** The ISO-8601 timestamp the record was created. */
  createdAt: string;
}

/** The discriminant statuses an ingest can produce for a single file. */
export type IngestOutcomeStatus = 'processed' | 'rejected' | 'skipped';

/** Why a file was skipped during ingest (Req 11.7). */
export type SkipReason = 'unsupported_format' | 'archive_too_deep';

/**
 * A successfully processed file: stored, chunked, embedded, and indexed
 * (Req 11.4, 11.5).
 */
export interface ProcessedFile {
  /** Discriminant: the file was fully processed. */
  status: 'processed';
  /** The persisted file record. */
  file: StoredFile;
  /** The number of chunks the extracted text was split into (Req 11.4). */
  chunkCount: number;
  /** The ids of the Vector_Store records created for the chunks (Req 11.5). */
  vectorIds: string[];
  /** Whether OCR was applied to extract the text (Req 11.3). */
  ocrApplied: boolean;
  /** The member path, when this file was extracted from an archive (Req 11.7). */
  archivePath?: string;
}

/**
 * A file rejected by the malware scan (Req 11.1).
 *
 * No chunks, embeddings, or Object_Store entries are created for a rejected
 * file (Property 27). The audit recording and storage-quota enforcement are the
 * Req 11.2 task.
 */
export interface RejectedFile {
  /** Discriminant: the file was rejected before any processing. */
  status: 'rejected';
  /** The reason for rejection. */
  reason: 'malware';
  /** The rejected file's name. */
  fileName: string;
  /** The scanner's detail, when provided. */
  detail?: string;
  /** The member path, when this file was extracted from an archive (Req 11.7). */
  archivePath?: string;
}

/**
 * A file skipped during archive expansion (Req 11.7).
 *
 * A ZIP archive's unsupported members are skipped (only supported members are
 * processed), as are members nested deeper than the archive recursion limit.
 */
export interface SkippedFile {
  /** Discriminant: the file was skipped. */
  status: 'skipped';
  /** Why the file was skipped. */
  reason: SkipReason;
  /** The skipped file's name. */
  fileName: string;
  /** The member path, when this file was extracted from an archive (Req 11.7). */
  archivePath?: string;
}

/** The outcome of processing a single file within an ingest. */
export type IngestOutcome = ProcessedFile | RejectedFile | SkippedFile;

/**
 * The report returned by {@link import('./file-processor.js').FileProcessor.ingest}.
 *
 * For a single (non-archive) upload, {@link files} holds exactly one outcome.
 * For a ZIP archive, it holds one outcome per supported member discovered
 * (recursively), plus a `skipped` outcome for each unsupported member
 * (Req 11.7).
 */
export interface IngestReport {
  /** One outcome per file the ingest processed, rejected, or skipped. */
  files: IngestOutcome[];
}
