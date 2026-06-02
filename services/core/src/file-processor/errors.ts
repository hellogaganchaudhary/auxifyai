/**
 * File_Processor typed errors (Req 11.1, 11.4, 11.6).
 *
 * The ingest path enforces its preconditions with dedicated, typed errors so
 * callers can branch on the exact violation without parsing messages:
 *
 *  - {@link UnsupportedFileTypeError} — a directly uploaded file's format is not
 *    one of the supported formats (Req 11.6). (Unsupported *members* of a ZIP
 *    archive are skipped rather than failing the whole ingest, Req 11.7.)
 *  - {@link EmptyArchiveError} — an uploaded ZIP archive expanded to no members
 *    (Req 11.7).
 *  - {@link EmbeddingCountError} — the {@link import('./types.js').Embedder}
 *    returned a number of embeddings that does not match the number of chunks,
 *    violating the one-embedding-per-chunk invariant (Req 11.4, Property 28).
 *  - {@link StorageQuotaExceededError} — persisting the upload would push the
 *    uploading user past the fixed 10 GB per-user storage quota (Req 11.8).
 *  - {@link OrganizationStorageQuotaExceededError} — persisting the upload would
 *    push the Organization past its configured storage quota (Req 11.9).
 *
 * Each projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, and carries structured `details` so a client can render an exact,
 * secret-free explanation.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** The stable machine-readable code for an unsupported uploaded file format (Req 11.6). */
export const UNSUPPORTED_FILE_FORMAT_CODE = 'UNSUPPORTED_FILE_FORMAT' as const;

/** The stable machine-readable code for an empty ZIP archive (Req 11.7). */
export const EMPTY_ARCHIVE_CODE = 'EMPTY_ARCHIVE' as const;

/** The stable machine-readable code for a chunk/embedding count mismatch (Req 11.4). */
export const EMBEDDING_COUNT_CODE = 'EMBEDDING_COUNT_MISMATCH' as const;

/** The stable machine-readable code for exceeding the per-user storage quota (Req 11.8). */
export const USER_STORAGE_QUOTA_CODE = 'USER_STORAGE_QUOTA_EXCEEDED' as const;

/** The stable machine-readable code for exceeding the per-Organization storage quota (Req 11.9). */
export const ORGANIZATION_STORAGE_QUOTA_CODE = 'ORGANIZATION_STORAGE_QUOTA_EXCEEDED' as const;

/**
 * Thrown when a directly uploaded file's format is outside the supported
 * catalog (Req 11.6).
 *
 * The offending {@link fileName} and declared {@link contentType} are carried so
 * the rejection can name the file without inspecting its bytes. Named for the
 * *format* dimension (Req 11.6) so it stays distinct from the Input_Processor's
 * attachment-type rejection (Req 7.1).
 */
export class UnsupportedFileFormatError extends Error {
  /** The name of the rejected file. */
  readonly fileName: string;
  /** The declared MIME type of the rejected file, when known. */
  readonly contentType: string | undefined;

  constructor(fileName: string, contentType?: string) {
    super(
      `File "${fileName}"${
        contentType !== undefined ? ` (${contentType})` : ''
      } is not a supported format ` +
        `(expected a document, spreadsheet, image, data, ZIP archive, or audio file)`,
    );
    this.name = 'UnsupportedFileFormatError';
    this.fileName = fileName;
    this.contentType = contentType;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link UNSUPPORTED_FILE_FORMAT_CODE}) (Req 11.6,
   * 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNSUPPORTED_FILE_FORMAT_CODE,
      message: this.message,
      correlationId,
      details: { fileName: this.fileName, contentType: this.contentType },
    });
  }
}

/**
 * Thrown when an uploaded ZIP archive contains no members to process (Req 11.7).
 *
 * Modelled as a validation error rather than an empty success so the caller can
 * tell the difference between "archive processed, nothing inside" and a silent
 * no-op.
 */
export class EmptyArchiveError extends Error {
  /** The name of the empty archive. */
  readonly fileName: string;

  constructor(fileName: string) {
    super(`Archive "${fileName}" contains no entries to process`);
    this.name = 'EmptyArchiveError';
    this.fileName = fileName;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link EMPTY_ARCHIVE_CODE}) (Req 11.7, 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: EMPTY_ARCHIVE_CODE,
      message: this.message,
      correlationId,
      details: { fileName: this.fileName },
    });
  }
}

/**
 * Thrown when the {@link import('./types.js').Embedder} returns a number of
 * embeddings that does not equal the number of chunks (Req 11.4, Property 28).
 *
 * This guards the one-embedding-per-chunk invariant: rather than index a
 * partial or mismatched set of vectors, the File_Processor fails closed so the
 * file is not left half-indexed.
 */
export class EmbeddingCountError extends Error {
  /** The number of chunks that were submitted for embedding. */
  readonly chunkCount: number;
  /** The number of embeddings the embedder returned. */
  readonly embeddingCount: number;

  constructor(chunkCount: number, embeddingCount: number) {
    super(
      `Embedder returned ${embeddingCount} embedding(s) for ${chunkCount} chunk(s); ` +
        `exactly one embedding per chunk is required`,
    );
    this.name = 'EmbeddingCountError';
    this.chunkCount = chunkCount;
    this.embeddingCount = embeddingCount;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `internal`, code {@link EMBEDDING_COUNT_CODE}) (Req 11.4, 46.8).
   * The mismatch is an internal contract violation, not client input, so it is
   * categorized `internal`.
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'internal',
      code: EMBEDDING_COUNT_CODE,
      message: this.message,
      correlationId,
      details: { chunkCount: this.chunkCount, embeddingCount: this.embeddingCount },
    });
  }
}

/**
 * Thrown when persisting an uploaded file would push the uploading user past
 * the fixed 10 GB per-user storage quota (Req 11.8).
 *
 * The check happens before any Object_Store write or Vector_Store index, so a
 * rejected upload leaves no chunks, embeddings, or object entries behind. The
 * {@link currentBytes}, {@link additionalBytes}, and {@link quotaBytes} are
 * carried so a client can render exactly how far over the limit the upload is.
 */
export class StorageQuotaExceededError extends Error {
  /** The id of the user whose quota would be exceeded. */
  readonly ownerId: string;
  /** The user's bytes already stored. */
  readonly currentBytes: number;
  /** The bytes the rejected upload would have added. */
  readonly additionalBytes: number;
  /** The fixed per-user quota in bytes (Req 11.8). */
  readonly quotaBytes: number;

  constructor(ownerId: string, currentBytes: number, additionalBytes: number, quotaBytes: number) {
    super(
      `Upload rejected: storing ${additionalBytes} more byte(s) would put user "${ownerId}" at ` +
        `${currentBytes + additionalBytes} bytes, over the ${quotaBytes}-byte per-user storage quota`,
    );
    this.name = 'StorageQuotaExceededError';
    this.ownerId = ownerId;
    this.currentBytes = currentBytes;
    this.additionalBytes = additionalBytes;
    this.quotaBytes = quotaBytes;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `quota_exceeded`, code {@link USER_STORAGE_QUOTA_CODE}) (Req 11.8,
   * 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'quota_exceeded',
      code: USER_STORAGE_QUOTA_CODE,
      message: this.message,
      correlationId,
      details: {
        ownerId: this.ownerId,
        currentBytes: this.currentBytes,
        additionalBytes: this.additionalBytes,
        quotaBytes: this.quotaBytes,
      },
    });
  }
}

/**
 * Thrown when persisting an uploaded file would push the Organization past its
 * configured storage quota (Req 11.9).
 *
 * Like {@link StorageQuotaExceededError}, the check happens before any durable
 * write, so a rejected upload leaves nothing behind. The
 * {@link currentBytes}, {@link additionalBytes}, and {@link quotaBytes} are
 * carried so a client can render exactly how far over the limit the upload is.
 */
export class OrganizationStorageQuotaExceededError extends Error {
  /** The id of the Organization whose quota would be exceeded. */
  readonly organizationId: string;
  /** The Organization's bytes already stored. */
  readonly currentBytes: number;
  /** The bytes the rejected upload would have added. */
  readonly additionalBytes: number;
  /** The Organization's configured quota in bytes (Req 11.9). */
  readonly quotaBytes: number;

  constructor(
    organizationId: string,
    currentBytes: number,
    additionalBytes: number,
    quotaBytes: number,
  ) {
    super(
      `Upload rejected: storing ${additionalBytes} more byte(s) would put Organization ` +
        `"${organizationId}" at ${currentBytes + additionalBytes} bytes, over its ` +
        `${quotaBytes}-byte storage quota`,
    );
    this.name = 'OrganizationStorageQuotaExceededError';
    this.organizationId = organizationId;
    this.currentBytes = currentBytes;
    this.additionalBytes = additionalBytes;
    this.quotaBytes = quotaBytes;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `quota_exceeded`, code {@link ORGANIZATION_STORAGE_QUOTA_CODE})
   * (Req 11.9, 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'quota_exceeded',
      code: ORGANIZATION_STORAGE_QUOTA_CODE,
      message: this.message,
      correlationId,
      details: {
        organizationId: this.organizationId,
        currentBytes: this.currentBytes,
        additionalBytes: this.additionalBytes,
        quotaBytes: this.quotaBytes,
      },
    });
  }
}
