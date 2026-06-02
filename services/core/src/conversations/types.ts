/**
 * Conversation_Manager domain types (Req 5, 6.6).
 *
 * These are the camelCase domain shapes the Conversation_Manager returns to its
 * callers, distinct from the snake_case persistence rows handled by the
 * repository layer. The {@link Conversation} shape mirrors the design's
 * "Conversations and Messages" model (optional columns are surfaced as
 * `T | undefined` rather than the repository's `T | null`).
 *
 * The manager composes the {@link ConversationStore} and {@link MessageStore}
 * ports (structurally satisfied by `ConversationRepository` and
 * `MessageRepository`) plus the {@link AuditRecorder} port, so it stays
 * unit-testable behind narrow seams.
 */

import type { TenantContext } from '@auxify/types';

import type {
  ConversationRecord,
  CreateConversationInput,
  ListOptions,
  MessageRecord,
  UpdateConversationInput,
  UpdateMessageInput,
} from '../repositories/index.js';

/** A conversation's sharing mode (Req 5.6). */
export type ShareMode = 'read' | 'collab';

/** All {@link ShareMode} values, for validation and test generators. */
export const SHARE_MODES: readonly ShareMode[] = ['read', 'collab'] as const;

/** A conversation export format (Req 5.7). */
export type ExportFormat = 'md' | 'pdf' | 'json' | 'html';

/** All {@link ExportFormat} values, for validation and test generators. */
export const EXPORT_FORMATS: readonly ExportFormat[] = ['md', 'pdf', 'json', 'html'] as const;

/**
 * A conversation in its domain shape (Req 5.1, 5.2).
 *
 * Mirrors the design's `Conversation` interface; optional columns are surfaced
 * as `undefined` (not `null`) so consumers branch uniformly.
 */
export interface Conversation {
  id: string;
  organizationId: string;
  projectId: string;
  ownerId: string;
  title: string;
  folderId?: string;
  archived: boolean;
  shareToken?: string;
  shareMode?: ShareMode;
  personaId?: string;
  activeModelId?: string;
  createdAt: string;
  /** Last-update timestamp; conversation listing is ordered by this (Req 5.2). */
  updatedAt: string;
}

/** A persisted message in its domain shape (re-exported repository record). */
export type Message = MessageRecord;

/** Fields a caller supplies to create a conversation (Req 5.1). */
export interface ConversationCreate {
  /** The owning Project (Req 5.1). */
  projectId: string;
  /** The owner; defaults to the acting user in the {@link TenantContext}. */
  ownerId?: string;
  /** The editable title; defaults to an empty string (Req 5.1). */
  title?: string;
  /** Optional initial folder assignment (Req 5.4). */
  folderId?: string;
  /** Optional persona to apply (Req 9.3). */
  personaId?: string;
  /** Optional active model (Req 3.10). */
  activeModelId?: string;
  /** Optional explicit id; one is generated when omitted. */
  id?: string;
}

/**
 * A date-labelled group of conversations (Req 5.2).
 *
 * The list is returned most-recent-update first and partitioned into groups by
 * calendar day; `dateLabel` is a human label (`Today`, `Yesterday`, or the
 * `YYYY-MM-DD` date) and `date` is the stable `YYYY-MM-DD` UTC grouping key.
 */
export interface ConversationGroup {
  /** Human-readable label: `Today`, `Yesterday`, or the `YYYY-MM-DD` date. */
  dateLabel: string;
  /** The stable `YYYY-MM-DD` UTC day key for the group. */
  date: string;
  /** The group's conversations, most-recent-update first. */
  conversations: Conversation[];
}

/** A share link for a conversation (Req 5.6). */
export interface ShareToken {
  /** The shared conversation's id. */
  conversationId: string;
  /** The unique, hard-to-guess share token. */
  token: string;
  /** The enforced access mode of the link. */
  mode: ShareMode;
}

/** A produced conversation export (Req 5.7). */
export interface ExportArtifact {
  /** The exported conversation's id. */
  conversationId: string;
  /** The requested format. */
  format: ExportFormat;
  /** A suggested download filename including the format extension. */
  filename: string;
  /** The MIME content type for the format. */
  contentType: string;
  /** The serialized conversation in the requested format. */
  content: string;
}

/**
 * A conversation search hit ranked by relevance (Req 5.5).
 *
 * This is the basic, owner-scoped contains-ranking the Conversation_Manager
 * provides; the platform's authorized, vector + keyword ranked retrieval
 * (Property 18, task 12.6) is implemented by the Unified_Search_Service.
 */
export interface SearchHit {
  /** The matching conversation. */
  conversation: Conversation;
  /** The relevance score (higher is more relevant). */
  score: number;
  /** Whether the query matched the conversation title. */
  titleMatch: boolean;
  /** The number of messages whose content matched the query. */
  messageMatches: number;
}

/**
 * The persistence port the Conversation_Manager needs over `conversations`.
 *
 * `ConversationRepository` satisfies this structurally; tests substitute an
 * in-memory fake. Keeping the manager behind this port (and {@link MessageStore})
 * lets it be unit-tested without a database while still composing the real
 * tenant-scoped repository in production.
 */
export interface ConversationStore {
  create(ctx: TenantContext, input: CreateConversationInput): Promise<ConversationRecord>;
  findById(ctx: TenantContext, id: string): Promise<ConversationRecord | null>;
  listByOwner(
    ctx: TenantContext,
    ownerId: string,
    options?: Pick<ListOptions, 'limit' | 'offset'>,
  ): Promise<ConversationRecord[]>;
  list(
    ctx: TenantContext,
    options?: Pick<ListOptions, 'limit' | 'offset'>,
  ): Promise<ConversationRecord[]>;
  update(
    ctx: TenantContext,
    id: string,
    input: UpdateConversationInput,
  ): Promise<ConversationRecord | null>;
  delete(ctx: TenantContext, id: string): Promise<boolean>;
}

/** The persistence port the Conversation_Manager needs over `messages`. */
export interface MessageStore {
  findById(ctx: TenantContext, id: string): Promise<MessageRecord | null>;
  listByConversation(
    ctx: TenantContext,
    conversationId: string,
    options?: Pick<ListOptions, 'limit' | 'offset'>,
  ): Promise<MessageRecord[]>;
  update(ctx: TenantContext, id: string, input: UpdateMessageInput): Promise<MessageRecord | null>;
}

/**
 * Map a persistence {@link ConversationRecord} (nullable columns) to the domain
 * {@link Conversation} (optional fields).
 */
export function toConversation(record: ConversationRecord): Conversation {
  const conversation: Conversation = {
    id: record.id,
    organizationId: record.organizationId,
    projectId: record.projectId,
    ownerId: record.ownerId,
    title: record.title,
    archived: record.archived,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.folderId !== null) conversation.folderId = record.folderId;
  if (record.shareToken !== null) conversation.shareToken = record.shareToken;
  if (record.shareMode !== null) conversation.shareMode = record.shareMode;
  if (record.personaId !== null) conversation.personaId = record.personaId;
  if (record.activeModelId !== null) conversation.activeModelId = record.activeModelId;
  return conversation;
}
