/**
 * Messaging_Service (Req 27.1-27.9).
 *
 * The native team-communication service: channels, direct messages (modelled as
 * private channels), threaded replies, real-time delivery, notifications for
 * inactive recipients, file sharing via the Document_Management_Service,
 * authorized ranked search, AI assistance via the Chat_Service, private-channel
 * access restriction, and ingestion-on-write so messaging content is retrievable
 * through Unified Search. It composes the tenant-scoped channel/message stores
 * (so every operation is confined to the caller's Organization, Req 1.2, 1.4),
 * the {@link import('../audit/index.js').AuditRecorder} port (so every mutation
 * and *every denied private-channel access* is recorded, Req 27.8, 37.1, 37.2),
 * and the {@link MessageIngestionEmitter} port (so every created message is
 * emitted for indexing on write, Req 27.9).
 *
 * Surface:
 *   - {@link MessagingService} — the service; one method per acceptance
 *     criterion (createChannel/listChannels/addMember/post/reply/listMessages/
 *     listThread/shareFile/search/aiAssist).
 *   - {@link ChannelStore} / {@link ChannelMessageStore} — the narrow
 *     tenant-scoped persistence ports the service composes.
 *   - {@link MessageIngestionEmitter} — the ingestion-on-write seam (Req 27.9).
 *   - the optional delivery/presence/notifier/file-store/assistant ports
 *     ({@link RealtimeDelivery}, {@link PresenceTracker}, {@link MessageNotifier},
 *     {@link MessagingFileStore}, {@link MessagingChatAssistant}).
 *   - {@link searchMessages} — the pure authorized message ranking (Req 27.6).
 *   - {@link canAccess} — the pure private-channel access predicate (Req 27.8).
 *   - domain types ({@link Channel}, {@link ChannelMessage}, {@link MessageSearchHit},
 *     …) and the typed errors ({@link ChannelNotFoundError},
 *     {@link ChannelMessageNotFoundError}, {@link ChannelAccessDeniedError}).
 *
 * Names are chosen to avoid colliding with the Conversation_Manager's barrel
 * exports (`Message`/`MessageStore`/`MessageNotFoundError`/`SearchHit`): this
 * module exposes `Channel`-prefixed and `Messaging`-prefixed names plus
 * {@link MessageSearchHit}.
 */

export {
  MessagingService,
  canAccess,
  type MessagingServiceOptions,
  type MessagingIdGenerator,
  type RealtimeDelivery,
  type PresenceTracker,
  type MessageNotifier,
  type MessagingUploadedFile,
  type MessagingFileStore,
  type MessagingChatAssistant,
} from './messaging-service.js';

export { searchMessages } from './search.js';

export {
  ChannelNotFoundError,
  ChannelMessageNotFoundError,
  ChannelAccessDeniedError,
  CHANNEL_NOT_FOUND_CODE,
  CHANNEL_MESSAGE_NOT_FOUND_CODE,
  CHANNEL_ACCESS_DENIED_CODE,
} from './errors.js';

export {
  CHANNEL_VISIBILITIES,
  CHANNEL_OWNER_SCOPES,
  type Channel,
  type ChannelVisibility,
  type ChannelOwnerScope,
  type ChannelMessage,
  type ChannelCreate,
  type MessagePost,
  type MessageSearchHit,
  type CreateChannelInput,
  type CreateChannelMessageInput,
  type ChannelStore,
  type MessageListOptions,
  type ChannelMessageStore,
  type MessageIngestionItem,
  type MessageIngestionEmitter,
} from './types.js';
