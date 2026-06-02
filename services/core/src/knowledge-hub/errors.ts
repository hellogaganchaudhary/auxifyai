/**
 * Knowledge_Hub_Service domain errors (Req 26.1-26.9).
 *
 * These make the service's not-found, fail-closed, and validation conditions
 * explicit and testable, and each projects into the platform-wide serializable
 * {@link PlatformError} shape (Req 46.8):
 *   - {@link PageNotFoundError} / {@link PageVersionNotFoundError} — a mutation or
 *     restore targets a resource absent within the caller's Organization (tenant
 *     scoping already prevents cross-tenant reads, so "not in my tenant" surfaces
 *     as "not found");
 *   - {@link PageAccessDeniedError} — the {@link import('./types.js').PageAuthorizer}
 *     denied a view/edit/comment/manage action; the service records the denial in
 *     the Audit_Service before throwing (Req 26.9);
 *   - {@link InvalidPageHierarchyError} — a `setParent` would create a cycle or
 *     cross the page's Project space (Req 26.2).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

import type { PageAction } from './types.js';

/** Stable machine-readable code for a missing page. */
export const PAGE_NOT_FOUND_CODE = 'PAGE_NOT_FOUND' as const;

/** Stable machine-readable code for a missing page version. */
export const PAGE_VERSION_NOT_FOUND_CODE = 'PAGE_VERSION_NOT_FOUND' as const;

/** Stable machine-readable code for a denied page access (Req 26.9). */
export const PAGE_ACCESS_DENIED_CODE = 'PAGE_ACCESS_DENIED' as const;

/** Stable machine-readable code for an invalid page hierarchy edit (Req 26.2). */
export const INVALID_PAGE_HIERARCHY_CODE = 'INVALID_PAGE_HIERARCHY' as const;

/**
 * Thrown when a page referenced by an operation does not exist within the
 * caller's Organization.
 */
export class PageNotFoundError extends Error {
  /** The page id that was looked up. */
  readonly pageId: string;

  constructor(pageId: string) {
    super(`Knowledge page "${pageId}" was not found in the current organization`);
    this.name = 'PageNotFoundError';
    this.pageId = pageId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: PAGE_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { pageId: this.pageId },
    });
  }
}

/**
 * Thrown when a {@link KnowledgeHubService.restoreVersion} targets a version that
 * does not exist for the page within the caller's Organization (Req 26.4).
 */
export class PageVersionNotFoundError extends Error {
  /** The page whose version was looked up. */
  readonly pageId: string;
  /** The version-row id that was looked up. */
  readonly versionId: string;

  constructor(pageId: string, versionId: string) {
    super(`Version "${versionId}" was not found for knowledge page "${pageId}"`);
    this.name = 'PageVersionNotFoundError';
    this.pageId = pageId;
    this.versionId = versionId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: PAGE_VERSION_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { pageId: this.pageId, versionId: this.versionId },
    });
  }
}

/**
 * Thrown when the {@link import('./types.js').PageAuthorizer} denies a page
 * operation (Req 26.6). A denied modification is recorded in the Audit_Service
 * before this is thrown (Req 26.9).
 */
export class PageAccessDeniedError extends Error {
  /** The page the action was attempted on. */
  readonly pageId: string;
  /** The attempted action. */
  readonly action: PageAction;
  /** The authorizer's reason for the denial. */
  readonly reason: string;

  constructor(pageId: string, action: PageAction, reason: string) {
    super(`Access denied: cannot "${action}" knowledge page "${pageId}": ${reason}`);
    this.name = 'PageAccessDeniedError';
    this.pageId = pageId;
    this.action = action;
    this.reason = reason;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8, 34.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'authorization',
      code: PAGE_ACCESS_DENIED_CODE,
      message: this.message,
      correlationId,
      details: { pageId: this.pageId, action: this.action },
    });
  }
}

/**
 * Thrown when a {@link KnowledgeHubService.setParent} would create a cycle in
 * the page tree, set a page as its own parent, or cross the page's Project space
 * (Req 26.2).
 */
export class InvalidPageHierarchyError extends Error {
  /** The page being re-parented. */
  readonly pageId: string;
  /** The rejected parent id. */
  readonly parentId: string;

  constructor(pageId: string, parentId: string, reason: string) {
    super(`Cannot place page "${pageId}" under parent "${parentId}": ${reason}`);
    this.name = 'InvalidPageHierarchyError';
    this.pageId = pageId;
    this.parentId = parentId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_PAGE_HIERARCHY_CODE,
      message: this.message,
      correlationId,
      details: { pageId: this.pageId, parentId: this.parentId },
    });
  }
}
