/**
 * Document_Management_Service domain errors (Req 28.1-28.8).
 *
 * These make the service's not-found, fail-closed, validation, and
 * recovery-window conditions explicit and testable, and each projects into the
 * platform-wide serializable {@link PlatformError} shape (Req 46.8):
 *   - {@link DocumentNotFoundError} / {@link FolderNotFoundError} — a mutation or
 *     read targets a resource absent within the caller's Organization (tenant
 *     scoping already prevents cross-tenant reads, so "not in my tenant" surfaces
 *     as "not found");
 *   - {@link DocumentAccessDeniedError} — the {@link import('./types.js').DocAuthorizer}
 *     denied a view/edit/delete/manage action; the service records the denial in
 *     the Audit_Service before throwing (Req 28.8);
 *   - {@link InvalidFolderHierarchyError} — an organize/create would cross the
 *     document's Project or create a folder cycle (Req 28.2);
 *   - {@link RecoveryWindowExpiredError} — a recovery request arrives after the
 *     document's recovery window has elapsed (Req 28.7), so the document can no
 *     longer be restored from the Backup_Service.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { DocAction } from './types.js';

/** Stable machine-readable code for a missing document. */
export const DOCUMENT_NOT_FOUND_CODE = 'DOCUMENT_NOT_FOUND' as const;

/** Stable machine-readable code for a missing folder. */
export const FOLDER_NOT_FOUND_CODE = 'FOLDER_NOT_FOUND' as const;

/** Stable machine-readable code for a denied document access (Req 28.8). */
export const DOCUMENT_ACCESS_DENIED_CODE = 'DOCUMENT_ACCESS_DENIED' as const;

/** Stable machine-readable code for an invalid folder hierarchy edit (Req 28.2). */
export const INVALID_FOLDER_HIERARCHY_CODE = 'INVALID_FOLDER_HIERARCHY' as const;

/** Stable machine-readable code for an expired recovery window (Req 28.7). */
export const RECOVERY_WINDOW_EXPIRED_CODE = 'RECOVERY_WINDOW_EXPIRED' as const;

/**
 * Thrown when a document referenced by an operation does not exist within the
 * caller's Organization.
 */
export class DocumentNotFoundError extends Error {
  /** The document id that was looked up. */
  readonly documentId: string;

  constructor(documentId: string) {
    super(`Document "${documentId}" was not found in the current organization`);
    this.name = 'DocumentNotFoundError';
    this.documentId = documentId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: DOCUMENT_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { documentId: this.documentId },
    });
  }
}

/**
 * Thrown when a folder referenced by an operation does not exist within the
 * caller's Organization.
 */
export class FolderNotFoundError extends Error {
  /** The folder id that was looked up. */
  readonly folderId: string;

  constructor(folderId: string) {
    super(`Folder "${folderId}" was not found in the current organization`);
    this.name = 'FolderNotFoundError';
    this.folderId = folderId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: FOLDER_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { folderId: this.folderId },
    });
  }
}

/**
 * Thrown when the {@link import('./types.js').DocAuthorizer} denies a document
 * operation (Req 28.4). A denied access is recorded in the Audit_Service before
 * this is thrown (Req 28.8).
 */
export class DocumentAccessDeniedError extends Error {
  /** The document the action was attempted on. */
  readonly documentId: string;
  /** The attempted action. */
  readonly action: DocAction;
  /** The authorizer's reason for the denial. */
  readonly reason: string;

  constructor(documentId: string, action: DocAction, reason: string) {
    super(`Access denied: cannot "${action}" document "${documentId}": ${reason}`);
    this.name = 'DocumentAccessDeniedError';
    this.documentId = documentId;
    this.action = action;
    this.reason = reason;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8, 34.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authorization',
      code: DOCUMENT_ACCESS_DENIED_CODE,
      message: this.message,
      correlationId,
      details: { documentId: this.documentId, action: this.action },
    });
  }
}

/**
 * Thrown when an organize/create would place a document or folder under a folder
 * in a different Project, set a folder as its own ancestor, or create a folder
 * cycle (Req 28.2).
 */
export class InvalidFolderHierarchyError extends Error {
  /** The resource being placed. */
  readonly resourceId: string;
  /** The rejected target folder id. */
  readonly folderId: string;

  constructor(resourceId: string, folderId: string, reason: string) {
    super(`Cannot place "${resourceId}" under folder "${folderId}": ${reason}`);
    this.name = 'InvalidFolderHierarchyError';
    this.resourceId = resourceId;
    this.folderId = folderId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_FOLDER_HIERARCHY_CODE,
      message: this.message,
      correlationId,
      details: { resourceId: this.resourceId, folderId: this.folderId },
    });
  }
}

/**
 * Thrown when a {@link DocumentManagementService.recover} request arrives after
 * the document's recovery window has elapsed (Req 28.7).
 *
 * Past the window the document is permanently purged and can no longer be
 * restored from the Backup_Service; this fail-closed error names the deadline so
 * a caller can report exactly why recovery is no longer possible.
 */
export class RecoveryWindowExpiredError extends Error {
  /** The document whose recovery was attempted. */
  readonly documentId: string;
  /** The ISO-8601 instant the recovery window closed. */
  readonly recoverableUntil: string;

  constructor(documentId: string, recoverableUntil: string) {
    super(
      `Recovery window for document "${documentId}" closed at ${recoverableUntil}; the document can no longer be restored`,
    );
    this.name = 'RecoveryWindowExpiredError';
    this.documentId = documentId;
    this.recoverableUntil = recoverableUntil;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: RECOVERY_WINDOW_EXPIRED_CODE,
      message: this.message,
      correlationId,
      details: { documentId: this.documentId, recoverableUntil: this.recoverableUntil },
    });
  }
}
