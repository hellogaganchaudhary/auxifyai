/**
 * The Document_Management_Service (Req 28.1-28.8).
 *
 * The native enterprise document store: it stores a document's original bytes in
 * the Object_Store with its metadata (Req 28.1), organizes documents into a
 * folder hierarchy presented within their folders (Req 28.2), versions a
 * document on every new upload while retaining the full history (Req 28.3),
 * enforces the document's configured permissions through an Access_Control seam
 * on every operation and records every denied access in the Audit_Service
 * (Req 28.4, 28.8), emits the document content for ingestion on every write so it
 * is retrievable through RAG and Unified Search (Req 28.5), applies a configured
 * retention action through a Compliance_Manager seam when retention elapses
 * (Req 28.6), and protects deletions with a recovery window — soft-deleting a
 * document into "trash" from which it can be restored through a Backup_Service
 * seam while the window is open, and permanently purging it once the window has
 * elapsed (Req 28.7).
 *
 * It composes only narrow injected ports so it is pure orchestration and fully
 * unit-testable without a database, an object store, a model, or a network:
 *
 *   - a tenant-scoped {@link DocumentStore} (satisfied by the document
 *     repository) — every operation is automatically confined to the caller's
 *     Organization (Req 1.2, 1.4) and the store owns the version-on-every-upload
 *     invariant (Req 28.3);
 *   - the shared {@link ObjectStore} — the durable home of the original bytes
 *     (Req 28.1, 44.5);
 *   - the shared {@link AuditRecorder} — every mutation, and every *denied*
 *     access (Req 28.8), is recorded in the immutable audit trail;
 *   - an injectable {@link DocumentIngestionEmitter} — every upload/version emits
 *     the document's content for ingestion (Req 28.5) **without** a hard
 *     dependency on the Knowledge_Ingestion_Service;
 *   - a {@link DocAuthorizer} (the Access_Control seam) — enforces the document's
 *     configured permissions on every operation (Req 28.4);
 *   - a {@link DocumentBackupStore} (the Backup_Service seam) — captures and
 *     restores a soft-deleted document within the recovery window (Req 28.7);
 *   - a {@link DocumentComplianceManager} (the Compliance_Manager seam) — applies
 *     the configured retention action (Req 28.6); and
 *   - a {@link DocumentClock} — times the recovery window deterministically
 *     (Req 28.7).
 *
 * Responsibilities mapped to acceptance criteria:
 *   - {@link upload} — stores bytes + metadata at version 1, audited, emitted for
 *     ingestion (Req 28.1, 28.5);
 *   - {@link createFolder} / {@link organize} — maintains the folder hierarchy and
 *     presents documents within folders ({@link listFolder}) (Req 28.2);
 *   - {@link addVersion} — stores a new version's bytes and retains all prior
 *     versions, audited, emitted for ingestion (Req 28.3, 28.5);
 *   - {@link setPermissions} — sets a document's or folder's permissions,
 *     enforced on every operation (Req 28.4);
 *   - {@link softDelete} / {@link recover} / {@link purgeExpired} — the recovery
 *     window: soft-delete to trash, restore within the window, permanent purge
 *     after (Req 28.7);
 *   - {@link applyDueRetention} — applies the configured retention action via the
 *     Compliance_Manager when retention elapses (Req 28.6);
 *   - permissions are enforced on *every* operation through the authorizer, and a
 *     denied access is recorded in the Audit_Service before failing (Req 28.4,
 *     28.8).
 */

import { randomUUID } from 'node:crypto';

import {
  tenantContextFromPrincipal,
  type Principal,
  type SourceAttribution,
  type TenantContext,
} from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import type { ObjectStore } from '../storage/index.js';
import { PermissionsDocAuthorizer } from './doc-authorizer.js';
import {
  DocumentAccessDeniedError,
  DocumentNotFoundError,
  FolderNotFoundError,
  InvalidFolderHierarchyError,
  RecoveryWindowExpiredError,
} from './errors.js';
import {
  DEFAULT_RECOVERY_WINDOW_MS,
  isWithinRecoveryWindow,
} from './recovery.js';
import {
  DEFAULT_DOC_PERMISSIONS,
  type DocAction,
  type DocAuthorizer,
  type DocPermissions,
  type DocTarget,
  type Document,
  type DocumentBackup,
  type DocumentBackupStore,
  type DocumentClock,
  type DocumentComplianceManager,
  type DocumentIngestionEmitter,
  type DocumentIngestionEvent,
  type DocumentInput,
  type DocumentStore,
  type DocumentUpload,
  type DocumentVersion,
  type Folder,
  type FolderInput,
  type ListDocumentsOptions,
  type RetentionAction,
} from './types.js';

/** Generates unique ids for documents, version rows, and folders (injectable for tests). */
export interface DocumentIdGenerator {
  /** A unique document id. */
  documentId(): string;
  /** A unique document-version row id. */
  versionId(): string;
  /** A unique folder id. */
  folderId(): string;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: DocumentIdGenerator = {
  documentId: () => randomUUID(),
  versionId: () => randomUUID(),
  folderId: () => randomUUID(),
};

/** Construction dependencies for the {@link DocumentManagementService}. */
export interface DocumentManagementServiceOptions {
  /** The documents store (tenant-scoped document/folder repository). */
  documents: DocumentStore;
  /** The Object_Store holding original document bytes (Req 28.1, 44.5). */
  objectStore: ObjectStore;
  /** The append-only audit sink; every mutation and denial is recorded (Req 28.8, 37.1). */
  audit: AuditRecorder;
  /** The ingestion-on-write emitter (Req 28.5); a narrow seam, not the concrete pipeline. */
  ingestion: DocumentIngestionEmitter;
  /** The Backup_Service seam backing the recovery window (Req 28.7). */
  backup: DocumentBackupStore;
  /** The Compliance_Manager seam applying retention actions (Req 28.6). */
  compliance: DocumentComplianceManager;
  /**
   * The Access_Control seam enforcing document permissions (Req 28.4). Defaults
   * to the permissions-based {@link PermissionsDocAuthorizer}.
   */
  authorizer?: DocAuthorizer;
  /** The clock used to time the recovery window (Req 28.7). Defaults to the system clock. */
  clock?: DocumentClock;
  /**
   * The recovery window duration in milliseconds (Req 28.7). Defaults to
   * {@link DEFAULT_RECOVERY_WINDOW_MS} (30 days).
   */
  recoveryWindowMs?: number;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: DocumentIdGenerator;
}

/**
 * The Document_Management_Service. Construct once with its ports, then call its
 * methods with the acting {@link Principal} (which carries the Organization
 * scope, the Project memberships permission checks use, and the default actor).
 */
export class DocumentManagementService {
  private readonly documents: DocumentStore;
  private readonly objects: ObjectStore;
  private readonly audit: AuditRecorder;
  private readonly ingestion: DocumentIngestionEmitter;
  private readonly backup: DocumentBackupStore;
  private readonly compliance: DocumentComplianceManager;
  private readonly authorizer: DocAuthorizer;
  private readonly clock: DocumentClock;
  private readonly recoveryWindowMs: number;
  private readonly ids: DocumentIdGenerator;

  constructor(options: DocumentManagementServiceOptions) {
    this.documents = options.documents;
    this.objects = options.objectStore;
    this.audit = options.audit;
    this.ingestion = options.ingestion;
    this.backup = options.backup;
    this.compliance = options.compliance;
    this.authorizer = options.authorizer ?? new PermissionsDocAuthorizer();
    this.clock = options.clock ?? { now: () => Date.now() };
    this.recoveryWindowMs = options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS;
    this.ids = options.idGenerator ?? defaultIdGenerator;
  }

  /** The configured recovery window duration in milliseconds (Req 28.7). */
  get recoveryWindowDurationMs(): number {
    return this.recoveryWindowMs;
  }

  /**
   * Upload a document: store its original bytes in the Object_Store and persist
   * its metadata — name, owning Project, owner, size, content type, version
   * (Req 28.1) — seeding its version-1 history row (Req 28.3). When a `folderId`
   * is supplied it must be a folder in the same Project, placing the document in
   * the hierarchy (Req 28.2). The upload is recorded in the Audit_Service and the
   * content is emitted for ingestion so it is retrievable through RAG and Unified
   * Search (Req 28.5).
   */
  async upload(principal: Principal, input: DocumentInput): Promise<Document> {
    const ctx = this.contextFor(principal, input.projectId);
    if (input.folderId !== undefined) {
      await this.requireFolderInProject(ctx, input.folderId, input.projectId, input.id ?? '(new)');
    }

    const id = input.id ?? this.ids.documentId();
    const objectKey = this.objectKeyFor(ctx.organizationId, id, 1);
    await this.objects.put(objectKey, input.bytes, { contentType: input.contentType });

    const createRow = {
      id,
      versionId: this.ids.versionId(),
      projectId: input.projectId,
      ownerId: input.ownerId ?? principal.userId,
      name: input.name,
      contentType: input.contentType,
      sizeBytes: input.bytes.length,
      objectKey,
      permissions: input.permissions ?? cloneDefaultPermissions(),
      ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
      ...(input.retentionAction !== undefined ? { retentionAction: input.retentionAction } : {}),
      ...(input.retentionUntil !== undefined ? { retentionUntil: input.retentionUntil } : {}),
    };
    const document = await this.documents.createDocument(ctx, createRow);

    await this.audit.record(ctx, {
      action: 'document.upload',
      resourceType: 'document',
      resourceId: document.id,
      metadata: {
        projectId: document.projectId,
        ownerId: document.ownerId,
        version: document.version,
        sizeBytes: document.sizeBytes,
      },
    });
    await this.emitIngestion(ctx, document);
    return document;
  }

  /** Fetch a document by id within the caller's Organization, or `null`. */
  async getDocument(principal: Principal, id: string): Promise<Document | null> {
    const ctx = this.contextFor(principal);
    return this.documents.findById(ctx, id);
  }

  /**
   * Retrieve the current head bytes of a document (Req 28.1).
   *
   * Requires view permission (Req 28.4); a denial is audited and rejected
   * (Req 28.8).
   */
  async getBytes(principal: Principal, id: string): Promise<Uint8Array> {
    const ctx = this.contextFor(principal);
    const document = await this.requireDocument(ctx, id);
    await this.requireAccess(ctx, principal, document, 'view');
    return this.objects.get(document.objectKey);
  }

  /**
   * Create a folder in a Project, maintaining the folder hierarchy (Req 28.2).
   *
   * When a `parentId` is supplied it must be a folder in the same Project. The
   * creation is audited.
   */
  async createFolder(principal: Principal, input: FolderInput): Promise<Folder> {
    const ctx = this.contextFor(principal, input.projectId);
    if (input.parentId !== undefined) {
      const parent = await this.documents.findFolderById(ctx, input.parentId);
      if (parent === null) {
        throw new InvalidFolderHierarchyError(
          input.id ?? '(new)',
          input.parentId,
          'parent folder not found in the current organization',
        );
      }
      if (parent.projectId !== input.projectId) {
        throw new InvalidFolderHierarchyError(
          input.id ?? '(new)',
          input.parentId,
          'parent folder belongs to a different Project',
        );
      }
    }

    const id = input.id ?? this.ids.folderId();
    const folder = await this.documents.createFolder(ctx, {
      id,
      projectId: input.projectId,
      name: input.name,
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    });
    await this.audit.record(ctx, {
      action: 'document_folder.create',
      resourceType: 'document',
      resourceId: folder.id,
      metadata: { projectId: folder.projectId, parentId: folder.parentId ?? null },
    });
    return folder;
  }

  /**
   * Organize a document into a folder (or detach it to the Project root, with
   * `folderId === null`), maintaining the folder hierarchy (Req 28.2). Requires
   * edit permission on the document (Req 28.4); a denial is audited and rejected
   * (Req 28.8). The target folder must belong to the document's Project. Audited.
   */
  async organize(principal: Principal, docId: string, folderId: string | null): Promise<void> {
    const ctx = this.contextFor(principal);
    const document = await this.requireDocument(ctx, docId);
    await this.requireAccess(ctx, principal, document, 'edit');

    if (folderId !== null) {
      const folder = await this.documents.findFolderById(ctx, folderId);
      if (folder === null) {
        throw new InvalidFolderHierarchyError(docId, folderId, 'folder not found');
      }
      if (folder.projectId !== document.projectId) {
        throw new InvalidFolderHierarchyError(
          docId,
          folderId,
          'folder belongs to a different Project',
        );
      }
    }

    const updated = await this.documents.setFolder(ctx, docId, folderId);
    if (updated === null) {
      throw new DocumentNotFoundError(docId);
    }
    await this.audit.record(ctx, {
      action: 'document.organize',
      resourceType: 'document',
      resourceId: docId,
      metadata: { folderId },
    });
  }

  /**
   * List the documents within a Project folder, presenting them within their
   * folder (Req 28.2). `folderId === null` lists the Project root. Trashed and
   * archived documents are excluded by default (a trashed document lives in the
   * recovery window's "trash", listed separately by {@link listTrash}).
   */
  async listFolder(
    principal: Principal,
    projectId: string,
    folderId: string | null,
    options?: ListDocumentsOptions,
  ): Promise<Document[]> {
    const ctx = this.contextFor(principal, projectId);
    return this.documents.listByFolder(ctx, projectId, folderId, options);
  }

  /** List a Project's folders within the caller's Organization (Req 28.2). */
  async listFolders(principal: Principal, projectId: string): Promise<Folder[]> {
    const ctx = this.contextFor(principal, projectId);
    return this.documents.listFolders(ctx, projectId);
  }

  /**
   * Upload a new version of an existing document: store the new bytes in the
   * Object_Store, create a new version, and retain all prior versions in the
   * version history (Req 28.3). Requires edit permission (Req 28.4); a denied
   * attempt is recorded in the Audit_Service and rejected (Req 28.8). The new
   * version is audited and the content is emitted for re-indexing (Req 28.5).
   */
  async addVersion(
    principal: Principal,
    docId: string,
    upload: DocumentUpload,
  ): Promise<DocumentVersion> {
    const ctx = this.contextFor(principal);
    const document = await this.requireDocument(ctx, docId);
    await this.requireAccess(ctx, principal, document, 'edit');

    const nextVersion = document.version + 1;
    const contentType = upload.contentType ?? document.contentType;
    const sizeBytes = upload.sizeBytes ?? upload.bytes.length;
    const objectKey = this.objectKeyFor(ctx.organizationId, docId, nextVersion);
    await this.objects.put(objectKey, upload.bytes, { contentType });

    const write = await this.documents.addVersion(ctx, docId, {
      versionId: this.ids.versionId(),
      contentType,
      sizeBytes,
      objectKey,
    });
    if (write === null) {
      // Existed a moment ago; a null here means it left the tenant scope. Fail closed.
      throw new DocumentNotFoundError(docId);
    }
    await this.audit.record(ctx, {
      action: 'document.add_version',
      resourceType: 'document',
      resourceId: docId,
      metadata: { version: write.version.version, sizeBytes },
    });
    await this.emitIngestion(ctx, write.document);
    return write.version;
  }

  /** List every retained version of a document, oldest first (Req 28.3). */
  async listVersions(principal: Principal, docId: string): Promise<DocumentVersion[]> {
    const ctx = this.contextFor(principal);
    await this.requireDocument(ctx, docId);
    return this.documents.listVersions(ctx, docId);
  }

  /**
   * Set the view/edit permissions of a document or folder (Req 28.4).
   *
   * For a document target, requires `manage` permission on it (Req 28.4); a
   * denial is audited and rejected (Req 28.8). Setting permissions is
   * configuration, not content, so it does not re-emit the document for
   * ingestion. The change is audited.
   */
  async setPermissions(
    principal: Principal,
    target: DocTarget,
    permissions: DocPermissions,
  ): Promise<void> {
    const ctx = this.contextFor(principal);
    if (target.kind === 'document') {
      const document = await this.requireDocument(ctx, target.id);
      await this.requireAccess(ctx, principal, document, 'manage');
      const updated = await this.documents.updatePermissions(ctx, target.id, permissions);
      if (updated === null) {
        throw new DocumentNotFoundError(target.id);
      }
    } else {
      const folder = await this.documents.findFolderById(ctx, target.id);
      if (folder === null) {
        throw new FolderNotFoundError(target.id);
      }
      const updated = await this.documents.updateFolderPermissions(ctx, target.id, permissions);
      if (updated === null) {
        throw new FolderNotFoundError(target.id);
      }
    }
    await this.audit.record(ctx, {
      action: 'document.set_permissions',
      resourceType: 'document',
      resourceId: target.id,
      metadata: {
        targetKind: target.kind,
        projectViewers: permissions.projectViewers,
        projectEditors: permissions.projectEditors,
        viewerCount: permissions.viewerIds.length,
        editorCount: permissions.editorIds.length,
      },
    });
  }

  /**
   * Soft-delete a document, opening its recovery window (Req 28.7).
   *
   * Requires delete permission (Req 28.4); a denial is audited and rejected
   * (Req 28.8). The document is captured to the Backup_Service, marked deleted at
   * "now" (so the recovery window is timed from this instant), and moved to
   * trash — it no longer appears in {@link listFolder} but is restorable through
   * {@link recover} while the window is open. The deletion is audited.
   */
  async softDelete(principal: Principal, docId: string): Promise<Document> {
    const ctx = this.contextFor(principal);
    const document = await this.requireDocument(ctx, docId);
    await this.requireAccess(ctx, principal, document, 'delete');

    await this.captureBackup(ctx, document);
    const deletedAt = this.nowIso();
    const trashed = await this.documents.markDeleted(ctx, docId, deletedAt);
    if (trashed === null) {
      throw new DocumentNotFoundError(docId);
    }
    await this.audit.record(ctx, {
      action: 'document.soft_delete',
      resourceType: 'document',
      resourceId: docId,
      metadata: { deletedAt, recoveryWindowMs: this.recoveryWindowMs },
    });
    return trashed;
  }

  /**
   * Recover a soft-deleted document from the Backup_Service, but only within the
   * recovery window (Req 28.7, Property 60).
   *
   * If the request arrives within the window
   * (`deletedAt <= now <= deletedAt + recoveryWindowMs`), the document is restored
   * from the captured backup (its bytes re-materialized in the Object_Store and
   * its metadata/versions reinstated) and removed from trash; the restore is
   * audited and the content re-emitted for ingestion (Req 28.5). If the window has
   * elapsed the document is permanently purged and a
   * {@link RecoveryWindowExpiredError} is thrown — recovery succeeds *exactly*
   * within the window.
   */
  async recover(principal: Principal, docId: string): Promise<Document> {
    const ctx = this.contextFor(principal);
    const document = await this.requireDeletedDocument(ctx, docId);
    await this.requireAccess(ctx, principal, document, 'delete');

    const deletedAtMs = Date.parse(document.deletedAt ?? '');
    const nowMs = this.clock.now();
    if (!isWithinRecoveryWindow(deletedAtMs, nowMs, this.recoveryWindowMs)) {
      // Past the window: purge permanently and fail closed (Req 28.7).
      const recoverableUntil = new Date(deletedAtMs + this.recoveryWindowMs).toISOString();
      await this.purgeDocument(ctx, document, 'recovery_window_expired');
      throw new RecoveryWindowExpiredError(docId, recoverableUntil);
    }

    const restored = await this.restoreFromBackup(ctx, document);
    await this.audit.record(ctx, {
      action: 'document.recover',
      resourceType: 'document',
      resourceId: docId,
      metadata: { deletedAt: document.deletedAt ?? null, version: restored.version },
    });
    await this.emitIngestion(ctx, restored);
    return restored;
  }

  /** List the caller's trashed (soft-deleted, still recoverable) documents (Req 28.7). */
  async listTrash(principal: Principal, projectId?: string): Promise<Document[]> {
    const ctx = this.contextFor(principal, projectId);
    return this.documents.listDeleted(ctx, projectId);
  }

  /**
   * Permanently purge every trashed document whose recovery window has elapsed
   * (Req 28.7).
   *
   * Intended to be driven periodically (e.g. by the Scheduler). For each
   * soft-deleted document past `deletedAt + recoveryWindowMs`, the bytes, the
   * version history, and the backup are removed and the purge is audited. Returns
   * the ids purged.
   */
  async purgeExpired(principal: Principal, projectId?: string): Promise<string[]> {
    const ctx = this.contextFor(principal, projectId);
    const trashed = await this.documents.listDeleted(ctx, projectId);
    const nowMs = this.clock.now();
    const purged: string[] = [];
    for (const document of trashed) {
      const deletedAtMs = Date.parse(document.deletedAt ?? '');
      if (!isWithinRecoveryWindow(deletedAtMs, nowMs, this.recoveryWindowMs)) {
        await this.purgeDocument(ctx, document, 'recovery_window_expired');
        purged.push(document.id);
      }
    }
    return purged;
  }

  /**
   * Apply the configured retention action to every document whose retention
   * period has elapsed (Req 28.6).
   *
   * Intended to be driven periodically. For each active document past its
   * `retentionUntil`, the configured action is delegated to the
   * Compliance_Manager (which records the action in the Audit_Service, Req 28.6):
   * `archive` marks the document archived; `delete` soft-deletes it into the
   * recovery window (so a retention deletion remains recoverable, Req 28.7).
   * Returns the ids acted upon.
   */
  async applyDueRetention(principal: Principal, projectId?: string): Promise<string[]> {
    const ctx = this.contextFor(principal, projectId);
    const due = await this.documents.listRetentionDue(ctx, this.nowIso(), projectId);
    const acted: string[] = [];
    for (const document of due) {
      const action: RetentionAction = document.retentionAction ?? 'delete';
      await this.compliance.applyRetention(ctx, { document, action });
      if (action === 'archive') {
        await this.documents.markArchived(ctx, document.id, this.nowIso());
      } else {
        await this.captureBackup(ctx, document);
        await this.documents.markDeleted(ctx, document.id, this.nowIso());
      }
      await this.audit.record(ctx, {
        action: 'document.retention_applied',
        resourceType: 'document',
        resourceId: document.id,
        metadata: { retentionAction: action, retentionUntil: document.retentionUntil ?? null },
      });
      acted.push(document.id);
    }
    return acted;
  }

  // --- internals ---------------------------------------------------------

  /** Build the tenant context for the principal, optionally narrowed to a Project. */
  private contextFor(principal: Principal, projectId?: string): TenantContext {
    return projectId !== undefined
      ? tenantContextFromPrincipal(principal, { projectId })
      : tenantContextFromPrincipal(principal);
  }

  /** Fetch an active document or fail closed with {@link DocumentNotFoundError}. */
  private async requireDocument(ctx: TenantContext, docId: string): Promise<Document> {
    const document = await this.documents.findById(ctx, docId);
    if (document === null || document.deletedAt !== undefined) {
      throw new DocumentNotFoundError(docId);
    }
    return document;
  }

  /** Fetch a soft-deleted (trashed) document or fail closed with {@link DocumentNotFoundError}. */
  private async requireDeletedDocument(ctx: TenantContext, docId: string): Promise<Document> {
    const document = await this.documents.findById(ctx, docId);
    if (document === null || document.deletedAt === undefined) {
      throw new DocumentNotFoundError(docId);
    }
    return document;
  }

  /** Require a folder exists in the same Project, else fail closed (Req 28.2). */
  private async requireFolderInProject(
    ctx: TenantContext,
    folderId: string,
    projectId: string,
    resourceId: string,
  ): Promise<void> {
    const folder = await this.documents.findFolderById(ctx, folderId);
    if (folder === null) {
      throw new InvalidFolderHierarchyError(
        resourceId,
        folderId,
        'folder not found in the current organization',
      );
    }
    if (folder.projectId !== projectId) {
      throw new InvalidFolderHierarchyError(
        resourceId,
        folderId,
        'folder belongs to a different Project',
      );
    }
  }

  /**
   * Enforce the document's configured permissions for an action; on denial record
   * an audited `access_denied` event and throw {@link DocumentAccessDeniedError}
   * (Req 28.4, 28.8).
   */
  private async requireAccess(
    ctx: TenantContext,
    principal: Principal,
    document: Document,
    action: DocAction,
  ): Promise<void> {
    const decision = await this.authorizer.authorize(principal, document, action);
    if (!decision.allowed) {
      await this.audit.record(ctx, {
        action: 'document.access_denied',
        resourceType: 'document',
        resourceId: document.id,
        actorId: principal.userId,
        metadata: { attemptedAction: action, reason: decision.reason },
      });
      throw new DocumentAccessDeniedError(document.id, action, decision.reason);
    }
  }

  /** Capture a complete backup (metadata + versions + bytes) for the recovery window (Req 28.7). */
  private async captureBackup(ctx: TenantContext, document: Document): Promise<void> {
    const versions = await this.documents.listVersions(ctx, document.id);
    const bytesByObjectKey: Record<string, Uint8Array> = {};
    for (const key of uniqueObjectKeys(document, versions)) {
      bytesByObjectKey[key] = await this.objects.get(key);
    }
    const backup: DocumentBackup = { document, versions, bytesByObjectKey };
    await this.backup.capture(ctx, backup);
  }

  /** Restore a soft-deleted document from its captured backup (Req 28.7). */
  private async restoreFromBackup(ctx: TenantContext, document: Document): Promise<Document> {
    const snapshot = await this.backup.fetch(ctx, document.id);
    if (snapshot !== null) {
      // Re-materialize any bytes that were purged from the Object_Store.
      for (const [key, bytes] of Object.entries(snapshot.bytesByObjectKey)) {
        if (!(await this.objects.exists(key))) {
          await this.objects.put(key, bytes, { contentType: snapshot.document.contentType });
        }
      }
    }
    const restored = await this.documents.clearDeleted(ctx, document.id);
    if (restored === null) {
      throw new DocumentNotFoundError(document.id);
    }
    await this.backup.discard(ctx, document.id);
    return restored;
  }

  /** Permanently remove a document, its bytes, version history, and backup (Req 28.7 purge). */
  private async purgeDocument(
    ctx: TenantContext,
    document: Document,
    reason: string,
  ): Promise<void> {
    const versions = await this.documents.listVersions(ctx, document.id);
    for (const key of uniqueObjectKeys(document, versions)) {
      await this.objects.delete(key);
    }
    await this.documents.remove(ctx, document.id);
    await this.backup.discard(ctx, document.id);
    await this.audit.record(ctx, {
      action: 'document.purge',
      resourceType: 'document',
      resourceId: document.id,
      metadata: { reason },
    });
  }

  /** Emit a document's content for ingestion after a write (Req 28.5). */
  private async emitIngestion(ctx: TenantContext, document: Document): Promise<void> {
    const event: DocumentIngestionEvent = {
      documentId: document.id,
      projectId: document.projectId,
      name: document.name,
      contentType: document.contentType,
      objectKey: document.objectKey,
      version: document.version,
      attribution: documentAttribution(document),
    };
    await this.ingestion.emit(ctx, event);
  }

  /** The Object_Store key for a document version's bytes (tenant-scoped). */
  private objectKeyFor(organizationId: string, documentId: string, version: number): string {
    return `documents/${organizationId}/${documentId}/v${version}`;
  }

  /** "Now" as an ISO-8601 string, read from the injectable clock. */
  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

/** The distinct Object_Store keys backing a document head and all its versions. */
function uniqueObjectKeys(document: Document, versions: DocumentVersion[]): string[] {
  const keys = new Set<string>([document.objectKey]);
  for (const version of versions) {
    keys.add(version.objectKey);
  }
  return [...keys];
}

/** A fresh copy of the default permissions so callers never share the constant. */
function cloneDefaultPermissions(): DocPermissions {
  return {
    projectViewers: DEFAULT_DOC_PERMISSIONS.projectViewers,
    projectEditors: DEFAULT_DOC_PERMISSIONS.projectEditors,
    viewerIds: [...DEFAULT_DOC_PERMISSIONS.viewerIds],
    editorIds: [...DEFAULT_DOC_PERMISSIONS.editorIds],
  };
}

/** Build a complete {@link SourceAttribution} for a document (Req 24.4, 28.5). */
function documentAttribution(document: Document): SourceAttribution {
  return {
    sourceId: document.id,
    sourceTitle: document.name,
    location: `project:${document.projectId}`,
    link: `document-management://documents/${document.id}`,
  };
}
