/**
 * The Knowledge_Hub_Service (Req 26.1-26.9).
 *
 * The native enterprise wiki: it manages Project-scoped "spaces" of richly
 * authored pages arranged into a parent-child hierarchy, versioned on every edit
 * with a fully-retained history, commented with anchored notes that notify
 * subscribers, permission-gated through an Access_Control seam, AI-assisted via
 * the Chat_Service, and emitted for knowledge ingestion on every write so each
 * page is retrievable through RAG and Unified Search (Req 26.8).
 *
 * It composes only narrow injected ports so it is pure orchestration and fully
 * unit-testable without a database, a model, or a network:
 *
 *   - a tenant-scoped {@link PageStore} (satisfied by the page repository) —
 *     every operation is automatically confined to the caller's Organization
 *     (Req 1.2, 1.4) and the store owns the version-on-every-write invariant
 *     (Req 26.3);
 *   - the shared {@link AuditRecorder} — every mutation, and every *denied*
 *     modification (Req 26.9), is recorded in the immutable audit trail;
 *   - an injectable {@link PageIngestionEmitter} — every create/edit/restore
 *     emits the page's indexable content for ingestion (Req 26.8) **without** a
 *     hard dependency on the Knowledge_Ingestion_Service;
 *   - a {@link PageAuthorizer} (the Access_Control seam) — enforces the page's
 *     configured view/edit permissions on every operation (Req 26.6);
 *   - a {@link PageNotifier} — notifies subscribers when a comment is added
 *     (Req 26.5); and
 *   - a {@link PageAuthoringModel} (the Chat_Service seam) — generates an
 *     AI-authored draft for the user to accept or reject before saving (Req 26.7).
 *
 * Responsibilities mapped to acceptance criteria:
 *   - {@link createPage} — persists title/content/author/Project/timestamp,
 *     audited, and emitted for ingestion (Req 26.1, 26.8);
 *   - {@link setParent} — maintains the parent-child hierarchy, rejecting cycles
 *     (Req 26.2), audited;
 *   - {@link navigationTree} — presents the page within the hierarchical
 *     navigation tree (Req 26.2);
 *   - {@link edit} — creates a new version retaining all prior versions, audited,
 *     and emitted for ingestion (Req 26.3, 26.8);
 *   - {@link restoreVersion} — sets content to a selected version and records a
 *     new version entry, audited, and emitted (Req 26.4, 26.8);
 *   - {@link comment} — persists an anchored comment and notifies subscribers
 *     (Req 26.5), audited;
 *   - {@link setPermissions} — sets the page's view/edit permissions (Req 26.6),
 *     audited;
 *   - {@link aiAuthor} / {@link acceptDraft} — generates a draft via the
 *     Chat_Service seam and saves it only on explicit accept (Req 26.7);
 *   - permissions are enforced on *every* operation through the authorizer, and a
 *     denied modification is recorded in the Audit_Service before failing
 *     (Req 26.6, 26.9).
 */

import { randomUUID } from 'node:crypto';

import {
  tenantContextFromPrincipal,
  type Principal,
  type SourceAttribution,
  type TenantContext,
} from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import {
  InvalidPageHierarchyError,
  PageAccessDeniedError,
  PageNotFoundError,
  PageVersionNotFoundError,
} from './errors.js';
import { buildNavigationTree, wouldCreateCycle } from './navigation.js';
import { DeterministicPageAuthoringModel } from './page-authoring.js';
import { PermissionsPageAuthorizer } from './page-authorizer.js';
import { searchPages } from './search.js';
import {
  DEFAULT_PAGE_PERMISSIONS,
  type CommentInput,
  type DraftResult,
  type KnowledgePage,
  type PageAction,
  type PageAuthorizer,
  type PageComment,
  type PageIngestionEmitter,
  type PageIngestionEvent,
  type PageInput,
  type PageNotifier,
  type PagePermissions,
  type PageSearchHit,
  type PageStore,
  type PageTreeNode,
  type PageVersion,
  type RichContent,
} from './types.js';
import type { PageAuthoringModel } from './types.js';

/** Generates unique ids for pages, version rows, and comments (injectable for tests). */
export interface PageIdGenerator {
  /** A unique page id. */
  pageId(): string;
  /** A unique page-version row id. */
  versionId(): string;
  /** A unique comment id. */
  commentId(): string;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: PageIdGenerator = {
  pageId: () => randomUUID(),
  versionId: () => randomUUID(),
  commentId: () => randomUUID(),
};

/** Construction dependencies for the {@link KnowledgeHubService}. */
export interface KnowledgeHubServiceOptions {
  /** The pages store (tenant-scoped page repository). */
  pages: PageStore;
  /** The append-only audit sink; every mutation and denial is recorded (Req 26.9, 37.1). */
  audit: AuditRecorder;
  /** The ingestion-on-write emitter (Req 26.8); a narrow seam, not the concrete pipeline. */
  ingestion: PageIngestionEmitter;
  /** The comment-notification seam (Req 26.5). */
  notifier: PageNotifier;
  /**
   * The Access_Control seam enforcing page permissions (Req 26.6). Defaults to
   * the permissions-based {@link PermissionsPageAuthorizer}.
   */
  authorizer?: PageAuthorizer;
  /**
   * The Chat_Service seam for AI authoring (Req 26.7). Defaults to the model-free
   * {@link DeterministicPageAuthoringModel}.
   */
  authoringModel?: PageAuthoringModel;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: PageIdGenerator;
}

/**
 * The Knowledge_Hub_Service. Construct once with its ports, then call its
 * methods with the acting {@link Principal} (which carries the Organization
 * scope, the Project memberships permission checks use, and the default actor).
 */
export class KnowledgeHubService {
  private readonly pages: PageStore;
  private readonly audit: AuditRecorder;
  private readonly ingestion: PageIngestionEmitter;
  private readonly notifier: PageNotifier;
  private readonly authorizer: PageAuthorizer;
  private readonly authoringModel: PageAuthoringModel;
  private readonly ids: PageIdGenerator;

  constructor(options: KnowledgeHubServiceOptions) {
    this.pages = options.pages;
    this.audit = options.audit;
    this.ingestion = options.ingestion;
    this.notifier = options.notifier;
    this.authorizer = options.authorizer ?? new PermissionsPageAuthorizer();
    this.authoringModel = options.authoringModel ?? new DeterministicPageAuthoringModel();
    this.ids = options.idGenerator ?? defaultIdGenerator;
  }

  /**
   * Create a knowledge page, persisting its title, rich content, author, owning
   * Project (its space), and creation timestamp (Req 26.1); the store seeds its
   * version-1 history row (Req 26.3). When a `parentId` is supplied it must be a
   * page in the same Project space, placing the new page in the hierarchy
   * (Req 26.2). The creation is recorded in the Audit_Service and the page
   * content is emitted for ingestion so it is retrievable through RAG and
   * Unified Search (Req 26.8).
   */
  async createPage(principal: Principal, input: PageInput): Promise<KnowledgePage> {
    const ctx = this.contextFor(principal, input.projectId);
    // Validate the parent (if any) is a page in the same space.
    if (input.parentId !== undefined) {
      const parent = await this.pages.findById(ctx, input.parentId);
      if (parent === null) {
        throw new InvalidPageHierarchyError(
          input.id ?? '(new)',
          input.parentId,
          'parent page not found in the current organization',
        );
      }
      if (parent.projectId !== input.projectId) {
        throw new InvalidPageHierarchyError(
          input.id ?? '(new)',
          input.parentId,
          'parent page belongs to a different Project space',
        );
      }
    }

    const id = input.id ?? this.ids.pageId();
    const createRow = {
      id,
      versionId: this.ids.versionId(),
      projectId: input.projectId,
      title: input.title,
      content: input.content,
      authorId: input.authorId ?? principal.userId,
      permissions: input.permissions ?? cloneDefaultPermissions(),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    };
    const page = await this.pages.createPage(ctx, createRow);

    await this.audit.record(ctx, {
      action: 'knowledge_page.create',
      resourceType: 'knowledge_page',
      resourceId: page.id,
      metadata: { projectId: page.projectId, authorId: page.authorId, version: page.version },
    });
    await this.emitIngestion(ctx, page);
    return page;
  }

  /** Fetch a page by id within the caller's Organization, or `null`. */
  async getPage(principal: Principal, id: string): Promise<KnowledgePage | null> {
    const ctx = this.contextFor(principal);
    return this.pages.findById(ctx, id);
  }

  /**
   * Place a page under a parent page (or detach it, with `parentId === null`),
   * maintaining the parent-child hierarchy (Req 26.2). Requires edit permission
   * on the page (Req 26.6) and rejects a re-parent that crosses the Project
   * space or would create a cycle ({@link InvalidPageHierarchyError}). Audited.
   */
  async setParent(
    principal: Principal,
    pageId: string,
    parentId: string | null,
  ): Promise<void> {
    const ctx = this.contextFor(principal);
    const page = await this.requirePage(ctx, pageId);
    await this.requireAccess(ctx, principal, page, 'edit');

    if (parentId !== null) {
      const parent = await this.pages.findById(ctx, parentId);
      if (parent === null) {
        throw new InvalidPageHierarchyError(pageId, parentId, 'parent page not found');
      }
      if (parent.projectId !== page.projectId) {
        throw new InvalidPageHierarchyError(
          pageId,
          parentId,
          'parent page belongs to a different Project space',
        );
      }
      const siblings = await this.pages.listByProject(ctx, page.projectId);
      if (wouldCreateCycle(pageId, parentId, siblings)) {
        throw new InvalidPageHierarchyError(pageId, parentId, 'would create a hierarchy cycle');
      }
    }

    const updated = await this.pages.setParent(ctx, pageId, parentId);
    if (updated === null) {
      throw new PageNotFoundError(pageId);
    }
    await this.audit.record(ctx, {
      action: 'knowledge_page.set_parent',
      resourceType: 'knowledge_page',
      resourceId: pageId,
      metadata: { parentId },
    });
  }

  /**
   * Return the hierarchical navigation tree for a Project space (Req 26.2).
   *
   * Pages are loaded tenant-scoped for the space and assembled by the pure
   * {@link buildNavigationTree}. Reads are not audited.
   */
  async navigationTree(principal: Principal, projectId: string): Promise<PageTreeNode[]> {
    const ctx = this.contextFor(principal, projectId);
    const pages = await this.pages.listByProject(ctx, projectId);
    return buildNavigationTree(pages);
  }

  /**
   * Edit a page's content: create a new version and retain all prior versions in
   * the version history (Req 26.3). Requires edit permission (Req 26.6); a denied
   * attempt is recorded in the Audit_Service and rejected (Req 26.9). The edit is
   * audited and the new content is emitted for re-indexing (Req 26.8).
   */
  async edit(principal: Principal, pageId: string, content: RichContent): Promise<PageVersion> {
    const ctx = this.contextFor(principal);
    const page = await this.requirePage(ctx, pageId);
    await this.requireAccess(ctx, principal, page, 'edit');

    const write = await this.pages.updateContent(ctx, pageId, {
      versionId: this.ids.versionId(),
      content,
    });
    if (write === null) {
      // Existed a moment ago; a null here means it left the tenant scope. Fail closed.
      throw new PageNotFoundError(pageId);
    }
    await this.audit.record(ctx, {
      action: 'knowledge_page.edit',
      resourceType: 'knowledge_page',
      resourceId: pageId,
      metadata: { version: write.version.version },
    });
    await this.emitIngestion(ctx, write.page);
    return write.version;
  }

  /**
   * Restore a page to a prior version: set the page content to the selected
   * version and record a *new* version entry capturing that content (Req 26.4).
   * Requires edit permission (Req 26.6); a denial is audited and rejected
   * (Req 26.9). The restore is audited and the restored content is emitted for
   * re-indexing (Req 26.8). Raises {@link PageVersionNotFoundError} when the
   * version does not belong to the page.
   */
  async restoreVersion(
    principal: Principal,
    pageId: string,
    versionId: string,
  ): Promise<PageVersion> {
    const ctx = this.contextFor(principal);
    const page = await this.requirePage(ctx, pageId);
    await this.requireAccess(ctx, principal, page, 'edit');

    const target = await this.pages.getVersion(ctx, pageId, versionId);
    if (target === null) {
      throw new PageVersionNotFoundError(pageId, versionId);
    }
    // Restoring re-writes the selected content as a brand-new version (Req 26.4).
    const write = await this.pages.updateContent(ctx, pageId, {
      versionId: this.ids.versionId(),
      content: target.content,
    });
    if (write === null) {
      throw new PageNotFoundError(pageId);
    }
    await this.audit.record(ctx, {
      action: 'knowledge_page.restore_version',
      resourceType: 'knowledge_page',
      resourceId: pageId,
      metadata: { restoredFrom: target.version, newVersion: write.version.version },
    });
    await this.emitIngestion(ctx, write.page);
    return write.version;
  }

  /** List every retained version of a page, oldest first (Req 26.3, 26.4). */
  async listVersions(principal: Principal, pageId: string): Promise<PageVersion[]> {
    const ctx = this.contextFor(principal);
    await this.requirePage(ctx, pageId);
    return this.pages.listVersions(ctx, pageId);
  }

  /**
   * Add an anchored comment to a page and notify its subscribers (Req 26.5).
   *
   * Requires comment permission on the page (Req 26.6); a denial is audited and
   * rejected (Req 26.9). The comment is persisted with its author, anchor, and
   * timestamp, the action is audited, and the page's subscribers are notified.
   */
  async comment(principal: Principal, pageId: string, input: CommentInput): Promise<PageComment> {
    const ctx = this.contextFor(principal);
    const page = await this.requirePage(ctx, pageId);
    await this.requireAccess(ctx, principal, page, 'comment');

    const comment = await this.pages.addComment(ctx, {
      id: input.id ?? this.ids.commentId(),
      pageId,
      authorId: input.authorId ?? principal.userId,
      anchor: input.anchor,
      body: input.body,
    });
    await this.audit.record(ctx, {
      action: 'knowledge_page.comment',
      resourceType: 'knowledge_page',
      resourceId: pageId,
      metadata: { commentId: comment.id, anchor: comment.anchor },
    });
    const subscribers = await this.pages.listSubscribers(ctx, pageId);
    // Don't notify the comment's own author of their own comment.
    const recipients = subscribers.filter((s) => s !== comment.authorId);
    await this.notifier.notify(ctx, {
      pageId,
      commentId: comment.id,
      subscriberIds: recipients,
    });
    return comment;
  }

  /** List a page's comments, oldest first (Req 26.5). */
  async listComments(principal: Principal, pageId: string): Promise<PageComment[]> {
    const ctx = this.contextFor(principal);
    await this.requirePage(ctx, pageId);
    return this.pages.listComments(ctx, pageId);
  }

  /**
   * Set a page's view/edit permissions (Req 26.6).
   *
   * Requires `manage` permission on the page (Req 26.6); a denial is audited and
   * rejected (Req 26.9). The new permissions are persisted and the action is
   * audited. Setting permissions is configuration, not content, so it does not
   * re-emit the page for ingestion.
   */
  async setPermissions(
    principal: Principal,
    pageId: string,
    permissions: PagePermissions,
  ): Promise<void> {
    const ctx = this.contextFor(principal);
    const page = await this.requirePage(ctx, pageId);
    await this.requireAccess(ctx, principal, page, 'manage');

    const updated = await this.pages.updatePermissions(ctx, pageId, permissions);
    if (updated === null) {
      throw new PageNotFoundError(pageId);
    }
    await this.audit.record(ctx, {
      action: 'knowledge_page.set_permissions',
      resourceType: 'knowledge_page',
      resourceId: pageId,
      metadata: {
        projectViewers: permissions.projectViewers,
        projectEditors: permissions.projectEditors,
        viewerCount: permissions.viewerIds.length,
        editorCount: permissions.editorIds.length,
      },
    });
  }

  /**
   * Generate AI authoring assistance for a page and return the proposed draft for
   * the user to accept or reject *before* saving (Req 26.7).
   *
   * Requires edit permission (Req 26.6); a denial is audited and rejected
   * (Req 26.9). The draft is produced through the {@link PageAuthoringModel}
   * (Chat_Service) seam and is **not** persisted: a caller saves it by passing it
   * to {@link acceptDraft} (which edits, versions, and re-indexes the page) or
   * discards it to reject.
   */
  async aiAuthor(
    principal: Principal,
    pageId: string,
    instruction: string,
  ): Promise<DraftResult> {
    const ctx = this.contextFor(principal);
    const page = await this.requirePage(ctx, pageId);
    await this.requireAccess(ctx, principal, page, 'edit');

    const draft = await this.authoringModel.author({
      current: page.content,
      title: page.title,
      instruction,
    });
    await this.audit.record(ctx, {
      action: 'knowledge_page.ai_author',
      resourceType: 'knowledge_page',
      resourceId: pageId,
      metadata: { baseVersion: page.version },
    });
    return { pageId, instruction, draft, baseVersion: page.version };
  }

  /**
   * Accept a previously generated {@link DraftResult} (Req 26.7), saving it as a
   * new page version. This delegates to {@link edit} so the accepted content is
   * versioned (Req 26.3), audited, and emitted for ingestion (Req 26.8) exactly
   * like any other edit. Rejecting a draft requires no call — the caller simply
   * discards it.
   */
  async acceptDraft(principal: Principal, draft: DraftResult): Promise<PageVersion> {
    return this.edit(principal, draft.pageId, draft.draft);
  }

  /**
   * Search a Project space's pages by free text, ranked by relevance (Req 26.x).
   *
   * Scope is the space's pages within the caller's Organization; ranking is the
   * pure {@link searchPages} contains-ranking over title + body. The authorized
   * combined keyword + vector retrieval across all content is the
   * Unified_Search_Service (Req 29). Reads are not audited.
   */
  async search(
    principal: Principal,
    projectId: string,
    query: string,
  ): Promise<PageSearchHit[]> {
    const ctx = this.contextFor(principal, projectId);
    const pages = await this.pages.listByProject(ctx, projectId);
    return searchPages(pages, query);
  }

  /** Build the tenant context for the principal, optionally narrowed to a Project. */
  private contextFor(principal: Principal, projectId?: string): TenantContext {
    return projectId !== undefined
      ? tenantContextFromPrincipal(principal, { projectId })
      : tenantContextFromPrincipal(principal);
  }

  /** Fetch a page or fail closed with {@link PageNotFoundError}. */
  private async requirePage(ctx: TenantContext, pageId: string): Promise<KnowledgePage> {
    const page = await this.pages.findById(ctx, pageId);
    if (page === null) {
      throw new PageNotFoundError(pageId);
    }
    return page;
  }

  /**
   * Enforce the page's configured permissions for an action; on denial record an
   * audited `access.denied`-style event and throw {@link PageAccessDeniedError}
   * (Req 26.6, 26.9).
   */
  private async requireAccess(
    ctx: TenantContext,
    principal: Principal,
    page: KnowledgePage,
    action: PageAction,
  ): Promise<void> {
    const decision = await this.authorizer.authorize(principal, page, action);
    if (!decision.allowed) {
      await this.audit.record(ctx, {
        action: 'knowledge_page.access_denied',
        resourceType: 'knowledge_page',
        resourceId: page.id,
        actorId: principal.userId,
        metadata: { attemptedAction: action, reason: decision.reason },
      });
      throw new PageAccessDeniedError(page.id, action, decision.reason);
    }
  }

  /** Emit a page's content for ingestion after a write (Req 26.8). */
  private async emitIngestion(ctx: TenantContext, page: KnowledgePage): Promise<void> {
    const event: PageIngestionEvent = {
      pageId: page.id,
      projectId: page.projectId,
      title: page.title,
      text: page.content.text,
      version: page.version,
      attribution: pageAttribution(page),
    };
    await this.ingestion.emit(ctx, event);
  }
}

/** A fresh copy of the default permissions so callers never share the constant. */
function cloneDefaultPermissions(): PagePermissions {
  return {
    projectViewers: DEFAULT_PAGE_PERMISSIONS.projectViewers,
    projectEditors: DEFAULT_PAGE_PERMISSIONS.projectEditors,
    viewerIds: [...DEFAULT_PAGE_PERMISSIONS.viewerIds],
    editorIds: [...DEFAULT_PAGE_PERMISSIONS.editorIds],
  };
}

/** Build a complete {@link SourceAttribution} for a page (Req 24.4, 26.8). */
function pageAttribution(page: KnowledgePage): SourceAttribution {
  return {
    sourceId: page.id,
    sourceTitle: page.title,
    location: `project:${page.projectId}`,
    link: `knowledge-hub://pages/${page.id}`,
  };
}
