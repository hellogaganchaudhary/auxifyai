/**
 * Input_Processor typed errors (Req 7.7, 7.8).
 *
 * The rich-input limits are enforced with dedicated, typed errors so callers
 * (and the limit unit tests, task 8.12) can branch on the exact violation
 * without parsing messages:
 *
 *  - {@link FileSizeLimitError} — an attached file exceeded {@link
 *    MAX_FILE_BYTES} (100 MB) (Req 7.7).
 *  - {@link AttachmentCountError} — a message would exceed {@link
 *    MAX_ATTACHMENTS} (10) attachments (Req 7.8).
 *
 * Both project into the platform-wide serializable {@link PlatformError}
 * (category `validation` for the oversized file, `quota_exceeded` for the
 * attachment-count cap) so the same wire shape crosses the REST_API, the
 * WebSocket_Gateway, and the SDK (Req 46.8). They carry the offending numbers
 * (size and limit; count and limit) in structured `details` so a client can
 * render an exact, secret-free explanation.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import { MAX_ATTACHMENTS, MAX_FILE_BYTES } from './limits.js';

/** The stable machine-readable code for an oversized-file rejection (Req 7.7). */
export const FILE_SIZE_LIMIT_CODE = 'FILE_SIZE_LIMIT_EXCEEDED' as const;

/** The stable machine-readable code for a too-many-attachments rejection (Req 7.8). */
export const ATTACHMENT_COUNT_CODE = 'ATTACHMENT_COUNT_EXCEEDED' as const;

/** The stable machine-readable code for an unsupported attachment file type (Req 7.1). */
export const UNSUPPORTED_FILE_TYPE_CODE = 'UNSUPPORTED_FILE_TYPE' as const;

/** The stable machine-readable code for an unresolved `@`-mention (Req 7.6). */
export const MENTION_NOT_FOUND_CODE = 'MENTION_NOT_FOUND' as const;

/**
 * Thrown when an attached file exceeds the {@link MAX_FILE_BYTES} (100 MB)
 * size limit (Req 7.7).
 *
 * The attempted {@link sizeBytes} and the enforced {@link limitBytes} are
 * carried on the error (and named in the message) so the rejection is
 * self-describing without re-deriving the boundary.
 */
export class FileSizeLimitError extends Error {
  /** The size of the rejected file, in bytes. */
  readonly sizeBytes: number;
  /** The enforced maximum size, in bytes ({@link MAX_FILE_BYTES}). */
  readonly limitBytes: number;
  /** The name of the rejected file, when known, for a clearer message. */
  readonly fileName: string | undefined;

  constructor(sizeBytes: number, fileName?: string) {
    super(
      `Attachment${fileName !== undefined ? ` "${fileName}"` : ''} is ${sizeBytes} bytes, ` +
        `which exceeds the ${MAX_FILE_BYTES}-byte (100 MB) per-file limit`,
    );
    this.name = 'FileSizeLimitError';
    this.sizeBytes = sizeBytes;
    this.limitBytes = MAX_FILE_BYTES;
    this.fileName = fileName;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link FILE_SIZE_LIMIT_CODE}), carrying the
   * attempted size and the enforced limit in structured `details` (Req 7.7,
   * 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: FILE_SIZE_LIMIT_CODE,
      message: this.message,
      correlationId,
      details: {
        sizeBytes: this.sizeBytes,
        limitBytes: this.limitBytes,
        fileName: this.fileName,
      },
    });
  }
}

/**
 * Thrown when adding an attachment would push a message past the {@link
 * MAX_ATTACHMENTS} (10) attachment limit (Req 7.8).
 *
 * The {@link currentCount} (attachments already on the message) and the
 * enforced {@link limit} are carried on the error so the caller can tell the
 * user exactly how many attachments the message already holds.
 */
export class AttachmentCountError extends Error {
  /** The number of attachments already associated with the message. */
  readonly currentCount: number;
  /** The enforced maximum attachment count ({@link MAX_ATTACHMENTS}). */
  readonly limit: number;
  /** The message the additional attachment was rejected from. */
  readonly messageId: string;

  constructor(messageId: string, currentCount: number) {
    super(
      `Message "${messageId}" already has ${currentCount} attachment(s); ` +
        `no more than ${MAX_ATTACHMENTS} attachments are allowed per message`,
    );
    this.name = 'AttachmentCountError';
    this.messageId = messageId;
    this.currentCount = currentCount;
    this.limit = MAX_ATTACHMENTS;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `quota_exceeded`, code {@link ATTACHMENT_COUNT_CODE}), carrying
   * the current count and the enforced limit in structured `details` (Req 7.8,
   * 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'quota_exceeded',
      code: ATTACHMENT_COUNT_CODE,
      message: this.message,
      correlationId,
      details: {
        messageId: this.messageId,
        currentCount: this.currentCount,
        limit: this.limit,
      },
    });
  }
}

/**
 * Thrown when a user attaches a file whose type is not one of the kinds Req 7.1
 * accepts (image, PDF, CSV, spreadsheet, or code).
 *
 * The offending {@link fileName} and declared {@link contentType} are carried
 * so the rejection can name the file without inspecting its bytes.
 */
export class UnsupportedFileTypeError extends Error {
  /** The name of the rejected file. */
  readonly fileName: string;
  /** The declared MIME type of the rejected file, when known. */
  readonly contentType: string | undefined;

  constructor(fileName: string, contentType?: string) {
    super(
      `Attachment "${fileName}"${
        contentType !== undefined ? ` (${contentType})` : ''
      } is not an accepted file type ` + `(expected image, PDF, CSV, spreadsheet, or code)`,
    );
    this.name = 'UnsupportedFileTypeError';
    this.fileName = fileName;
    this.contentType = contentType;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `validation`, code {@link UNSUPPORTED_FILE_TYPE_CODE}) (Req 7.1,
   * 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNSUPPORTED_FILE_TYPE_CODE,
      message: this.message,
      correlationId,
      details: { fileName: this.fileName, contentType: this.contentType },
    });
  }
}

/**
 * Thrown when an `@`-mention token resolves to nothing within the caller's
 * scope (Req 7.6).
 *
 * Modelled as a typed `not_found` rather than a silent empty result so the
 * processor fails closed: an unresolved mention never attaches an unverified
 * reference to the message context.
 */
export class MentionNotFoundError extends Error {
  /** The mention token (without the leading `@`) that could not be resolved. */
  readonly token: string;

  constructor(token: string) {
    super(`No team member, document, knowledge page, or project matched the mention "@${token}"`);
    this.name = 'MentionNotFoundError';
    this.token = token;
  }

  /**
   * Project this rejection into the platform-wide serializable error shape
   * (category `not_found`, code {@link MENTION_NOT_FOUND_CODE}) (Req 7.6,
   * 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: MENTION_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { token: this.token },
    });
  }
}
