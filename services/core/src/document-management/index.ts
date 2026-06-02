/**
 * Document_Management_Service (Req 28.1-28.8): the native enterprise document
 * store.
 *
 * The Document_Management_Service manages Project-scoped documents whose original
 * bytes live in the Object_Store and whose metadata (name, owning Project, owner,
 * size, content type, version) is persisted alongside (Req 28.1); organizes
 * documents into a folder hierarchy presented within their folders (Req 28.2);
 * versions a document on every new upload while retaining the full version
 * history (Req 28.3); enforces each document's configured view/edit permissions
 * through an Access_Control seam on every operation (Req 28.4), recording every
 * denied access in the Audit_Service (Req 28.8); emits each document's content
 * for ingestion on every write so it is retrievable through RAG and Unified
 * Search (Req 28.5); applies a configured retention action through a
 * Compliance_Manager seam when retention elapses (Req 28.6); and protects
 * deletions with a recovery window — soft-deleting a document to "trash" from
 * which it can be restored through a Backup_Service seam while the window is
 * open, and permanently purging it once the window has elapsed (Req 28.7).
 *
 * Every external capability is a narrow injectable port — the tenant-scoped
 * {@link DocumentStore}, the shared {@link import('../storage/index.js').ObjectStore},
 * the shared {@link import('../audit/index.js').AuditRecorder}, the
 * {@link DocumentIngestionEmitter} (so it never hard-wires the
 * Knowledge_Ingestion_Service), the {@link DocumentBackupStore} (the
 * Backup_Service seam), the {@link DocumentComplianceManager} (the
 * Compliance_Manager seam), the {@link DocAuthorizer} (default
 * {@link PermissionsDocAuthorizer}), and the {@link DocumentClock} (so the
 * recovery window is testable) — so the service is pure orchestration and fully
 * unit-testable with the in-memory fakes in `./fakes.js`.
 *
 * Recovery-window surface (Req 28.7, for the companion Property 60 test):
 *   - {@link DocumentManagementService.softDelete} — move a document to trash and
 *     open its recovery window;
 *   - {@link DocumentManagementService.recover} — restore from the Backup_Service
 *     iff the request is within the window, else purge and throw
 *     {@link RecoveryWindowExpiredError};
 *   - {@link DocumentManagementService.purgeExpired} — purge every trashed
 *     document whose window has elapsed;
 *   - {@link DocumentManagementService.listTrash} — list still-recoverable
 *     documents;
 *   - the pure {@link isWithinRecoveryWindow} / {@link isRecoveryWindowExpired} /
 *     {@link recoveryDeadlineMs} core and {@link DEFAULT_RECOVERY_WINDOW_MS}.
 *
 * The in-memory test fakes (a {@link DocumentStore}, a capturing audit recorder,
 * an ingestion emitter, a backup store, a compliance manager, allow/deny
 * authorizers, the advanceable {@link MutableDocumentClock}, and the builders)
 * live in `./fakes.js` and are intentionally NOT re-exported from this barrel —
 * they would collide with the equally-named audit-recorder/object-store fakes of
 * sibling modules at the package barrel. Following the established convention,
 * the unit tests here import them directly from `./fakes.js`.
 *
 * The injectable clock is surfaced as {@link DocumentClock} /
 * {@link systemDocumentClock} (rather than `Clock` / `systemClock`) so the names
 * never collide with the Model_Router's, Scheduler's, or Cache_Manager's
 * identically-purposed clocks in the shared `@auxify/core` barrel.
 */

export {
  DocumentManagementService,
  type DocumentManagementServiceOptions,
  type DocumentIdGenerator,
} from './document-management-service.js';

export { PermissionsDocAuthorizer } from './doc-authorizer.js';

export {
  DEFAULT_RECOVERY_WINDOW_MS,
  recoveryDeadlineMs,
  isWithinRecoveryWindow,
  isRecoveryWindowExpired,
} from './recovery.js';

export {
  DocumentNotFoundError,
  FolderNotFoundError,
  DocumentAccessDeniedError,
  InvalidFolderHierarchyError,
  RecoveryWindowExpiredError,
  DOCUMENT_NOT_FOUND_CODE,
  FOLDER_NOT_FOUND_CODE,
  DOCUMENT_ACCESS_DENIED_CODE,
  INVALID_FOLDER_HIERARCHY_CODE,
  RECOVERY_WINDOW_EXPIRED_CODE,
} from './errors.js';

export {
  DEFAULT_DOC_PERMISSIONS,
  RETENTION_ACTIONS,
  DOC_ACTIONS,
  systemDocumentClock,
  isRetentionAction,
  type DocPermissions,
  type RetentionAction,
  type Document,
  type DocumentVersion,
  type Folder,
  type DocumentInput,
  type DocumentUpload,
  type FolderInput,
  type DocTarget,
  type DocAction,
  type DocAuthzDecision,
  type DocAuthorizer,
  type DocumentIngestionEvent,
  type DocumentIngestionEmitter,
  type DocumentBackup,
  type DocumentBackupStore,
  type DocumentComplianceManager,
  type DocumentClock,
  type CreateDocumentRow,
  type AddVersionRow,
  type DocumentContentWrite,
  type CreateFolderRow,
  type ListDocumentsOptions,
  type DocumentStore,
} from './types.js';
