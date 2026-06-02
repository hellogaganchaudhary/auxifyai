/**
 * The Conversation_Manager (Req 5, 6.6).
 *
 * Handles the conversation lifecycle for a Project workspace: create, list,
 * rename, archive, delete, folder assignment, basic full-text search, share
 * links, export, and message pinning. It composes three injected ports so it is
 * unit-testable without a database:
 *
 *   - a {@link ConversationStore} (satisfied by `ConversationRepository`) and a
 *     {@link MessageStore} (satisfied by `MessageRepository`) — both already
 *     tenant-scoped, so every operation is automatically confined to the
 *     caller's Organization (Req 1.2, 1.4); and
 *   - an {@link AuditRecorder} port (the concrete Audit_Service, task 3.9) —
 *     so *every mutation* (create, rename, archive, delete, folder assignment,
 *     share, pin) is recorded in the immutable audit trail (Req 5.3, 37.1).
 *
 * Responsibilities mapped to acceptance criteria:
 *   - {@link create} — persists owner, owning Project, creation timestamp, and
 *     an editable title (Req 5.1), audited.
 *   - {@link list} — returns the owner's conversations ordered by most recent
 *     update and grouped by date (Req 5.2 / Property 17), via the pure
 *     {@link groupByDate} core with an injectable clock.
 *   - {@link rename} / {@link archive} / {@link delete} — apply the change and
 *     record it in the Audit_Service (Req 5.3).
 *   - {@link assignFolder} — associates a conversation with a folder so the
 *     association is reflected in the listing (Req 5.4), audited.
 *   - {@link search} — owner-scoped contains-ranking across titles + message
 *     content (Req 5.5); richer authorized ranked retrieval is the
 *     Unified_Search_Service (Property 18, task 12.6).
 *   - {@link createShareLink} — mints a unique share token and enforces the
 *     configured read/collab access mode (Req 5.6), audited.
 *   - {@link export} — produces the conversation in the requested
 *     md/pdf/json/html format (Req 5.7).
 *   - {@link pin} — marks a message pinned and makes pinned messages retrievable
 *     for its conversation (Req 6.6), audited.
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import {
  ConversationNotFoundError,
  MessageNotFoundError,
  UnknownExportFormatError,
  isExportFormat,
} from './errors.js';
import { compareRecentFirst, groupByDate } from './date-grouping.js';
import { exportConversation } from './export.js';
import { searchConversations, type SearchableConversation } from './search.js';
import {
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

/** Generates unique ids and share tokens (injectable for deterministic tests). */
export interface ConversationIdGenerator {
  /** A unique conversation id. */
  id(): string;
  /** A unique, hard-to-guess share token (Req 5.6). */
  shareToken(): string;
}

/** Default id/token generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: ConversationIdGenerator = {
  id: () => randomUUID(),
  shareToken: () => `${randomUUID()}${randomUUID()}`.replace(/-/g, ''),
};

/** Construction dependencies for the {@link ConversationManager}. */
export interface ConversationManagerOptions {
  /** The conversations store (tenant-scoped `ConversationRepository`). */
  conversations: ConversationStore;
  /** The messages store (tenant-scoped `MessageRepository`). */
  messages: MessageStore;
  /** The append-only audit sink; every mutation is recorded through it (Req 5.3, 37.1). */
  audit: AuditRecorder;
  /** Optional id/token generator (defaults to `crypto.randomUUID`). */
  idGenerator?: ConversationIdGenerator;
  /** Optional clock for `Today`/`Yesterday` labels and timestamps (deterministic tests). */
  now?: () => Date;
}

/**
 * The Conversation_Manager. Construct once with its ports, then call its
 * lifecycle methods with the acting user's {@link TenantContext}.
 */
export class ConversationManager {
  private readonly conversations: ConversationStore;
  private readonly messages: MessageStore;
  private readonly audit: AuditRecorder;
  private readonly ids: ConversationIdGenerator;
  private readonly now: () => Date;

  constructor(options: ConversationManagerOptions) {
    this.conversations = options.conversations;
    this.messages = options.messages;
    this.audit = options.audit;
    this.ids = options.idGenerator ?? defaultIdGenerator;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Create a conversation, persisting its owner, owning Project, creation
   * timestamp, and editable title (Req 5.1). The owner defaults to the acting
   * user. The creation is recorded in the Audit_Service.
   */
  async create(ctx: TenantContext, input: ConversationCreate): Promise<Conversation> {
    const id = input.id ?? this.ids.id();
    const ownerId = input.ownerId ?? ctx.userId;
    const record = await this.conversations.create(ctx, {
      id,
      projectId: input.projectId,
      ownerId,
      title: input.title ?? '',
      folderId: input.folderId ?? null,
      personaId: input.personaId ?? null,
      activeModelId: input.activeModelId ?? null,
    });
    await this.audit.record(ctx, {
      action: 'conversation.create',
      resourceType: 'conversation',
      resourceId: record.id,
      metadata: { projectId: record.projectId, ownerId: record.ownerId },
    });
    return toConversation(record);
  }

  /**
   * List the acting user's conversations ordered by most recent update and
   * grouped by date (Req 5.2 / Property 17).
   *
   * The store returns the owner's conversations already ordered `updated_at`
   * DESC; this re-sorts with the total {@link compareRecentFirst} comparator (to
   * make the order deterministic on `updatedAt` ties) and then partitions them
   * into date groups against the injected clock. Reads are not audited.
   */
  async list(ctx: TenantContext, ownerId: string = ctx.userId): Promise<ConversationGroup[]> {
    const records = await this.conversations.listByOwner(ctx, ownerId);
    const conversations = records.map(toConversation).sort(compareRecentFirst);
    return groupByDate(conversations, this.now());
  }

  /**
   * Rename a conversation's editable title and record the change in the
   * Audit_Service (Req 5.3). Raises {@link ConversationNotFoundError} when no
   * conversation matches within the caller's Organization.
   */
  async rename(ctx: TenantContext, id: string, title: string): Promise<void> {
    const updated = await this.conversations.update(ctx, id, { title });
    if (updated === null) {
      throw new ConversationNotFoundError(id);
    }
    await this.audit.record(ctx, {
      action: 'conversation.rename',
      resourceType: 'conversation',
      resourceId: id,
      metadata: { title },
    });
  }

  /**
   * Archive a conversation and record the change in the Audit_Service
   * (Req 5.3). Raises {@link ConversationNotFoundError} when no conversation
   * matches within the caller's Organization.
   */
  async archive(ctx: TenantContext, id: string): Promise<void> {
    const updated = await this.conversations.update(ctx, id, { archived: true });
    if (updated === null) {
      throw new ConversationNotFoundError(id);
    }
    await this.audit.record(ctx, {
      action: 'conversation.archive',
      resourceType: 'conversation',
      resourceId: id,
    });
  }

  /**
   * Delete a conversation and record the change in the Audit_Service (Req 5.3).
   * Raises {@link ConversationNotFoundError} when no conversation matches within
   * the caller's Organization.
   */
  async delete(ctx: TenantContext, id: string): Promise<void> {
    const deleted = await this.conversations.delete(ctx, id);
    if (!deleted) {
      throw new ConversationNotFoundError(id);
    }
    await this.audit.record(ctx, {
      action: 'conversation.delete',
      resourceType: 'conversation',
      resourceId: id,
    });
  }

  /**
   * Assign a conversation to a folder so the association is reflected in the
   * conversation listing (Req 5.4). The change is recorded in the
   * Audit_Service. Raises {@link ConversationNotFoundError} when no conversation
   * matches within the caller's Organization.
   */
  async assignFolder(ctx: TenantContext, id: string, folderId: string): Promise<void> {
    const updated = await this.conversations.update(ctx, id, { folderId });
    if (updated === null) {
      throw new ConversationNotFoundError(id);
    }
    await this.audit.record(ctx, {
      action: 'conversation.assign_folder',
      resourceType: 'conversation',
      resourceId: id,
      metadata: { folderId },
    });
  }

  /**
   * Full-text search the acting user's conversations across titles and message
   * content, ranked by relevance (Req 5.5).
   *
   * Scope is the owner's authorized conversations (tenant-scoped owner listing);
   * each conversation's messages are loaded to search its body. This is the
   * basic contains-ranking; the authorized combined keyword + vector ranked
   * retrieval validated by Property 18 (task 12.6) lives in the
   * Unified_Search_Service. Reads are not audited.
   */
  async search(
    ctx: TenantContext,
    query: string,
    ownerId: string = ctx.userId,
  ): Promise<SearchHit[]> {
    const records = await this.conversations.listByOwner(ctx, ownerId);
    const items: SearchableConversation[] = [];
    for (const record of records) {
      const messages = await this.messages.listByConversation(ctx, record.id);
      items.push({ conversation: toConversation(record), messages });
    }
    return searchConversations(items, query);
  }

  /**
   * Create a share link for a conversation: mint a unique share token and
   * enforce the configured read-only or collaborative access mode (Req 5.6).
   * The token and mode are persisted on the conversation, and the action is
   * recorded in the Audit_Service. Raises {@link ConversationNotFoundError} when
   * no conversation matches within the caller's Organization.
   */
  async createShareLink(ctx: TenantContext, id: string, mode: ShareMode): Promise<ShareToken> {
    const token = this.ids.shareToken();
    const updated = await this.conversations.update(ctx, id, {
      shareToken: token,
      shareMode: mode,
    });
    if (updated === null) {
      throw new ConversationNotFoundError(id);
    }
    await this.audit.record(ctx, {
      action: 'conversation.share',
      resourceType: 'conversation',
      resourceId: id,
      metadata: { mode },
    });
    return { conversationId: id, token, mode };
  }

  /**
   * Export a conversation in the requested format — Markdown, PDF, JSON, or
   * HTML (Req 5.7). The conversation's messages are loaded in chronological
   * order and serialized by the pure {@link exportConversation}. Raises
   * {@link UnknownExportFormatError} for an unsupported format and
   * {@link ConversationNotFoundError} when no conversation matches. Export is a
   * read; it is not audited.
   */
  async export(ctx: TenantContext, id: string, fmt: ExportFormat): Promise<ExportArtifact> {
    if (!isExportFormat(fmt)) {
      throw new UnknownExportFormatError(String(fmt));
    }
    const record = await this.conversations.findById(ctx, id);
    if (record === null) {
      throw new ConversationNotFoundError(id);
    }
    const messages = await this.messages.listByConversation(ctx, id);
    return exportConversation(toConversation(record), messages, fmt);
  }

  /**
   * Pin a message: mark it pinned so pinned messages are retrievable for the
   * conversation (Req 6.6). The action is recorded in the Audit_Service. Raises
   * {@link MessageNotFoundError} when no message matches within the caller's
   * Organization.
   */
  async pin(ctx: TenantContext, messageId: string): Promise<void> {
    const updated = await this.messages.update(ctx, messageId, { pinned: true });
    if (updated === null) {
      throw new MessageNotFoundError(messageId);
    }
    await this.audit.record(ctx, {
      action: 'message.pin',
      resourceType: 'message',
      resourceId: messageId,
      metadata: { conversationId: updated.conversationId },
    });
  }

  /**
   * Retrieve the pinned messages of a conversation, in chronological order
   * (Req 6.6). Reads are not audited.
   */
  async listPinned(ctx: TenantContext, conversationId: string): Promise<Message[]> {
    const messages = await this.messages.listByConversation(ctx, conversationId);
    return messages.filter((message) => message.pinned);
  }
}
