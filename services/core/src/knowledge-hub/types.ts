/**
 * Knowledge_Hub_Service domain types and injectable ports (Req 26.1-26.9).
 *
 * The Knowledge_Hub_Service is the native enterprise wiki: Project-scoped
 * "spaces" of richly-authored pages arranged into a parent-child hierarchy,
 * versioned on every edit with a fully-retained history, commented with anchored
 * notes that notify subscribers, permission-gated through an Access_Control
 * seam, AI-assisted via the Chat_Service, and — on every write — emitted for
 * knowledge ingestion so the page is retrievable through RAG and Unified Search
 * (Req 26.8).
 *
 * These are the camelCase domain shapes the service returns to its callers,
 * distinct from the snake_case persistence rows of migration 0006
 * (`knowledge_pages` / `page_versions` / `page_comments`). The service composes
 * only the narrow ports declared here — a tenant-scoped {@link PageStore}, the
 * shared {@link import('../audit/index.js').AuditRecorder}, an injectable
 * {@link PageIngestionEmitter} (so it never hard-wires the
 * Knowledge_Ingestion_Service), a {@link PageNotifier}, a {@link PageAuthorizer}
 * (the Access_Control seam), and a {@link PageAuthoringModel} (the Chat_Service
 * seam) — so it stays pure orchestration and fully unit-testable with the
 * in-memory fakes in `./fakes.js`.
 *
 * Tenancy: a `knowledge_pages` row carries its `organization_id`; the
 * {@link PageStore} requires a {@link TenantContext} on every method and
 * confines the operation to the caller's Organization (Req 1.2, 1.4). The owning
 * Project is the page's "space" (Req 26.1) and `parentId` is the hierarchy edge
 * (Req 26.2).
 */

import type { Principal, SourceAttribution, TenantContext } from '@auxify/types';

/**
 * The serialization format of a page's {@link RichContent}.
 *
 * `markdown` is the platform's authoring default; `html` and `plaintext` are
 * accepted so an importer or AI author can supply either. The format selects how
 * a renderer displays the body, while {@link RichContent.text} is always the
 * indexable plain projection emitted for ingestion (Req 26.8).
 */
export type RichContentFormat = 'markdown' | 'html' | 'plaintext';

/** All {@link RichContentFormat} values, for validation and test generators. */
export const RICH_CONTENT_FORMATS: readonly RichContentFormat[] = [
  'markdown',
  'html',
  'plaintext',
] as const;

/**
 * A page's rich body (the design's `RichContent`, stored as JSONB).
 *
 * {@link text} is the canonical, indexable projection of the body: it is what
 * the page's full-text {@link KnowledgeHubService.search} matches on and what
 * the {@link PageIngestionEmitter} emits for RAG/Unified Search indexing
 * (Req 26.8), so it is always present even when a richer {@link blocks}
 * representation accompanies it.
 */
export interface RichContent {
  /** The body serialization format. */
  format: RichContentFormat;
  /** The canonical indexable text projection of the body (Req 26.8). */
  text: string;
}

/** Narrow runtime guard that a value is a supported {@link RichContentFormat}. */
export function isRichContentFormat(value: unknown): value is RichContentFormat {
  return typeof value === 'string' && (RICH_CONTENT_FORMATS as readonly string[]).includes(value);
}

/**
 * The configured view/edit permissions of a page (the design's
 * `PagePermissions`, stored as JSONB), enforced through the
 * {@link PageAuthorizer} on every operation (Req 26.6).
 *
 * By default a page inherits its Project space: every member of the owning
 * Project may view and edit it ({@link projectViewers}/{@link projectEditors}
 * both true). Explicit {@link viewerIds}/{@link editorIds} grant access to
 * additional principals beyond the Project. The page's author and an
 * Organization admin always retain access (see {@link PermissionsPageAuthorizer}).
 */
export interface PagePermissions {
  /** Whether all members of the owning Project may view the page (default true). */
  projectViewers: boolean;
  /** Whether all members of the owning Project may edit the page (default true). */
  projectEditors: boolean;
  /** Additional principal ids explicitly granted view access. */
  viewerIds: string[];
  /** Additional principal ids explicitly granted edit access. */
  editorIds: string[];
}

/** The default permissions for a newly created page: open to the owning Project. */
export const DEFAULT_PAGE_PERMISSIONS: PagePermissions = {
  projectViewers: true,
  projectEditors: true,
  viewerIds: [],
  editorIds: [],
};

/**
 * A knowledge page in its domain shape (Req 26.1-26.6).
 *
 * Mirrors the design's `KnowledgePage`. `version` is the current head version;
 * every edit bumps it and appends a retained {@link PageVersion} (Req 26.3).
 * `parentId` is the hierarchy edge within the page's Project space (Req 26.2);
 * `undefined` denotes a root page.
 */
export interface KnowledgePage {
  /** The page's stable unique id. */
  id: string;
  /** The Organization that owns the page (its tenant scope). */
  organizationId: string;
  /** The owning Project — the page's "space" (Req 26.1). */
  projectId: string;
  /** The parent page in the hierarchy, or `undefined` for a root page (Req 26.2). */
  parentId?: string;
  /** The page title (Req 26.1). */
  title: string;
  /** The page's rich body (Req 26.1). */
  content: RichContent;
  /** The author who created the page (Req 26.1). */
  authorId: string;
  /** The current head version number (starts at 1, bumped on every edit). */
  version: number;
  /** The configured view/edit permissions, enforced via Access_Control (Req 26.6). */
  permissions: PagePermissions;
  /** The ISO-8601 creation timestamp (Req 26.1). */
  createdAt: string;
  /** The ISO-8601 last-update timestamp. */
  updatedAt: string;
}

/**
 * A single retained version of a page's content (Req 26.3, 26.4).
 *
 * Every edit (and every restore) appends one of these; prior versions are never
 * mutated or removed, so the full history is always retrievable (the
 * version-retention invariant of Property 25).
 */
export interface PageVersion {
  /** The version row's id. */
  id: string;
  /** The page this version belongs to. */
  pageId: string;
  /** The version number (1, 2, 3, …). */
  version: number;
  /** The page content captured at this version. */
  content: RichContent;
  /** When this version was created. */
  createdAt: string;
}

/**
 * An anchored comment on a page (Req 26.5).
 *
 * `anchor` records where in the page the comment is attached (e.g. a block id or
 * text selection key) so the UI can render it inline.
 */
export interface PageComment {
  /** The comment's id. */
  id: string;
  /** The page the comment is attached to. */
  pageId: string;
  /** The comment author. */
  authorId: string;
  /** Where in the page the comment is anchored (Req 26.5). */
  anchor: string;
  /** The comment body. */
  body: string;
  /** When the comment was created. */
  createdAt: string;
}

/** Fields a caller supplies to create a page (Req 26.1). */
export interface PageInput {
  /** The owning Project — the page's space (Req 26.1). */
  projectId: string;
  /** The page title (Req 26.1). */
  title: string;
  /** The page's initial rich body (Req 26.1). */
  content: RichContent;
  /** The author; defaults to the acting principal. */
  authorId?: string;
  /** An optional parent page placing the new page within the hierarchy (Req 26.2). */
  parentId?: string;
  /** Optional initial permissions; defaults to {@link DEFAULT_PAGE_PERMISSIONS} (Req 26.6). */
  permissions?: PagePermissions;
  /** An explicit page id (defaults to a generated id). */
  id?: string;
}

/** Fields a caller supplies to add a comment to a page (Req 26.5). */
export interface CommentInput {
  /** Where in the page the comment is anchored (Req 26.5). */
  anchor: string;
  /** The comment body. */
  body: string;
  /** The comment author; defaults to the acting principal. */
  authorId?: string;
  /** An explicit comment id (defaults to a generated id). */
  id?: string;
}

/**
 * A proposed AI-authored draft, returned by {@link KnowledgeHubService.aiAuthor}
 * for the user to accept or reject *before* it is saved (Req 26.7).
 *
 * The draft is never persisted by `aiAuthor`; a caller persists it by passing it
 * to {@link KnowledgeHubService.acceptDraft} (which edits the page and so
 * versions + re-indexes it) or simply discards it to reject.
 */
export interface DraftResult {
  /** The page the draft was generated for. */
  pageId: string;
  /** The instruction the draft was generated from. */
  instruction: string;
  /** The proposed content (NOT yet saved). */
  draft: RichContent;
  /** The page head version the draft was generated against. */
  baseVersion: number;
}

/**
 * A node in a page's hierarchical navigation tree (Req 26.2).
 *
 * Produced by the pure {@link import('./navigation.js').buildNavigationTree};
 * children are ordered by title then id for a stable navigation rendering.
 */
export interface PageTreeNode {
  /** The page's id. */
  id: string;
  /** The page's title. */
  title: string;
  /** The parent page id, or `undefined` for a root node. */
  parentId?: string;
  /** The node's child pages, ordered by title then id. */
  children: PageTreeNode[];
}

/**
 * A page search hit ranked by relevance (Req 26.x search within a space).
 *
 * This is the Knowledge_Hub's space-scoped contains-ranking over page titles and
 * body text; the platform's authorized combined keyword + vector retrieval is
 * the Unified_Search_Service (Req 29).
 */
export interface PageSearchHit {
  /** The matching page. */
  page: KnowledgePage;
  /** The relevance score (higher is more relevant). */
  score: number;
  /** Whether the query matched the page title. */
  titleMatch: boolean;
  /** Whether the query matched the page body text. */
  bodyMatch: boolean;
}

/** The actions the {@link PageAuthorizer} gates (Req 26.6). */
export type PageAction = 'view' | 'edit' | 'comment' | 'manage';

/** All {@link PageAction} values, for iteration and test generators. */
export const PAGE_ACTIONS: readonly PageAction[] = ['view', 'edit', 'comment', 'manage'] as const;

/** A structured authorization verdict from the {@link PageAuthorizer} (Req 26.6). */
export interface PageAuthzDecision {
  /** Whether the action is permitted. */
  allowed: boolean;
  /** A human-readable reason for the verdict (used in the audited denial). */
  reason: string;
}

/**
 * The Access_Control seam the Knowledge_Hub_Service consults before every page
 * operation (Req 26.6, 26.9).
 *
 * Modelling authorization as a narrow port keeps the service decoupled from the
 * concrete Access_Control while still enforcing the page's configured view/edit
 * permissions; the default {@link import('./page-authorizer.js').PermissionsPageAuthorizer}
 * evaluates {@link PagePermissions} against the principal, and a production
 * deployment can inject one backed by the platform Access_Control without
 * changing the service. A denial is recorded by the service through the
 * {@link import('../audit/index.js').AuditRecorder} (Req 26.9).
 */
export interface PageAuthorizer {
  /**
   * Decide whether `principal` may perform `action` on `page`.
   *
   * @param principal The authenticated actor.
   * @param page The page being acted on.
   * @param action The attempted action.
   * @returns The structured {@link PageAuthzDecision}.
   */
  authorize(
    principal: Principal,
    page: KnowledgePage,
    action: PageAction,
  ): Promise<PageAuthzDecision>;
}

/**
 * The event emitted on every page write for knowledge ingestion (Req 26.8).
 *
 * Carries the page's indexable text projection and a complete
 * {@link SourceAttribution} so the Knowledge_Ingestion_Service can index the page
 * and downstream RAG/Unified Search can always cite it.
 */
export interface PageIngestionEvent {
  /** The page that was written. */
  pageId: string;
  /** The owning Project (space). */
  projectId: string;
  /** The page title. */
  title: string;
  /** The indexable plain-text projection of the page body. */
  text: string;
  /** The page head version the emitted content corresponds to. */
  version: number;
  /** The complete source attribution for the page (Req 24.4). */
  attribution: SourceAttribution;
}

/**
 * The ingestion-on-write seam (Req 26.8).
 *
 * The Knowledge_Hub_Service depends on this narrow port rather than the concrete
 * Knowledge_Ingestion_Service, so creating or updating a page emits its content
 * for indexing without a hard dependency on (or import cycle with) the ingestion
 * pipeline. Production wires an emitter that forwards to the
 * Knowledge_Ingestion_Service's `knowledge_hub` source; tests substitute a
 * capturing fake to assert the hook fires.
 */
export interface PageIngestionEmitter {
  /**
   * Emit a page's content for ingestion after a write (Req 26.8).
   *
   * @param ctx The tenant scope the page belongs to.
   * @param event The page content and attribution to index.
   */
  emit(ctx: TenantContext, event: PageIngestionEvent): Promise<void>;
}

/**
 * The Chat_Service seam used for AI authoring (Req 26.7).
 *
 * Given the page's current content, title, and a natural-language instruction,
 * it returns the proposed new content. The default
 * {@link import('./page-authoring.js').DeterministicPageAuthoringModel} is
 * model-free (so the lifecycle is testable without a model); production injects
 * one backed by the Chat_Service.
 */
export interface PageAuthoringModel {
  /**
   * Produce proposed page content from the current content and an instruction.
   *
   * @returns The proposed new {@link RichContent} (not yet saved).
   */
  author(input: { current: RichContent; title: string; instruction: string }): Promise<RichContent>;
}

/** Fields the {@link PageStore} needs to create a page and its version-1 row. */
export interface CreatePageRow {
  /** The new page id. */
  id: string;
  /** The version-1 history row id. */
  versionId: string;
  /** The owning Project (space). */
  projectId: string;
  /** The optional parent page id. */
  parentId?: string;
  /** The page title. */
  title: string;
  /** The page's initial body. */
  content: RichContent;
  /** The author. */
  authorId: string;
  /** The initial permissions. */
  permissions: PagePermissions;
}

/** Fields the {@link PageStore} needs to append a page version and advance the head. */
export interface UpdatePageContentRow {
  /** The next version-history row id. */
  versionId: string;
  /** The new page body. */
  content: RichContent;
}

/** The result of a content write: the advanced page head and the appended version. */
export interface PageContentWrite {
  /** The page after its head version was advanced. */
  page: KnowledgePage;
  /** The newly-appended retained version. */
  version: PageVersion;
}

/** Fields the {@link PageStore} needs to persist a comment. */
export interface CreateCommentRow {
  /** The comment id. */
  id: string;
  /** The page the comment is attached to. */
  pageId: string;
  /** The comment author. */
  authorId: string;
  /** The anchor location. */
  anchor: string;
  /** The comment body. */
  body: string;
}

/**
 * The tenant-scoped persistence port for knowledge pages, versions, and comments
 * (Req 26.1-26.5).
 *
 * Every method takes the caller's {@link TenantContext} so persistence is
 * automatically scoped to the Organization (Req 1.2, 1.4) — the service never
 * touches a backend directly. The concrete implementation is the tenant-scoped
 * repository over `knowledge_pages` / `page_versions` / `page_comments`; tests
 * substitute the in-memory {@link import('./fakes.js').InMemoryPageStore}.
 *
 * The store owns the *version-on-every-write* invariant (Req 26.3): {@link createPage}
 * persists the page head **and** its version-1 row, and {@link updateContent}
 * appends the next version row **and** advances the head — so a caller can never
 * write content without retaining a version.
 */
export interface PageStore {
  /** Create a page (head at version 1) and append its version-1 history row (Req 26.1, 26.3). */
  createPage(ctx: TenantContext, input: CreatePageRow): Promise<KnowledgePage>;
  /** Fetch a page by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<KnowledgePage | null>;
  /** List a Project space's pages within the caller's Organization (Req 26.2). */
  listByProject(ctx: TenantContext, projectId: string): Promise<KnowledgePage[]>;
  /**
   * Set (or clear, with `null`) a page's parent in the hierarchy (Req 26.2).
   * Returns the updated page, or `null` if no page matched.
   */
  setParent(
    ctx: TenantContext,
    id: string,
    parentId: string | null,
  ): Promise<KnowledgePage | null>;
  /**
   * Replace a page's content: append the next version-history row and advance
   * the head version (Req 26.3). Returns the {@link PageContentWrite}, or `null`
   * if no page matched within the caller's Organization.
   */
  updateContent(
    ctx: TenantContext,
    id: string,
    input: UpdatePageContentRow,
  ): Promise<PageContentWrite | null>;
  /**
   * Replace a page's permissions (Req 26.6). Returns the updated page, or `null`
   * if no page matched.
   */
  updatePermissions(
    ctx: TenantContext,
    id: string,
    permissions: PagePermissions,
  ): Promise<KnowledgePage | null>;
  /** List every retained version of a page, oldest first (Req 26.3, 26.4). */
  listVersions(ctx: TenantContext, id: string): Promise<PageVersion[]>;
  /** Fetch a single retained version of a page by version-row id, or `null` (Req 26.4). */
  getVersion(ctx: TenantContext, id: string, versionId: string): Promise<PageVersion | null>;
  /** Persist an anchored comment and return it (Req 26.5). */
  addComment(ctx: TenantContext, input: CreateCommentRow): Promise<PageComment>;
  /** List a page's comments, oldest first (Req 26.5). */
  listComments(ctx: TenantContext, pageId: string): Promise<PageComment[]>;
  /**
   * Return the principal ids subscribed to a page's activity, for comment
   * notification (Req 26.5).
   */
  listSubscribers(ctx: TenantContext, pageId: string): Promise<string[]>;
}

/**
 * The comment-notification seam (Req 26.5).
 *
 * When a comment is added, the service notifies the page's subscribers through
 * this narrow port (a notification service / mailer in production, a capturing
 * fake in tests).
 */
export interface PageNotifier {
  /**
   * Notify a page's subscribers about a new comment (Req 26.5).
   *
   * @param ctx The tenant scope.
   * @param notification The page, comment, and subscriber ids to notify.
   */
  notify(
    ctx: TenantContext,
    notification: { pageId: string; commentId: string; subscriberIds: string[] },
  ): Promise<void>;
}
