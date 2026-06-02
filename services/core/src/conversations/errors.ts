/**
 * Conversation_Manager domain errors (Req 5, 6.6).
 *
 * These make the manager's not-found and fail-closed conditions explicit and
 * testable. {@link ConversationNotFoundError} and {@link MessageNotFoundError}
 * are raised when a mutation targets a resource that does not exist within the
 * caller's Organization (tenant scoping already prevents cross-tenant reads, so
 * "not in my tenant" surfaces as "not found"); {@link UnknownExportFormatError}
 * guards the export format selection (Req 5.7).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { ExportFormat } from './types.js';

/** Stable machine-readable code for a missing conversation. */
export const CONVERSATION_NOT_FOUND_CODE = 'CONVERSATION_NOT_FOUND' as const;

/** Stable machine-readable code for a missing message. */
export const MESSAGE_NOT_FOUND_CODE = 'MESSAGE_NOT_FOUND' as const;

/** Stable machine-readable code for an unsupported export format. */
export const UNKNOWN_EXPORT_FORMAT_CODE = 'UNKNOWN_EXPORT_FORMAT' as const;

/**
 * Thrown when a conversation referenced by a mutation does not exist within the
 * caller's Organization.
 */
export class ConversationNotFoundError extends Error {
  /** The conversation id that was looked up. */
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(`Conversation "${conversationId}" was not found in the current organization`);
    this.name = 'ConversationNotFoundError';
    this.conversationId = conversationId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: CONVERSATION_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { conversationId: this.conversationId },
    });
  }
}

/**
 * Thrown when a message referenced by a mutation (e.g. {@link pin}) does not
 * exist within the caller's Organization.
 */
export class MessageNotFoundError extends Error {
  /** The message id that was looked up. */
  readonly messageId: string;

  constructor(messageId: string) {
    super(`Message "${messageId}" was not found in the current organization`);
    this.name = 'MessageNotFoundError';
    this.messageId = messageId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: MESSAGE_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { messageId: this.messageId },
    });
  }
}

/**
 * Thrown when an export targets a format outside the supported set
 * (`md`/`pdf`/`json`/`html`, Req 5.7).
 */
export class UnknownExportFormatError extends Error {
  /** The unsupported format that was requested. */
  readonly format: string;

  constructor(format: string) {
    super(`Unsupported export format "${format}"; expected one of md, pdf, json, html`);
    this.name = 'UnknownExportFormatError';
    this.format = format;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNKNOWN_EXPORT_FORMAT_CODE,
      message: this.message,
      correlationId,
      details: { format: this.format },
    });
  }
}

/** Narrow runtime guard that a value is a supported {@link ExportFormat}. */
export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'md' || value === 'pdf' || value === 'json' || value === 'html';
}
