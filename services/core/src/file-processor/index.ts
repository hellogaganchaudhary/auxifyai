/**
 * File_Processor ingest path (Req 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7,
 * 11.8, 11.9).
 *
 * The File_Processor turns an uploaded file into retrievable knowledge. Its
 * entry point, {@link FileProcessor.ingest}, runs the pipeline in order:
 *
 *   - detect the file type, rejecting an unsupported direct upload with an
 *     {@link UnsupportedFileFormatError} (Req 11.1, 11.6);
 *   - scan for malware via the injectable {@link MalwareScanner} and
 *     short-circuit a flagged file to a {@link RejectedFile} outcome — recorded
 *     in the Audit_Service through the injectable {@link AuditRecorder} port —
 *     before any storage, chunking, embedding, or indexing occurs (Req 11.1,
 *     11.2, Property 27);
 *   - for a ZIP archive, expand it via the injectable {@link ArchiveExpander}
 *     and process each supported member recursively, skipping unsupported or
 *     too-deeply-nested members (Req 11.7);
 *   - enforce the fixed 10 GB per-user ({@link StorageQuotaExceededError},
 *     Req 11.8) and the configured per-Organization
 *     ({@link OrganizationStorageQuotaExceededError}, Req 11.9) storage quotas
 *     through the injectable {@link StorageUsageStore} before persisting bytes;
 *   - otherwise extract text via the injectable {@link TextExtractor}, running
 *     {@link OcrEngine} OCR for images and scanned pages (Req 11.3), split it
 *     into chunks ({@link chunkText}) and embed each chunk via the injectable
 *     {@link Embedder} — exactly one embedding per chunk, guarded by
 *     {@link EmbeddingCountError} (Req 11.4, Property 28);
 *   - persist the original bytes through the shared
 *     {@link import('../storage/index.js').ObjectStore} and index the chunk
 *     embeddings through the shared
 *     {@link import('../storage/index.js').VectorStore} as `file_chunk` records,
 *     then accrue the stored bytes against both storage scopes (Req 11.5, 11.8,
 *     11.9).
 *
 * Every external capability is a narrow injectable port and every durable
 * effect goes through a stable storage interface, so the processor is pure
 * orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`.
 */

export {
  FileProcessor,
  DEFAULT_MAX_ARCHIVE_DEPTH,
  USER_STORAGE_QUOTA_BYTES,
  type FileProcessorOptions,
  type FileIdGenerator,
  type IsoClock,
} from './file-processor.js';

export {
  detectFileType,
  isImageType,
  isArchiveType,
} from './file-types.js';

export {
  chunkText,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  type ChunkOptions,
} from './chunking.js';

export {
  UnsupportedFileFormatError,
  EmptyArchiveError,
  EmbeddingCountError,
  StorageQuotaExceededError,
  OrganizationStorageQuotaExceededError,
  UNSUPPORTED_FILE_FORMAT_CODE,
  EMPTY_ARCHIVE_CODE,
  EMBEDDING_COUNT_CODE,
  USER_STORAGE_QUOTA_CODE,
  ORGANIZATION_STORAGE_QUOTA_CODE,
} from './errors.js';

export {
  SUPPORTED_CATEGORIES,
  type SupportedCategory,
  type RawFile,
  type IngestFileInput,
  type DetectedFileType,
  type MalwareScanResult,
  type MalwareScanner,
  type ExtractedText,
  type TextExtractor,
  type OcrEngine,
  type Embedder,
  type ArchiveMember,
  type ArchiveExpander,
  type StorageUsageStore,
  type StoredFile,
  type IngestOutcomeStatus,
  type SkipReason,
  type ProcessedFile,
  type RejectedFile,
  type SkippedFile,
  type IngestOutcome,
  type IngestReport,
} from './types.js';
