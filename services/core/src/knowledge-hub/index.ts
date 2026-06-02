/**
 * Knowledge_Hub_Service (Req 26.1-26.9): the native enterprise wiki.
 *
 * The Knowledge_Hub_Service manages Project-scoped "spaces" of richly authored
 * pages: it persists a page with its title, rich content, author, owning
 * Project, and creation timestamp (Req 26.1); maintains a parent-child hierarchy
 * and presents pages within a navigation tree (Req 26.2); versions a page on
 * every edit while retaining all prior versions (Req 26.3) and restores a prior
 * version as a new version entry (Req 26.4); records anchored comments and
 * notifies subscribers (Req 26.5); enforces a page's configured view/edit
 * permissions through an Access_Control seam on every operation (Req 26.6),
 * recording every denied modification in the Audit_Service (Req 26.9); generates
 * AI authoring drafts via a Chat_Service seam for the user to accept or reject
 * before saving (Req 26.7); and emits each page's content for ingestion on every
 * write so it is retrievable through RAG and Unified Search (Req 26.8).
 *
 * Every external capability is a narrow injectable port — the tenant-scoped
 * {@link PageStore}, the shared {@link import('../audit/index.js').AuditRecorder},
 * the {@link PageIngestionEmitter} (so it never hard-wires the
 * Knowledge_Ingestion_Service), the {@link PageNotifier}, the {@link PageAuthorizer}
 * (default {@link PermissionsPageAuthorizer}), and the {@link PageAuthoringModel}
 * (default {@link DeterministicPageAuthoringModel}) — so the service is pure
 * orchestration and fully unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * Surface:
 *   - {@link KnowledgeHubService} — the service; one method per acceptance
 *     criterion (createPage / setParent / navigationTree / edit / restoreVersion
 *     / comment / setPermissions / aiAuthor / acceptDraft / search, plus the
 *     listVersions / listComments / getPage reads).
 *   - {@link PageStore} / {@link PageIngestionEmitter} / {@link PageNotifier} /
 *     {@link PageAuthorizer} / {@link PageAuthoringModel} — the narrow injectable
 *     ports the service composes.
 *   - {@link buildNavigationTree} / {@link wouldCreateCycle} — the pure hierarchy
 *     core (Req 26.2); {@link searchPages} — the pure space-scoped search core.
 *   - {@link PermissionsPageAuthorizer} — the default permissions-based
 *     authorizer; {@link DeterministicPageAuthoringModel} — the default model-free
 *     authoring seam.
 *   - Domain types ({@link KnowledgePage}, {@link PageVersion},
 *     {@link PageComment}, {@link PagePermissions}, {@link RichContent},
 *     {@link DraftResult}, {@link PageTreeNode}, {@link PageSearchHit}, …) and the
 *     typed errors ({@link PageNotFoundError}, {@link PageVersionNotFoundError},
 *     {@link PageAccessDeniedError}, {@link InvalidPageHierarchyError}).
 *
 * The in-memory test fakes (an {@link PageStore}, a capturing audit recorder,
 * ingestion emitter and notifier, allow/deny authorizers, and the builders) live
 * in `./fakes.js` and are intentionally NOT re-exported from this barrel — they
 * would collide with the equally-named audit-recorder fakes of sibling modules
 * (conversations / prompts / artifacts) at the package barrel. Following the
 * established convention, the unit tests here import them directly from
 * `./fakes.js`.
 */

export {
  KnowledgeHubService,
  type KnowledgeHubServiceOptions,
  type PageIdGenerator,
} from './knowledge-hub-service.js';

export { buildNavigationTree, wouldCreateCycle } from './navigation.js';

export { searchPages } from './search.js';

export { PermissionsPageAuthorizer } from './page-authorizer.js';

export { DeterministicPageAuthoringModel } from './page-authoring.js';

export {
  PageNotFoundError,
  PageVersionNotFoundError,
  PageAccessDeniedError,
  InvalidPageHierarchyError,
  PAGE_NOT_FOUND_CODE,
  PAGE_VERSION_NOT_FOUND_CODE,
  PAGE_ACCESS_DENIED_CODE,
  INVALID_PAGE_HIERARCHY_CODE,
} from './errors.js';

export {
  RICH_CONTENT_FORMATS,
  PAGE_ACTIONS,
  DEFAULT_PAGE_PERMISSIONS,
  isRichContentFormat,
  type RichContentFormat,
  type RichContent,
  type PagePermissions,
  type KnowledgePage,
  type PageVersion,
  type PageComment,
  type PageInput,
  type CommentInput,
  type DraftResult,
  type PageTreeNode,
  type PageSearchHit,
  type PageAction,
  type PageAuthzDecision,
  type PageAuthorizer,
  type PageIngestionEvent,
  type PageIngestionEmitter,
  type PageAuthoringModel,
  type PageNotifier,
  type PageStore,
  type CreatePageRow,
  type UpdatePageContentRow,
  type PageContentWrite,
  type CreateCommentRow,
} from './types.js';
