/**
 * Conversation_Manager (Req 5, 6.6).
 *
 * The service that handles the conversation lifecycle within a Project: create,
 * list (recent-first, date-grouped), rename, archive, delete, folder
 * assignment, basic owner-scoped full-text search, share links with an enforced
 * access mode, export to md/pdf/json/html, and message pinning. It composes the
 * tenant-scoped `ConversationRepository`/`MessageRepository` (so every
 * operation is confined to the caller's Organization, Req 1.2, 1.4) and the
 * {@link import('../audit/index.js').AuditRecorder} port so *every mutation* is
 * recorded in the immutable audit trail (Req 5.3, 37.1).
 *
 * Surface:
 *   - {@link ConversationManager} — the service; one method per acceptance
 *     criterion (create/list/rename/archive/delete/assignFolder/search/
 *     createShareLink/export/pin, plus {@link ConversationManager.listPinned}).
 *   - {@link ConversationStore} / {@link MessageStore} — the narrow persistence
 *     ports the manager composes (satisfied structurally by the repositories).
 *   - {@link groupByDate} / {@link compareRecentFirst} — the pure recent-first
 *     date-grouping core (Req 5.2 / Property 17).
 *   - {@link exportConversation} — the pure md/pdf/json/html serializer (Req 5.7).
 *   - {@link searchConversations} — the pure owner-scoped contains-ranking
 *     (Req 5.5); richer authorized ranked retrieval is the
 *     Unified_Search_Service (Property 18, task 12.6).
 *   - Domain types ({@link Conversation}, {@link ConversationGroup},
 *     {@link ShareToken}, {@link ExportArtifact}, {@link SearchHit}, …) and the
 *     typed errors ({@link ConversationNotFoundError}, {@link MessageNotFoundError},
 *     {@link UnknownExportFormatError}).
 */

export {
  ConversationManager,
  type ConversationManagerOptions,
  type ConversationIdGenerator,
} from './conversation-manager.js';

export { groupByDate, compareRecentFirst, dayKey, dateLabel } from './date-grouping.js';

export { exportConversation } from './export.js';

export { searchConversations, type SearchableConversation } from './search.js';

export {
  ConversationNotFoundError,
  MessageNotFoundError,
  UnknownExportFormatError,
  isExportFormat,
  CONVERSATION_NOT_FOUND_CODE,
  MESSAGE_NOT_FOUND_CODE,
  UNKNOWN_EXPORT_FORMAT_CODE,
} from './errors.js';

export {
  SHARE_MODES,
  EXPORT_FORMATS,
  toConversation,
  type Conversation,
  type ConversationCreate,
  type ConversationGroup,
  type ConversationStore,
  type ExportArtifact,
  type ExportFormat,
  type Message,
  type MessageStore,
  type SearchHit,
  type ShareMode,
  type ShareToken,
} from './types.js';
