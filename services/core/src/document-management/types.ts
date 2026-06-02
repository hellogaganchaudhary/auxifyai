/**
 * Document_Management_Service domain types and injectable ports (Req 28.1-28.8).
 *
 * The Document_Management_Service is the native enterprise document store:
 * Project-scoped documents whose original bytes live in the Object_Store and
 * whose metadata (name, owning Project, owner, size, content type, version) is
 * persisted alongside (Req 28.1); organized into a folder hierarchy and
 * presented within their folders (Req 28.2); versioned on every new upload with
 * a fully-retained version history (Req 28.3); permission-gated through an
 * Access_Control seam on every operation, recording every denied access in the
 * Audit_Service (Req 28.4, 28.8); emitted for knowledge ingestion on every write
 * so the content is retrievable through RAG and Unified Search (Req 28.5);
 * governed by a configured retention action applied through a Compliance_Manager
 * seam when the retention period elapses (Req 28.6); and protected by a
 * recovery window — a soft-delete that moves a document to "trash" from which it
 * can be restored through a Backup_Service seam while the window is open, and
 * permanently purged once it has elapsed (Req 28.7).
 *
 * These are the camelCase domain shapes the service returns to its callers,
 * distinct from the snake_case persistence rows. The service composes only the
 * narrow ports declared here — a tenant-scoped {@link DocumentStore}, the shared
 * {@link import('../audit/index.js').AuditRecorder}, an injectable
 * {@link DocumentIngestionEmitter} (so it never hard-wires the
 * Knowledge_Ingestion_Service), a {@link DocAuthorizer} (the Access_Control
 * seam), a {@link DocumentBackupStore} (the Backup_Service seam), a
 * {@link DocumentComplianceManager} (the Compliance_Manager seam), a
 * {@link DocumentClock} (so the recovery window is testable), and the shared
 * {@link import('../storage/index.js').ObjectStore} for original bytes — so it
 * stays pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`.
 *
 * Tenancy: every document/folder carries its `organizationId`; the
 * {@link DocumentStore} requires a {@link TenantContext} on every method and
 * confines the operation to the caller's Organization (Req 1.2, 1.4). The owning
 * Project (Req 28.1) and a document's `folderId` (Req 28.2) place it within the
 * tenant's content tree.
 */

import type { Principal, SourceAttribution, TenantContext } from '@auxify/types';

/**
 * The configured view/edit permissions of a document or folder (the design's
 * `DocPermissions`, stored as JSONB), enforced through the {@link DocAuthorizer}
 * on every document operation (Req 28.4).
 *
 * By default a document inherits its Project: every member of the owning Project
 * may view and edit it ({@link projectViewers}/{@link projectEditors} both
 * true). Explicit {@link viewerIds}/{@link editorIds} grant access to additional
 * principals beyond the Project. The document's owner and an Organization admin
 * always retain access (see {@link import('./doc-authorizer.js').PermissionsDocAuthorizer}).
 */
export interface DocPermissions {
  /** Whether all members of the owning Project may view the document (default true). */
  projectViewers: boolean;
  /** Whether all members of the owning Project may edit the document (default true). */
  projectEditors: boolean;
  /** Additional principal ids explicitly granted view access. */
  viewerIds: string[];
  /** Additional principal ids explicitly granted edit access. */
  editorIds: string[];
}

/** The default permissions for a newly uploaded document: open to the owning Project. */
export const DEFAULT_DOC_PERMISSIONS: DocPermissions = {
  projectViewers: true,
  projectEditors: true,
  viewerIds: [],
  editorIds: [],
};

/**
 * The configured action the Compliance_Manager applies when a document reaches
 * the end of its retention period (Req 28.6).
 *
 * `delete` soft-deletes the document into the recovery window (so a retention
 * deletion is itself still recoverable, Req 28.7); `archive` moves it out of the
 * active listings into long-term archival.
 */
export type RetentionAction = 'delete' | 'archive';

/** All {@link RetentionAction} values, for iteration, validation, and test generators. */
export const RETENTION_ACTIONS: readonly RetentionAction[] = ['delete', 'archive'] as const;

/** Narrow runtime guard that a value is a supported {@link RetentionAction}. */
export function isRetentionAction(value: unknown): value is RetentionAction {
  return typeof value === 'string' && (RETENTION_ACTIONS as readonly string[]).includes(value);
}

/**
 * A managed document in its domain shape (Req 28.1-28.7).
 *
 * Mirrors the design's `Document`. The original bytes live in the Object_Store
 * under {@link objectKey}; {@link version} is the current head version, bumped on
 * every new upload (Req 28.3). {@link folderId} places the document within the
 * folder hierarchy (Req 28.2); `undefined` denotes the Project root. When
 * {@link deletedAt} is set the document is in "trash" and recoverable while the
 * recovery window is open (Req 28.7); when {@link archivedAt} is set it has been
 * archived by a retention action (Req 28.6).
 */
export interface Document {
  /** The document's stable unique id. */
  id: string;
  /** The Organization that owns the document (its tenant scope). */
  organizationId: string;
  /** The owning Project (Req 28.1). */
  projectId: string;
  /** The document owner (Req 28.1). */
  ownerId: string;
  /** The containing folder, or `undefined` for the Project root (Req 28.2). */
  folderId?: string;
  /** The document name (Req 28.1). */
  name: string;
  /** The MIME content type (Req 28.1). */
  contentType: string;
  /** The current head size in bytes (Req 28.1). */
  sizeBytes: number;
  /** The current head version number (starts at 1, bumped on every new upload). */
  version: number;
  /** The Object_Store key the current head bytes are persisted under (Req 28.1). */
  objectKey: string;
  /** The configured view/edit permissions, enforced via Access_Control (Req 28.4). */
  permissions: DocPermissions;
  /** The configured retention action applied when retention elapses (Req 28.6). */
  retentionAction?: RetentionAction;
  /** The ISO-8601 instant at which the retention period elapses (Req 28.6). */
  retentionUntil?: string;
  /** The ISO-8601 instant the document was soft-deleted into trash (Req 28.7). */
  deletedAt?: string;
  /** The ISO-8601 instant the document was archived by a retention action (Req 28.6). */
  archivedAt?: string;
  /** The ISO-8601 creation timestamp. */
  createdAt: string;
  /** The ISO-8601 last-update timestamp. */
  updatedAt: string;
}

/**
 * A single retained version of a document (Req 28.3).
 *
 * Every new upload appends one of these and advances the document head; prior
 * versions are never mutated or removed, so the full history is always
 * retrievable. The version's bytes live in the Object_Store under
 * {@link objectKey}.
 */
export interface DocumentVersion {
  /** The version row's id. */
  id: string;
  /** The document this version belongs to. */
  documentId: string;
  /** The version number (1, 2, 3, …). */
  version: number;
  /** The Object_Store key this version's bytes are persisted under. */
  objectKey: string;
  /** The version's content type. */
  contentType: string;
  /** The version's size in bytes. */
  sizeBytes: number;
  /** When this version was created. */
  createdAt: string;
}

/**
 * A folder in the document hierarchy (Req 28.2).
 *
 * Mirrors the design's `Folder`. `parentId` is the hierarchy edge within the
 * folder's Project; `undefined` denotes a root folder. Folder permissions are
 * optional configuration set by an administrator (Req 28.4).
 */
export interface Folder {
  /** The folder's stable unique id. */
  id: string;
  /** The Organization that owns the folder (its tenant scope). */
  organizationId: string;
  /** The owning Project (Req 28.2). */
  projectId: string;
  /** The parent folder, or `undefined` for a root folder (Req 28.2). */
  parentId?: string;
  /** The folder name (Req 28.2). */
  name: string;
  /** Optional configured permissions for the folder (Req 28.4). */
  permissions?: DocPermissions;
}

/** Fields a caller supplies to upload a new document (Req 28.1). */
export interface DocumentInput {
  /** The owning Project (Req 28.1). */
  projectId: string;
  /** The document name (Req 28.1). */
  name: string;
  /** The MIME content type (Req 28.1). */
  contentType: string;
  /** The original file payload to store in the Object_Store (Req 28.1). */
  bytes: Uint8Array;
  /** An optional containing folder placing the document in the hierarchy (Req 28.2). */
  folderId?: string;
  /** The owner; defaults to the acting principal. */
  ownerId?: string;
  /** Optional initial permissions; defaults to {@link DEFAULT_DOC_PERMISSIONS} (Req 28.4). */
  permissions?: DocPermissions;
  /** Optional configured retention action (Req 28.6). */
  retentionAction?: RetentionAction;
  /** Optional ISO-8601 retention deadline (Req 28.6). */
  retentionUntil?: string;
  /** An explicit document id (defaults to a generated id). */
  id?: string;
}

/**
 * A new uploaded payload for {@link DocumentManagementService.addVersion}
 * (Req 28.3).
 *
 * Named distinctly from the Input_Processor's `UploadedFile` (which it overlaps
 * in spirit) so the two never collide at the package barrel. `sizeBytes`
 * defaults to `bytes.length` and `contentType` defaults to the document's
 * current head content type when omitted.
 */
export interface DocumentUpload {
  /** The new version's file payload to store in the Object_Store. */
  bytes: Uint8Array;
  /** The new version's content type; defaults to the document's current type. */
  contentType?: string;
  /** The new version's size; defaults to `bytes.length`. */
  sizeBytes?: number;
}

/** Fields a caller supplies to create a folder (Req 28.2). */
export interface FolderInput {
  /** The owning Project (Req 28.2). */
  projectId: string;
  /** The folder name (Req 28.2). */
  name: string;
  /** An optional parent folder placing the new folder in the hierarchy (Req 28.2). */
  parentId?: string;
  /** Optional initial permissions (Req 28.4). */
  permissions?: DocPermissions;
  /** An explicit folder id (defaults to a generated id). */
  id?: string;
}

/**
 * The target of a {@link DocumentManagementService.setPermissions} call — a
 * document or a folder (Req 28.4).
 *
 * The design's `DocTarget`: an administrator may set permissions on either an
 * individual document or a folder.
 */
export type DocTarget =
  | { readonly kind: 'document'; readonly id: string }
  | { readonly kind: 'folder'; readonly id: string };

/** The actions the {@link DocAuthorizer} gates (Req 28.4). */
export type DocAction = 'view' | 'edit' | 'delete' | 'manage';

/** All {@link DocAction} values, for iteration and test generators. */
export const DOC_ACTIONS: readonly DocAction[] = ['view', 'edit', 'delete', 'manage'] as const;

/** A structured authorization verdict from the {@link DocAuthorizer} (Req 28.4). */
export interface DocAuthzDecision {
  /** Whether the action is permitted. */
  allowed: boolean;
  /** A human-readable reason for the verdict (used in the audited denial, Req 28.8). */
  reason: string;
}

/**
 * The Access_Control seam the Document_Management_Service consults before every
 * document operation (Req 28.4, 28.8).
 *
 * Modelling authorization as a narrow port keeps the service decoupled from the
 * concrete Access_Control while still enforcing the document's configured
 * view/edit permissions; the default
 * {@link import('./doc-authorizer.js').PermissionsDocAuthorizer} evaluates
 * {@link DocPermissions} against the principal, and a production deployment can
 * inject one backed by the platform Access_Control without changing the service.
 * A denial is recorded by the service through the
 * {@link import('../audit/index.js').AuditRecorder} (Req 28.8).
 */
export interface DocAuthorizer {
  /**
   * Decide whether `principal` may perform `action` on `document`.
   *
   * @param principal The authenticated actor.
   * @param document The document being acted on.
   * @param action The attempted action.
   * @returns The structured {@link DocAuthzDecision}.
   */
  authorize(
    principal: Principal,
    document: Document,
    action: DocAction,
  ): Promise<DocAuthzDecision>;
}

/**
 * The event emitted on every document write for knowledge ingestion (Req 28.5).
 *
 * Carries a reference to the stored bytes and a complete
 * {@link SourceAttribution} so the Knowledge_Ingestion_Service can index the
 * document content and downstream RAG/Unified Search can always cite it.
 */
export interface DocumentIngestionEvent {
  /** The document that was written. */
  documentId: string;
  /** The owning Project. */
  projectId: string;
  /** The document name. */
  name: string;
  /** The MIME content type, selecting how the content is parsed for indexing. */
  contentType: string;
  /** The Object_Store key the indexed bytes are stored under. */
  objectKey: string;
  /** The document head version the emitted content corresponds to. */
  version: number;
  /** The complete source attribution for the document (Req 24.4). */
  attribution: SourceAttribution;
}

/**
 * The ingestion-on-write seam (Req 28.5).
 *
 * The Document_Management_Service depends on this narrow port rather than the
 * concrete Knowledge_Ingestion_Service, so storing or updating a document emits
 * its content for indexing without a hard dependency on (or import cycle with)
 * the ingestion pipeline. Production wires an emitter that forwards to the
 * Knowledge_Ingestion_Service's `document_management` source; tests substitute a
 * capturing fake to assert the hook fires.
 */
export interface DocumentIngestionEmitter {
  /**
   * Emit a document's content for ingestion after a write (Req 28.5).
   *
   * @param ctx The tenant scope the document belongs to.
   * @param event The document content reference and attribution to index.
   */
  emit(ctx: TenantContext, event: DocumentIngestionEvent): Promise<void>;
}

/**
 * A captured backup of a soft-deleted document (Req 28.7).
 *
 * Snapshots the document's metadata, its complete retained version history, and
 * the Object_Store bytes keyed by object key, so the Backup_Service can restore
 * the document exactly while the recovery window is open.
 */
export interface DocumentBackup {
  /** The document metadata at the moment of deletion. */
  document: Document;
  /** The complete retained version history at the moment of deletion (Req 28.3). */
  versions: DocumentVersion[];
  /** The Object_Store bytes for every version, keyed by object key. */
  bytesByObjectKey: Record<string, Uint8Array>;
}

/**
 * The Backup_Service seam used to restore a document within the recovery window
 * (Req 28.7).
 *
 * On soft-delete the service {@link capture}s a {@link DocumentBackup}; on a
 * recovery request within the window it {@link fetch}es the backup and restores
 * the document; on a permanent purge (or a successful restore) it
 * {@link discard}s the backup. Modelling it as a narrow port keeps the service
 * decoupled from the concrete Backup_Service.
 */
export interface DocumentBackupStore {
  /** Capture a backup of a document being soft-deleted (Req 28.7). */
  capture(ctx: TenantContext, backup: DocumentBackup): Promise<void>;
  /** Fetch a captured backup for a document, or `null` if none exists (Req 28.7). */
  fetch(ctx: TenantContext, documentId: string): Promise<DocumentBackup | null>;
  /** Discard a captured backup (after a successful restore or permanent purge). */
  discard(ctx: TenantContext, documentId: string): Promise<void>;
}

/**
 * The Compliance_Manager seam used to apply a document's retention action when
 * its retention period elapses (Req 28.6).
 *
 * The service detects documents past their retention deadline and delegates the
 * configured deletion/archival action to this port; the Compliance_Manager
 * applies the action and records it in the Audit_Service (Req 28.6). Modelling
 * it as a narrow port keeps the service decoupled from the concrete
 * Compliance_Manager.
 */
export interface DocumentComplianceManager {
  /**
   * Apply a document's configured retention action (Req 28.6).
   *
   * @param ctx The tenant scope.
   * @param input The document and the action (delete/archive) to apply.
   */
  applyRetention(
    ctx: TenantContext,
    input: { document: Document; action: RetentionAction },
  ): Promise<void>;
}

/**
 * The injectable clock the service reads to time the recovery window (Req 28.7).
 *
 * Injectable so unit and property tests can drive recovery deterministically
 * without real time: a hand-advanced clock fixes "now" and moves it across a
 * document's recovery deadline. Named {@link DocumentClock} (not `Clock`) so it
 * never collides with the Model_Router's or Scheduler's clocks in the shared
 * `@auxify/core` barrel.
 */
export interface DocumentClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link DocumentClock}, backed by the global `Date.now`. */
export const systemDocumentClock: DocumentClock = { now: () => Date.now() };

/** Fields the {@link DocumentStore} needs to create a document and its version-1 row. */
export interface CreateDocumentRow {
  /** The new document id. */
  id: string;
  /** The version-1 history row id. */
  versionId: string;
  /** The owning Project. */
  projectId: string;
  /** The optional containing folder. */
  folderId?: string;
  /** The document owner. */
  ownerId: string;
  /** The document name. */
  name: string;
  /** The MIME content type. */
  contentType: string;
  /** The head/version-1 size in bytes. */
  sizeBytes: number;
  /** The Object_Store key the version-1 bytes were persisted under. */
  objectKey: string;
  /** The initial permissions. */
  permissions: DocPermissions;
  /** The configured retention action. */
  retentionAction?: RetentionAction;
  /** The configured retention deadline. */
  retentionUntil?: string;
}

/** Fields the {@link DocumentStore} needs to append a document version and advance the head. */
export interface AddVersionRow {
  /** The next version-history row id. */
  versionId: string;
  /** The new version's content type. */
  contentType: string;
  /** The new version's size in bytes. */
  sizeBytes: number;
  /** The Object_Store key the new version's bytes were persisted under. */
  objectKey: string;
}

/** The result of a content write: the advanced document head and the appended version. */
export interface DocumentContentWrite {
  /** The document after its head version was advanced. */
  document: Document;
  /** The newly-appended retained version. */
  version: DocumentVersion;
}

/** Fields the {@link DocumentStore} needs to create a folder (Req 28.2). */
export interface CreateFolderRow {
  /** The new folder id. */
  id: string;
  /** The owning Project. */
  projectId: string;
  /** The optional parent folder. */
  parentId?: string;
  /** The folder name. */
  name: string;
  /** The optional initial permissions. */
  permissions?: DocPermissions;
}

/** Options narrowing a {@link DocumentStore} document listing. */
export interface ListDocumentsOptions {
  /** Include soft-deleted (trashed) documents in the result (default false). */
  includeDeleted?: boolean;
  /** Include archived documents in the result (default false). */
  includeArchived?: boolean;
}

/**
 * The tenant-scoped persistence port for documents, versions, and folders
 * (Req 28.1-28.7).
 *
 * Every method takes the caller's {@link TenantContext} so persistence is
 * automatically scoped to the Organization (Req 1.2, 1.4) — the service never
 * touches a backend directly. The concrete implementation is the tenant-scoped
 * repository; tests substitute the in-memory
 * {@link import('./fakes.js').InMemoryDocumentStore}.
 *
 * The store owns the *version-on-every-upload* invariant (Req 28.3):
 * {@link createDocument} persists the document head **and** its version-1 row,
 * and {@link addVersion} appends the next version row **and** advances the head —
 * so a caller can never write content without retaining a version.
 */
export interface DocumentStore {
  /** Create a document (head at version 1) and append its version-1 history row (Req 28.1, 28.3). */
  createDocument(ctx: TenantContext, input: CreateDocumentRow): Promise<Document>;
  /** Fetch a document by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<Document | null>;
  /**
   * List documents in a Project folder within the caller's Organization
   * (`folderId === null` lists the Project root). Excludes trashed/archived
   * documents unless {@link ListDocumentsOptions} opts them in (Req 28.2).
   */
  listByFolder(
    ctx: TenantContext,
    projectId: string,
    folderId: string | null,
    options?: ListDocumentsOptions,
  ): Promise<Document[]>;
  /**
   * Set (or clear, with `null`) a document's containing folder (Req 28.2).
   * Returns the updated document, or `null` if no document matched.
   */
  setFolder(ctx: TenantContext, id: string, folderId: string | null): Promise<Document | null>;
  /**
   * Append the next version-history row and advance the head version (Req 28.3).
   * Returns the {@link DocumentContentWrite}, or `null` if no document matched
   * within the caller's Organization.
   */
  addVersion(
    ctx: TenantContext,
    id: string,
    input: AddVersionRow,
  ): Promise<DocumentContentWrite | null>;
  /**
   * Replace a document's permissions (Req 28.4). Returns the updated document, or
   * `null` if no document matched.
   */
  updatePermissions(
    ctx: TenantContext,
    id: string,
    permissions: DocPermissions,
  ): Promise<Document | null>;
  /** List every retained version of a document, oldest first (Req 28.3). */
  listVersions(ctx: TenantContext, id: string): Promise<DocumentVersion[]>;
  /**
   * Mark a document soft-deleted (move to trash) at the given instant (Req 28.7).
   * Returns the trashed document, or `null` if no document matched.
   */
  markDeleted(ctx: TenantContext, id: string, deletedAt: string): Promise<Document | null>;
  /**
   * Clear a document's soft-delete (restore from trash) (Req 28.7). Returns the
   * restored document, or `null` if no document matched.
   */
  clearDeleted(ctx: TenantContext, id: string): Promise<Document | null>;
  /**
   * Mark a document archived at the given instant (a retention action, Req 28.6).
   * Returns the archived document, or `null` if no document matched.
   */
  markArchived(ctx: TenantContext, id: string, archivedAt: string): Promise<Document | null>;
  /**
   * Permanently remove a document and its version history (Req 28.7 purge).
   * Returns the removed document, or `null` if no document matched.
   */
  remove(ctx: TenantContext, id: string): Promise<Document | null>;
  /** List the caller's trashed (soft-deleted) documents, optionally within a Project (Req 28.7). */
  listDeleted(ctx: TenantContext, projectId?: string): Promise<Document[]>;
  /** List the active documents whose retention deadline has elapsed (Req 28.6). */
  listRetentionDue(ctx: TenantContext, nowIso: string, projectId?: string): Promise<Document[]>;
  /** Create a folder and return it (Req 28.2). */
  createFolder(ctx: TenantContext, input: CreateFolderRow): Promise<Folder>;
  /** Fetch a folder by id within the caller's Organization, or `null`. */
  findFolderById(ctx: TenantContext, id: string): Promise<Folder | null>;
  /** List a Project's folders within the caller's Organization (Req 28.2). */
  listFolders(ctx: TenantContext, projectId: string): Promise<Folder[]>;
  /**
   * Replace a folder's permissions (Req 28.4). Returns the updated folder, or
   * `null` if no folder matched.
   */
  updateFolderPermissions(
    ctx: TenantContext,
    id: string,
    permissions: DocPermissions,
  ): Promise<Folder | null>;
}
