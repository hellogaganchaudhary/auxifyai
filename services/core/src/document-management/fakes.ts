/**
 * Test fakes and builders for the Document_Management_Service.
 *
 * The service composes its ports — a {@link DocumentStore}, the shared
 * {@link ObjectStore}, an {@link AuditRecorder}, a {@link DocumentIngestionEmitter},
 * a {@link DocumentBackupStore}, a {@link DocumentComplianceManager}, a
 * {@link DocAuthorizer}, and a {@link DocumentClock}. These in-memory fakes let
 * unit and property tests drive the service deterministically and inspect what
 * was persisted, audited, emitted for ingestion, backed up, and applied for
 * retention — without a database, an object store, or a network:
 *
 *   - {@link InMemoryDocumentStore} models the tenant-scoped document repository's
 *     observable behaviour: Organization scoping, the version-on-every-upload
 *     invariant (Req 28.3), folder organization, soft-delete/restore/purge, and
 *     retention-due selection.
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert exactly which mutations and denials were audited (Req 28.8).
 *   - {@link CapturingDocumentIngestionEmitter} records every emitted
 *     {@link DocumentIngestionEvent} so a test can assert the ingestion-on-write
 *     hook fired (Req 28.5).
 *   - {@link InMemoryDocumentBackupStore} models the Backup_Service seam used by
 *     the recovery window (Req 28.7).
 *   - {@link RecordingComplianceManager} records every retention action applied
 *     (Req 28.6).
 *   - {@link AllowAllDocAuthorizer} / {@link DenyAllDocAuthorizer} exercise the
 *     permission/denial paths independently of the default
 *     {@link import('./doc-authorizer.js').PermissionsDocAuthorizer}.
 *   - {@link MutableDocumentClock} is a hand-advanceable clock so the recovery
 *     window is fully testable: fix "now", then advance it across a document's
 *     recovery deadline.
 *   - {@link makePrincipal} / {@link makeBytes} / {@link makePermissions} /
 *     {@link sequentialDocumentIdGenerator} are small builders with sensible
 *     defaults.
 *
 * These are imported directly from `./fakes.js` by the unit and property tests
 * (never from the package barrel), matching the established convention.
 */

import type { Principal, TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import { InMemoryObjectStore } from '../storage/index.js';
import type { DocumentIdGenerator } from './document-management-service.js';
import {
  DEFAULT_DOC_PERMISSIONS,
  type AddVersionRow,
  type CreateDocumentRow,
  type CreateFolderRow,
  type DocAuthorizer,
  type DocAuthzDecision,
  type DocPermissions,
  type Document,
  type DocumentBackup,
  type DocumentBackupStore,
  type DocumentClock,
  type DocumentComplianceManager,
  type DocumentContentWrite,
  type DocumentIngestionEmitter,
  type DocumentIngestionEvent,
  type DocumentStore,
  type DocumentVersion,
  type Folder,
  type ListDocumentsOptions,
  type RetentionAction,
} from './types.js';

/** Re-export the shared in-memory Object_Store as the test byte backend. */
export { InMemoryObjectStore };

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which mutations and denials were audited (Req 28.8).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({
      ctx: { ...ctx },
      event: { ...event, metadata: { ...(event.metadata ?? {}) } },
    });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `document.upload`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/** A captured ingestion emission as seen by the {@link DocumentIngestionEmitter} port. */
export interface CapturedIngestion {
  ctx: TenantContext;
  event: DocumentIngestionEvent;
}

/**
 * A capturing {@link DocumentIngestionEmitter} storing every emitted event so
 * tests can assert the ingestion-on-write hook fired (Req 28.5).
 */
export class CapturingDocumentIngestionEmitter implements DocumentIngestionEmitter {
  /** Every emitted ingestion event, in order. */
  readonly emitted: CapturedIngestion[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async emit(ctx: TenantContext, event: DocumentIngestionEvent): Promise<void> {
    this.emitted.push({
      ctx: { ...ctx },
      event: { ...event, attribution: { ...event.attribution } },
    });
  }

  /** The number of emissions so far. */
  get count(): number {
    return this.emitted.length;
  }

  /** Every emission for the given document id. */
  forDocument(documentId: string): CapturedIngestion[] {
    return this.emitted.filter((e) => e.event.documentId === documentId);
  }

  /** The single most recent emission, or `undefined`. */
  get last(): CapturedIngestion | undefined {
    return this.emitted[this.emitted.length - 1];
  }
}

/** A retention action applied through the {@link DocumentComplianceManager}. */
export interface AppliedRetention {
  ctx: TenantContext;
  documentId: string;
  action: RetentionAction;
}

/** A recording {@link DocumentComplianceManager} capturing every retention action (Req 28.6). */
export class RecordingComplianceManager implements DocumentComplianceManager {
  /** Every applied retention action, in order. */
  readonly applied: AppliedRetention[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async applyRetention(
    ctx: TenantContext,
    input: { document: Document; action: RetentionAction },
  ): Promise<void> {
    this.applied.push({ ctx: { ...ctx }, documentId: input.document.id, action: input.action });
  }

  /** The single most recent applied action, or `undefined`. */
  get last(): AppliedRetention | undefined {
    return this.applied[this.applied.length - 1];
  }
}

/** A {@link DocAuthorizer} that permits every action (for testing happy paths). */
export class AllowAllDocAuthorizer implements DocAuthorizer {
  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async authorize(): Promise<DocAuthzDecision> {
    return { allowed: true, reason: 'allow-all test authorizer' };
  }
}

/** A {@link DocAuthorizer} that denies every action (for testing denial paths). */
export class DenyAllDocAuthorizer implements DocAuthorizer {
  constructor(private readonly reason: string = 'deny-all test authorizer') {}

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async authorize(): Promise<DocAuthzDecision> {
    return { allowed: false, reason: this.reason };
  }
}

/**
 * A hand-advanceable {@link DocumentClock}, so the recovery window is fully
 * testable: fix "now" at construction, then {@link advance} it across a
 * document's recovery deadline (or {@link set} an absolute instant).
 */
export class MutableDocumentClock implements DocumentClock {
  private current: number;

  /** @param startMs The initial "now" in epoch milliseconds (default 2026-01-01T00:00:00Z). */
  constructor(startMs: number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.current = startMs;
  }

  /** The current time in milliseconds since the Unix epoch. */
  now(): number {
    return this.current;
  }

  /** Advance the clock by `deltaMs` milliseconds. */
  advance(deltaMs: number): void {
    this.current += deltaMs;
  }

  /** Set the clock to an absolute epoch-millisecond instant. */
  set(absoluteMs: number): void {
    this.current = absoluteMs;
  }
}

/** An in-memory captured backup as seen by the {@link DocumentBackupStore} port. */
export class InMemoryDocumentBackupStore implements DocumentBackupStore {
  private readonly backups = new Map<string, DocumentBackup>();

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async capture(ctx: TenantContext, backup: DocumentBackup): Promise<void> {
    this.backups.set(this.key(ctx, backup.document.id), cloneBackup(backup));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async fetch(ctx: TenantContext, documentId: string): Promise<DocumentBackup | null> {
    const found = this.backups.get(this.key(ctx, documentId));
    return found !== undefined ? cloneBackup(found) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async discard(ctx: TenantContext, documentId: string): Promise<void> {
    this.backups.delete(this.key(ctx, documentId));
  }

  /** Whether a backup currently exists for a document (test inspection). */
  has(ctx: TenantContext, documentId: string): boolean {
    return this.backups.has(this.key(ctx, documentId));
  }

  /** The number of captured backups (test inspection). */
  get count(): number {
    return this.backups.size;
  }

  private key(ctx: TenantContext, documentId: string): string {
    return `${ctx.organizationId}:${documentId}`;
  }
}

function clonePermissions(perms: DocPermissions): DocPermissions {
  return {
    projectViewers: perms.projectViewers,
    projectEditors: perms.projectEditors,
    viewerIds: [...perms.viewerIds],
    editorIds: [...perms.editorIds],
  };
}

function cloneDocument(document: Document): Document {
  const copy: Document = {
    id: document.id,
    organizationId: document.organizationId,
    projectId: document.projectId,
    ownerId: document.ownerId,
    name: document.name,
    contentType: document.contentType,
    sizeBytes: document.sizeBytes,
    version: document.version,
    objectKey: document.objectKey,
    permissions: clonePermissions(document.permissions),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
  if (document.folderId !== undefined) copy.folderId = document.folderId;
  if (document.retentionAction !== undefined) copy.retentionAction = document.retentionAction;
  if (document.retentionUntil !== undefined) copy.retentionUntil = document.retentionUntil;
  if (document.deletedAt !== undefined) copy.deletedAt = document.deletedAt;
  if (document.archivedAt !== undefined) copy.archivedAt = document.archivedAt;
  return copy;
}

function cloneVersion(version: DocumentVersion): DocumentVersion {
  return { ...version };
}

function cloneFolder(folder: Folder): Folder {
  const copy: Folder = {
    id: folder.id,
    organizationId: folder.organizationId,
    projectId: folder.projectId,
    name: folder.name,
  };
  if (folder.parentId !== undefined) copy.parentId = folder.parentId;
  if (folder.permissions !== undefined) copy.permissions = clonePermissions(folder.permissions);
  return copy;
}

function cloneBackup(backup: DocumentBackup): DocumentBackup {
  const bytesByObjectKey: Record<string, Uint8Array> = {};
  for (const [key, bytes] of Object.entries(backup.bytesByObjectKey)) {
    bytesByObjectKey[key] = Uint8Array.from(bytes);
  }
  return {
    document: cloneDocument(backup.document),
    versions: backup.versions.map(cloneVersion),
    bytesByObjectKey,
  };
}

/**
 * An in-memory {@link DocumentStore} modelling the tenant-scoped document
 * repository.
 *
 * Rows are confined to their Organization; {@link createDocument} seeds version 1
 * and {@link addVersion} appends the next version while advancing the head — so
 * the version-on-every-upload invariant (Req 28.3) holds exactly as the real
 * repository enforces it. Soft-delete/restore/purge and retention-due selection
 * back the recovery window (Req 28.7) and retention (Req 28.6). A monotonic
 * injected clock makes timestamps strictly increasing so version ordering is
 * observable.
 */
export class InMemoryDocumentStore implements DocumentStore {
  private readonly documents = new Map<string, Document>();
  private readonly versions = new Map<string, DocumentVersion[]>();
  private readonly folders = new Map<string, Folder>();
  private clock: () => Date;

  /** @param now Injected clock so timestamps are deterministic and strictly increasing. */
  constructor(now: () => Date = () => new Date()) {
    this.clock = now;
  }

  /** Override the clock. */
  setClock(now: () => Date): void {
    this.clock = now;
  }

  /** Seed a fully-formed document row (e.g. another tenant's data). */
  seedDocument(document: Document): void {
    this.documents.set(document.id, cloneDocument(document));
    if (!this.versions.has(document.id)) {
      this.versions.set(document.id, [
        {
          id: `${document.id}-v${document.version}`,
          documentId: document.id,
          version: document.version,
          objectKey: document.objectKey,
          contentType: document.contentType,
          sizeBytes: document.sizeBytes,
          createdAt: document.createdAt,
        },
      ]);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async createDocument(ctx: TenantContext, input: CreateDocumentRow): Promise<Document> {
    const ts = this.clock().toISOString();
    const document: Document = {
      id: input.id,
      organizationId: ctx.organizationId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      name: input.name,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      version: 1,
      objectKey: input.objectKey,
      permissions: clonePermissions(input.permissions),
      createdAt: ts,
      updatedAt: ts,
    };
    if (input.folderId !== undefined) document.folderId = input.folderId;
    if (input.retentionAction !== undefined) document.retentionAction = input.retentionAction;
    if (input.retentionUntil !== undefined) document.retentionUntil = input.retentionUntil;
    this.documents.set(document.id, document);
    // Seed version 1's history row (version-on-every-upload invariant, Req 28.3).
    this.versions.set(document.id, [
      {
        id: input.versionId,
        documentId: document.id,
        version: 1,
        objectKey: input.objectKey,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        createdAt: ts,
      },
    ]);
    return cloneDocument(document);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findById(ctx: TenantContext, id: string): Promise<Document | null> {
    const row = this.documents.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    return cloneDocument(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listByFolder(
    ctx: TenantContext,
    projectId: string,
    folderId: string | null,
    options?: ListDocumentsOptions,
  ): Promise<Document[]> {
    const includeDeleted = options?.includeDeleted ?? false;
    const includeArchived = options?.includeArchived ?? false;
    return [...this.documents.values()]
      .filter((d) => d.organizationId === ctx.organizationId && d.projectId === projectId)
      .filter((d) => (folderId === null ? d.folderId === undefined : d.folderId === folderId))
      .filter((d) => (includeDeleted ? true : d.deletedAt === undefined))
      .filter((d) => (includeArchived ? true : d.archivedAt === undefined))
      .map(cloneDocument);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async setFolder(
    ctx: TenantContext,
    id: string,
    folderId: string | null,
  ): Promise<Document | null> {
    const row = this.documents.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    if (folderId === null) {
      delete row.folderId;
    } else {
      row.folderId = folderId;
    }
    row.updatedAt = this.clock().toISOString();
    return cloneDocument(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async addVersion(
    ctx: TenantContext,
    id: string,
    input: AddVersionRow,
  ): Promise<DocumentContentWrite | null> {
    const row = this.documents.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    const ts = this.clock().toISOString();
    const nextVersion = row.version + 1;
    row.version = nextVersion;
    row.objectKey = input.objectKey;
    row.contentType = input.contentType;
    row.sizeBytes = input.sizeBytes;
    row.updatedAt = ts;
    const version: DocumentVersion = {
      id: input.versionId,
      documentId: id,
      version: nextVersion,
      objectKey: input.objectKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      createdAt: ts,
    };
    const history = this.versions.get(id) ?? [];
    history.push(version);
    this.versions.set(id, history);
    return { document: cloneDocument(row), version: cloneVersion(version) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async updatePermissions(
    ctx: TenantContext,
    id: string,
    permissions: DocPermissions,
  ): Promise<Document | null> {
    const row = this.documents.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    row.permissions = clonePermissions(permissions);
    row.updatedAt = this.clock().toISOString();
    return cloneDocument(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listVersions(ctx: TenantContext, id: string): Promise<DocumentVersion[]> {
    const row = this.documents.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return [];
    const history = this.versions.get(id) ?? [];
    return [...history].sort((a, b) => a.version - b.version).map(cloneVersion);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async markDeleted(ctx: TenantContext, id: string, deletedAt: string): Promise<Document | null> {
    const row = this.documents.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    row.deletedAt = deletedAt;
    row.updatedAt = this.clock().toISOString();
    return cloneDocument(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async clearDeleted(ctx: TenantContext, id: string): Promise<Document | null> {
    const row = this.documents.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    delete row.deletedAt;
    row.updatedAt = this.clock().toISOString();
    return cloneDocument(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async markArchived(
    ctx: TenantContext,
    id: string,
    archivedAt: string,
  ): Promise<Document | null> {
    const row = this.documents.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    row.archivedAt = archivedAt;
    row.updatedAt = this.clock().toISOString();
    return cloneDocument(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async remove(ctx: TenantContext, id: string): Promise<Document | null> {
    const row = this.documents.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    this.documents.delete(id);
    this.versions.delete(id);
    return cloneDocument(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listDeleted(ctx: TenantContext, projectId?: string): Promise<Document[]> {
    return [...this.documents.values()]
      .filter((d) => d.organizationId === ctx.organizationId && d.deletedAt !== undefined)
      .filter((d) => (projectId === undefined ? true : d.projectId === projectId))
      .map(cloneDocument);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listRetentionDue(
    ctx: TenantContext,
    nowIso: string,
    projectId?: string,
  ): Promise<Document[]> {
    return [...this.documents.values()]
      .filter((d) => d.organizationId === ctx.organizationId)
      .filter((d) => d.deletedAt === undefined && d.archivedAt === undefined)
      .filter((d) => d.retentionUntil !== undefined && d.retentionUntil <= nowIso)
      .filter((d) => (projectId === undefined ? true : d.projectId === projectId))
      .map(cloneDocument);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async createFolder(ctx: TenantContext, input: CreateFolderRow): Promise<Folder> {
    const folder: Folder = {
      id: input.id,
      organizationId: ctx.organizationId,
      projectId: input.projectId,
      name: input.name,
    };
    if (input.parentId !== undefined) folder.parentId = input.parentId;
    if (input.permissions !== undefined) folder.permissions = clonePermissions(input.permissions);
    this.folders.set(folder.id, folder);
    return cloneFolder(folder);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findFolderById(ctx: TenantContext, id: string): Promise<Folder | null> {
    const row = this.folders.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    return cloneFolder(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listFolders(ctx: TenantContext, projectId: string): Promise<Folder[]> {
    return [...this.folders.values()]
      .filter((f) => f.organizationId === ctx.organizationId && f.projectId === projectId)
      .map(cloneFolder);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async updateFolderPermissions(
    ctx: TenantContext,
    id: string,
    permissions: DocPermissions,
  ): Promise<Folder | null> {
    const row = this.folders.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    row.permissions = clonePermissions(permissions);
    return cloneFolder(row);
  }
}

/** Build a {@link Principal} with sensible defaults; override field-by-field. */
export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    roles: ['standard_user'],
    teamIds: [],
    projectIds: ['proj-1'],
    allowedModels: [],
    premiumAuthorized: false,
    ...overrides,
  };
}

/** Build a deterministic byte payload of `text` (UTF-8 encoded). */
export function makeBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Build {@link DocPermissions}, defaulting to {@link DEFAULT_DOC_PERMISSIONS}. */
export function makePermissions(overrides: Partial<DocPermissions> = {}): DocPermissions {
  return {
    projectViewers: overrides.projectViewers ?? DEFAULT_DOC_PERMISSIONS.projectViewers,
    projectEditors: overrides.projectEditors ?? DEFAULT_DOC_PERMISSIONS.projectEditors,
    viewerIds: overrides.viewerIds ?? [],
    editorIds: overrides.editorIds ?? [],
  };
}

/**
 * A deterministic {@link DocumentIdGenerator} handing out `doc-1`, `doc-2`, …
 * document ids, `ver-1`, `ver-2`, … version-row ids, and `fld-1`, `fld-2`, …
 * folder ids, for assertion-friendly tests.
 */
export function sequentialDocumentIdGenerator(): DocumentIdGenerator {
  let documentCounter = 0;
  let versionCounter = 0;
  let folderCounter = 0;
  return {
    documentId: () => `doc-${(documentCounter += 1)}`,
    versionId: () => `ver-${(versionCounter += 1)}`,
    folderId: () => `fld-${(folderCounter += 1)}`,
  };
}

/**
 * Build a monotonic clock whose every call returns a strictly-increasing
 * timestamp, so version timestamps are observable and ordered. Independent of
 * the {@link MutableDocumentClock} used to time the recovery window.
 */
export function monotonicClock(): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
  };
}
