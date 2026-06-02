/**
 * Unit tests for the Document_Management_Service (Req 28.1-28.8).
 *
 * These exercise the service against in-memory fakes for its ports (document
 * store, object store, audit recorder, ingestion emitter, backup store,
 * compliance manager, authorizer, recovery clock), covering every acceptance
 * criterion with concrete examples and edge cases:
 *   - upload() stores bytes + metadata at version 1, audits, and emits for
 *     ingestion (Req 28.1, 28.5);
 *   - createFolder()/organize()/listFolder() maintain the folder hierarchy and
 *     present documents within their folders (Req 28.2);
 *   - addVersion() creates a new version and retains all prior versions, audits,
 *     and re-emits for ingestion (Req 28.3, 28.5);
 *   - setPermissions() persists permissions, enforced via the authorizer on every
 *     operation, with a denial recorded in the Audit_Service (Req 28.4, 28.8);
 *   - softDelete()/recover()/purgeExpired() implement the recovery window:
 *     soft-delete to trash, restore within the window, permanent purge after
 *     (Req 28.7);
 *   - applyDueRetention() applies the configured retention action via the
 *     Compliance_Manager when retention elapses (Req 28.6);
 *   - tenant isolation: a document in another Organization is invisible (Req 1.4).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryObjectStore } from '../storage/index.js';
import { DocumentManagementService } from './document-management-service.js';
import {
  DocumentAccessDeniedError,
  DocumentNotFoundError,
  InvalidFolderHierarchyError,
  RecoveryWindowExpiredError,
} from './errors.js';
import {
  AllowAllDocAuthorizer,
  CapturingAuditRecorder,
  CapturingDocumentIngestionEmitter,
  DenyAllDocAuthorizer,
  InMemoryDocumentBackupStore,
  InMemoryDocumentStore,
  MutableDocumentClock,
  RecordingComplianceManager,
  makeBytes,
  makePermissions,
  makePrincipal,
  monotonicClock,
  sequentialDocumentIdGenerator,
} from './fakes.js';
import { DEFAULT_RECOVERY_WINDOW_MS } from './recovery.js';
import type { DocAuthorizer } from './types.js';

const PROJECT = 'proj-1';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Harness {
  service: DocumentManagementService;
  store: InMemoryDocumentStore;
  objects: InMemoryObjectStore;
  audit: CapturingAuditRecorder;
  ingestion: CapturingDocumentIngestionEmitter;
  backup: InMemoryDocumentBackupStore;
  compliance: RecordingComplianceManager;
  clock: MutableDocumentClock;
}

function makeHarness(authorizer: DocAuthorizer = new AllowAllDocAuthorizer()): Harness {
  const store = new InMemoryDocumentStore(monotonicClock());
  const objects = new InMemoryObjectStore();
  const audit = new CapturingAuditRecorder();
  const ingestion = new CapturingDocumentIngestionEmitter();
  const backup = new InMemoryDocumentBackupStore();
  const compliance = new RecordingComplianceManager();
  const clock = new MutableDocumentClock();
  const service = new DocumentManagementService({
    documents: store,
    objectStore: objects,
    audit,
    ingestion,
    backup,
    compliance,
    authorizer,
    clock,
    idGenerator: sequentialDocumentIdGenerator(),
  });
  return { service, store, objects, audit, ingestion, backup, compliance, clock };
}

const principal = makePrincipal({ userId: 'user-1', organizationId: 'org-1', projectIds: [PROJECT] });

describe('DocumentManagementService.upload (Req 28.1, 28.5)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('stores bytes in the Object_Store and persists metadata at version 1', async () => {
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'spec.pdf',
      contentType: 'application/pdf',
      bytes: makeBytes('the document body'),
    });
    expect(doc.id).toBe('doc-1');
    expect(doc.name).toBe('spec.pdf');
    expect(doc.contentType).toBe('application/pdf');
    expect(doc.ownerId).toBe('user-1');
    expect(doc.projectId).toBe(PROJECT);
    expect(doc.organizationId).toBe('org-1');
    expect(doc.version).toBe(1);
    expect(doc.sizeBytes).toBe(makeBytes('the document body').length);

    // The original bytes live in the Object_Store under the document's key.
    const stored = await h.objects.get(doc.objectKey);
    expect(stored).toEqual(makeBytes('the document body'));
  });

  it('records the upload in the Audit_Service', async () => {
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'a.txt',
      contentType: 'text/plain',
      bytes: makeBytes('x'),
    });
    const events = h.audit.withAction('document.upload');
    expect(events).toHaveLength(1);
    expect(events[0]!.event.resourceId).toBe(doc.id);
    expect(events[0]!.event.resourceType).toBe('document');
  });

  it('emits the document content for ingestion on upload (Req 28.5)', async () => {
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'spec.pdf',
      contentType: 'application/pdf',
      bytes: makeBytes('body'),
    });
    expect(h.ingestion.count).toBe(1);
    const emitted = h.ingestion.last!.event;
    expect(emitted.documentId).toBe(doc.id);
    expect(emitted.name).toBe('spec.pdf');
    expect(emitted.objectKey).toBe(doc.objectKey);
    expect(emitted.attribution.sourceId).toBe(doc.id);
    expect(emitted.attribution.sourceTitle).toBe('spec.pdf');
    expect(emitted.attribution.location).toBeTruthy();
    expect(emitted.attribution.link).toBeTruthy();
  });

  it('rejects an upload into a folder of a different Project', async () => {
    const otherFolder = await h.service.createFolder(
      makePrincipal({ projectIds: ['proj-2'] }),
      { projectId: 'proj-2', name: 'Other' },
    );
    await expect(
      h.service.upload(principal, {
        projectId: PROJECT,
        name: 'x.txt',
        contentType: 'text/plain',
        bytes: makeBytes('y'),
        folderId: otherFolder.id,
      }),
    ).rejects.toBeInstanceOf(InvalidFolderHierarchyError);
  });
});

describe('DocumentManagementService folder organization (Req 28.2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('organizes a document into a folder and presents it within its folder', async () => {
    const folder = await h.service.createFolder(principal, { projectId: PROJECT, name: 'Reports' });
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'q1.pdf',
      contentType: 'application/pdf',
      bytes: makeBytes('q1'),
    });
    // Initially at the Project root.
    expect((await h.service.listFolder(principal, PROJECT, null)).map((d) => d.id)).toEqual([doc.id]);

    await h.service.organize(principal, doc.id, folder.id);

    // Now presented within the folder, not the root.
    expect(await h.service.listFolder(principal, PROJECT, null)).toHaveLength(0);
    const inFolder = await h.service.listFolder(principal, PROJECT, folder.id);
    expect(inFolder.map((d) => d.id)).toEqual([doc.id]);
    expect(inFolder[0]!.folderId).toBe(folder.id);
    expect(h.audit.withAction('document.organize')).toHaveLength(1);
  });

  it('rejects organizing into a folder of a different Project', async () => {
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'a.txt',
      contentType: 'text/plain',
      bytes: makeBytes('a'),
    });
    const otherFolder = await h.service.createFolder(
      makePrincipal({ projectIds: ['proj-2'] }),
      { projectId: 'proj-2', name: 'Other' },
    );
    await expect(h.service.organize(principal, doc.id, otherFolder.id)).rejects.toBeInstanceOf(
      InvalidFolderHierarchyError,
    );
  });

  it('detaches a document back to the Project root with folderId null', async () => {
    const folder = await h.service.createFolder(principal, { projectId: PROJECT, name: 'F' });
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'a.txt',
      contentType: 'text/plain',
      bytes: makeBytes('a'),
      folderId: folder.id,
    });
    await h.service.organize(principal, doc.id, null);
    const root = await h.service.listFolder(principal, PROJECT, null);
    expect(root.map((d) => d.id)).toEqual([doc.id]);
  });
});

describe('DocumentManagementService.addVersion version retention (Req 28.3, 28.5)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('creates a new version and retains all prior versions', async () => {
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'doc.txt',
      contentType: 'text/plain',
      bytes: makeBytes('v1'),
    });
    await h.service.addVersion(principal, doc.id, { bytes: makeBytes('v2-bytes') });
    await h.service.addVersion(principal, doc.id, { bytes: makeBytes('v3-bytes-longer') });

    const versions = await h.service.listVersions(principal, doc.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    // Each version's bytes are retained in the Object_Store at distinct keys.
    expect(new Set(versions.map((v) => v.objectKey)).size).toBe(3);
    expect(await h.objects.get(versions[0]!.objectKey)).toEqual(makeBytes('v1'));
    expect(await h.objects.get(versions[2]!.objectKey)).toEqual(makeBytes('v3-bytes-longer'));

    const head = await h.service.getDocument(principal, doc.id);
    expect(head!.version).toBe(3);
    expect(head!.sizeBytes).toBe(makeBytes('v3-bytes-longer').length);
  });

  it('audits each new version and re-emits content for ingestion', async () => {
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'doc.txt',
      contentType: 'text/plain',
      bytes: makeBytes('v1'),
    });
    const ingestionBefore = h.ingestion.count;
    await h.service.addVersion(principal, doc.id, { bytes: makeBytes('v2') });
    expect(h.audit.withAction('document.add_version')).toHaveLength(1);
    expect(h.ingestion.count).toBe(ingestionBefore + 1);
    expect(h.ingestion.last!.event.version).toBe(2);
  });

  it('throws DocumentNotFoundError versioning a non-existent document', async () => {
    await expect(
      h.service.addVersion(principal, 'missing', { bytes: makeBytes('x') }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
  });
});

describe('DocumentManagementService permissions and enforcement (Req 28.4, 28.8)', () => {
  it('persists document permissions and audits the change', async () => {
    const h = makeHarness();
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'doc.txt',
      contentType: 'text/plain',
      bytes: makeBytes('body'),
    });
    await h.service.setPermissions(
      principal,
      { kind: 'document', id: doc.id },
      makePermissions({ projectEditors: false, editorIds: ['user-9'] }),
    );
    const reloaded = await h.service.getDocument(principal, doc.id);
    expect(reloaded!.permissions.projectEditors).toBe(false);
    expect(reloaded!.permissions.editorIds).toEqual(['user-9']);
    expect(h.audit.withAction('document.set_permissions')).toHaveLength(1);
  });

  it('denies an access AND records the denied attempt (Req 28.8)', async () => {
    const store = new InMemoryDocumentStore(monotonicClock());
    const objects = new InMemoryObjectStore();
    const audit = new CapturingAuditRecorder();
    const ingestion = new CapturingDocumentIngestionEmitter();
    const backup = new InMemoryDocumentBackupStore();
    const compliance = new RecordingComplianceManager();
    const service = new DocumentManagementService({
      documents: store,
      objectStore: objects,
      audit,
      ingestion,
      backup,
      compliance,
      authorizer: new DenyAllDocAuthorizer('insufficient permission'),
      idGenerator: sequentialDocumentIdGenerator(),
    });
    // Seed a document directly (upload doesn't authorize, but addVersion does).
    const ctx = { organizationId: 'org-1', userId: 'user-1' };
    await store.createDocument(ctx, {
      id: 'doc-1',
      versionId: 'ver-1',
      projectId: PROJECT,
      ownerId: 'owner-x',
      name: 'doc.txt',
      contentType: 'text/plain',
      sizeBytes: 2,
      objectKey: 'documents/org-1/doc-1/v1',
      permissions: makePermissions(),
    });

    await expect(
      service.addVersion(principal, 'doc-1', { bytes: makeBytes('v2') }),
    ).rejects.toBeInstanceOf(DocumentAccessDeniedError);

    // The denial is audited and no new version was created.
    expect(audit.withAction('document.access_denied')).toHaveLength(1);
    const versions = await service.listVersions(principal, 'doc-1');
    expect(versions).toHaveLength(1);
  });
});

describe('DocumentManagementService recovery window (Req 28.7)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  async function uploadDoc(): Promise<string> {
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'doc.txt',
      contentType: 'text/plain',
      bytes: makeBytes('important'),
    });
    return doc.id;
  }

  it('soft-deletes a document into trash, removing it from folder listings', async () => {
    const id = await uploadDoc();
    const trashed = await h.service.softDelete(principal, id);
    expect(trashed.deletedAt).toBeTruthy();
    expect(await h.service.listFolder(principal, PROJECT, null)).toHaveLength(0);
    expect((await h.service.listTrash(principal)).map((d) => d.id)).toEqual([id]);
    expect(h.audit.withAction('document.soft_delete')).toHaveLength(1);
    expect(h.backup.has({ organizationId: 'org-1', userId: 'user-1' }, id)).toBe(true);
  });

  it('recovers a document within the recovery window and re-emits for ingestion', async () => {
    const id = await uploadDoc();
    await h.service.softDelete(principal, id);
    const ingestionBefore = h.ingestion.count;

    // Advance to just before the deadline (still inside the window).
    h.clock.advance(DEFAULT_RECOVERY_WINDOW_MS - 1);
    const restored = await h.service.recover(principal, id);
    expect(restored.deletedAt).toBeUndefined();

    // Back in the active folder listing, audited, and re-emitted for ingestion.
    expect((await h.service.listFolder(principal, PROJECT, null)).map((d) => d.id)).toEqual([id]);
    expect(h.audit.withAction('document.recover')).toHaveLength(1);
    expect(h.ingestion.count).toBe(ingestionBefore + 1);
    expect(await h.service.listTrash(principal)).toHaveLength(0);
  });

  it('recovers exactly at the recovery-window deadline (inclusive boundary)', async () => {
    const id = await uploadDoc();
    await h.service.softDelete(principal, id);
    h.clock.advance(DEFAULT_RECOVERY_WINDOW_MS); // exactly at the deadline
    const restored = await h.service.recover(principal, id);
    expect(restored.deletedAt).toBeUndefined();
  });

  it('refuses recovery after the window and permanently purges the document', async () => {
    const id = await uploadDoc();
    await h.service.softDelete(principal, id);
    h.clock.advance(DEFAULT_RECOVERY_WINDOW_MS + 1); // one ms past the deadline

    await expect(h.service.recover(principal, id)).rejects.toBeInstanceOf(
      RecoveryWindowExpiredError,
    );
    // Permanently purged: gone from trash, store, and backup; bytes deleted.
    expect(await h.service.listTrash(principal)).toHaveLength(0);
    expect(await h.service.getDocument(principal, id)).toBeNull();
    expect(h.audit.withAction('document.purge')).toHaveLength(1);
  });

  it('purgeExpired removes only documents whose window has elapsed', async () => {
    // expiredId is soft-deleted at t0; its window closes at t0 + WINDOW.
    const expiredId = await uploadDoc();
    await h.service.softDelete(principal, expiredId);

    // Move time past expiredId's window, then soft-delete a fresh document so its
    // window starts now and is therefore still open.
    h.clock.advance(DEFAULT_RECOVERY_WINDOW_MS + DAY_MS);
    const freshId = (
      await h.service.upload(principal, {
        projectId: PROJECT,
        name: 'fresh.txt',
        contentType: 'text/plain',
        bytes: makeBytes('fresh'),
      })
    ).id;
    await h.service.softDelete(principal, freshId);

    const purged = await h.service.purgeExpired(principal);
    expect(purged).toEqual([expiredId]);
    expect((await h.service.listTrash(principal)).map((d) => d.id)).toEqual([freshId]);
  });
});

describe('DocumentManagementService retention via Compliance_Manager (Req 28.6)', () => {
  it('applies the configured archive action to a document past its retention deadline', async () => {
    const h = makeHarness();
    // Retention deadline already in the past relative to the monotonic store clock.
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'old.pdf',
      contentType: 'application/pdf',
      bytes: makeBytes('archive me'),
      retentionAction: 'archive',
      retentionUntil: '2020-01-01T00:00:00.000Z',
    });

    const acted = await h.service.applyDueRetention(principal);
    expect(acted).toEqual([doc.id]);
    expect(h.compliance.last!.documentId).toBe(doc.id);
    expect(h.compliance.last!.action).toBe('archive');
    expect(h.audit.withAction('document.retention_applied')).toHaveLength(1);

    // Archived documents drop out of the active folder listing.
    expect(await h.service.listFolder(principal, PROJECT, null)).toHaveLength(0);
    const reloaded = await h.service.getDocument(principal, doc.id);
    expect(reloaded!.archivedAt).toBeTruthy();
  });

  it('applies a delete retention action by soft-deleting into the recovery window', async () => {
    const h = makeHarness();
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'expire.txt',
      contentType: 'text/plain',
      bytes: makeBytes('delete me'),
      retentionAction: 'delete',
      retentionUntil: '2020-01-01T00:00:00.000Z',
    });

    await h.service.applyDueRetention(principal);
    expect(h.compliance.last!.action).toBe('delete');
    // A retention deletion remains recoverable (it is in trash).
    expect((await h.service.listTrash(principal)).map((d) => d.id)).toEqual([doc.id]);
  });

  it('does not act on a document whose retention has not yet elapsed', async () => {
    const h = makeHarness();
    await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'future.txt',
      contentType: 'text/plain',
      bytes: makeBytes('keep'),
      retentionAction: 'archive',
      retentionUntil: '2999-01-01T00:00:00.000Z',
    });
    const acted = await h.service.applyDueRetention(principal);
    expect(acted).toHaveLength(0);
    expect(h.compliance.applied).toHaveLength(0);
  });
});

describe('DocumentManagementService tenant isolation (Req 1.4)', () => {
  it('does not surface a document from another Organization', async () => {
    const h = makeHarness();
    const orgAPrincipal = makePrincipal({ organizationId: 'org-a', projectIds: [PROJECT] });
    const doc = await h.service.upload(orgAPrincipal, {
      projectId: PROJECT,
      name: 'secret.pdf',
      contentType: 'application/pdf',
      bytes: makeBytes('classified'),
    });
    const orgBPrincipal = makePrincipal({ organizationId: 'org-b', projectIds: [PROJECT] });
    expect(await h.service.getDocument(orgBPrincipal, doc.id)).toBeNull();
    await expect(
      h.service.addVersion(orgBPrincipal, doc.id, { bytes: makeBytes('hacked') }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
  });
});

describe('DocumentManagementService.getBytes authorization (Req 28.4, 28.8)', () => {
  it('returns the head bytes for an authorized viewer', async () => {
    const h = makeHarness();
    const doc = await h.service.upload(principal, {
      projectId: PROJECT,
      name: 'doc.txt',
      contentType: 'text/plain',
      bytes: makeBytes('readable'),
    });
    expect(await h.service.getBytes(principal, doc.id)).toEqual(makeBytes('readable'));
  });

  it('denies and audits an unauthorized read', async () => {
    const h = makeHarness(new DenyAllDocAuthorizer('not a viewer'));
    // Seed via the store so the upload happens without authorization.
    const ctx = { organizationId: 'org-1', userId: 'user-1' };
    await h.objects.put('documents/org-1/doc-1/v1', makeBytes('secret'), {
      contentType: 'text/plain',
    });
    await h.store.createDocument(ctx, {
      id: 'doc-1',
      versionId: 'ver-1',
      projectId: PROJECT,
      ownerId: 'owner-x',
      name: 'doc.txt',
      contentType: 'text/plain',
      sizeBytes: 6,
      objectKey: 'documents/org-1/doc-1/v1',
      permissions: makePermissions(),
    });
    await expect(h.service.getBytes(principal, 'doc-1')).rejects.toBeInstanceOf(
      DocumentAccessDeniedError,
    );
    expect(h.audit.withAction('document.access_denied')).toHaveLength(1);
  });
});
