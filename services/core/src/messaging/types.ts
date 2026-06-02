/**
 * Messaging_Service domain types and ports (Req 27.1-27.9).
 *
 * These are the camelCase domain shapes the Messaging_Service returns to its
 * callers and the narrow injectable ports it composes. The {@link Channel} and
 * {@link ChannelMessage} shapes mirror the design's "Native Modules" model:
 * a Channel carries a name, an owning Team or Project, a visibility setting, and
 * a membership list (Req 27.1, 27.8); a ChannelMessage is the unit of
 * communication, optionally a threaded reply to a parent (Req 27.3) and
 * optionally carrying a Document_Management_Service file reference (Req 27.5).
 *
 * Direct messages are modelled as private channels restricted to their members,
 * so the access model (Req 27.8) is uniform across channels and DMs and the
 * service needs only one persistence shape.
 *
 * Every external capability is a narrow port so the service stays pure
 * orchestration and unit-testable behind fakes:
 *   - {@link ChannelStore} / {@link ChannelMessageStore} — tenant-scoped
 *     persistence (every call carries a {@link TenantContext}, Req 1.2, 1.4);
 *   - the shared {@link import('../audit/index.js').AuditRecorder} (every
 *     mutation and every denied access is recorded, Req 27.8, 37.1, 37.2); and
 *   - the {@link MessageIngestionEmitter} — a narrow seam that emits posted
 *     message content for indexing into RAG / Unified Search on write (Req 27.9)
 *     without the Messaging_Service taking a hard dependency on the concrete
 *     Knowledge_Ingestion_Service.
 */

import type { TenantContext } from '@auxify/types';

/** A channel's visibility setting (Req 27.1, 27.8). */
export type ChannelVisibility = 'public' | 'private';

/** All {@link ChannelVisibility} values, for validation and test generators. */
export const CHANNEL_VISIBILITIES: readonly ChannelVisibility[] = ['public', 'private'] as const;

/** The kind of container a channel is owned by — a Team or a Project (Req 27.1). */
export type ChannelOwnerScope = 'team' | 'project';

/** All {@link ChannelOwnerScope} values, for validation and test generators. */
export const CHANNEL_OWNER_SCOPES: readonly ChannelOwnerScope[] = ['team', 'project'] as const;

/**
 * A channel in its domain shape (Req 27.1, 27.8).
 *
 * Mirrors the design's `Channel` interface: a name, an owning Team or Project
 * (`ownerScope`/`ownerScopeId`), a visibility setting, and the membership list
 * that gates access to a private channel (Req 27.8).
 */
export interface Channel {
  /** The channel's stable unique id. */
  id: string;
  /** The Organization that owns the channel (tenant scope, Req 1.2). */
  organizationId: string;
  /** Whether the channel is owned by a Team or a Project. */
  ownerScope: ChannelOwnerScope;
  /** The owning Team or Project id. */
  ownerScopeId: string;
  /** The channel's display name. */
  name: string;
  /** Public (visible org-wide) or private (members only, Req 27.8). */
  visibility: ChannelVisibility;
  /** The member user ids; access to a private channel is restricted to these. */
  members: string[];
  /** Creation timestamp (ISO-8601). */
  createdAt: string;
}

/**
 * A channel message in its domain shape (Req 27.2-27.5).
 *
 * A message belongs to exactly one channel and is scoped to that channel's
 * Organization (so it carries no `organizationId` of its own — the parent
 * channel is the tenant anchor). A message with a {@link ChannelMessage.parentId}
 * is a threaded reply to that parent (Req 27.3); a message with a
 * {@link ChannelMessage.fileRef} carries a stored Document_Management_Service
 * reference (Req 27.5).
 */
export interface ChannelMessage {
  /** The message's stable unique id. */
  id: string;
  /** The channel the message was posted to. */
  channelId: string;
  /** The parent message id when this message is a threaded reply (Req 27.3). */
  parentId?: string;
  /** The author user id. */
  authorId: string;
  /** The message body text. */
  body: string;
  /** A stored Document_Management_Service reference when a file was shared (Req 27.5). */
  fileRef?: string;
  /** Creation timestamp (ISO-8601); threads are ordered by this (Req 27.3). */
  createdAt: string;
}

/** Fields a caller supplies to create a channel (Req 27.1). */
export interface ChannelCreate {
  /** The channel display name. */
  name: string;
  /** Whether the channel is owned by a Team or a Project. */
  ownerScope: ChannelOwnerScope;
  /** The owning Team or Project id. */
  ownerScopeId: string;
  /** The visibility; defaults to `public` when omitted. */
  visibility?: ChannelVisibility;
  /** The initial members; the acting user is always added if absent. */
  members?: string[];
  /** Optional explicit id; one is generated when omitted. */
  id?: string;
}

/** Fields a caller supplies to post a message or reply (Req 27.2, 27.3, 27.5). */
export interface MessagePost {
  /** The author; defaults to the acting user in the {@link TenantContext}. */
  authorId?: string;
  /** The message body text. */
  body: string;
  /** An optional stored Document_Management_Service file reference (Req 27.5). */
  fileRef?: string;
  /** Optional explicit id; one is generated when omitted. */
  id?: string;
}

/**
 * A message search hit ranked by relevance (Req 27.6).
 *
 * Named {@link MessageSearchHit} (not `SearchHit`) so it does not collide with
 * the Conversation_Manager's `SearchHit` at the package barrel.
 */
export interface MessageSearchHit {
  /** The matching message. */
  message: ChannelMessage;
  /** The relevance score (higher is more relevant). */
  score: number;
}

/** Fields the store needs to create a channel. */
export interface CreateChannelInput {
  /** The channel's id. */
  id: string;
  /** Whether the channel is owned by a Team or a Project. */
  ownerScope: ChannelOwnerScope;
  /** The owning Team or Project id. */
  ownerScopeId: string;
  /** The channel display name. */
  name: string;
  /** The visibility setting. */
  visibility: ChannelVisibility;
  /** The membership list. */
  members: string[];
}

/** Fields the store needs to create a channel message. */
export interface CreateChannelMessageInput {
  /** The message's id. */
  id: string;
  /** The owning channel id. */
  channelId: string;
  /** The parent message id for a threaded reply (Req 27.3). */
  parentId?: string;
  /** The author user id. */
  authorId: string;
  /** The message body text. */
  body: string;
  /** A stored file reference (Req 27.5). */
  fileRef?: string;
  /** Optional explicit creation timestamp; defaults to "now" in the store. */
  createdAt?: string;
}

/**
 * The tenant-scoped persistence port over `channels` (Req 27.1, 27.8).
 *
 * A production `ChannelRepository` satisfies this structurally; tests substitute
 * an in-memory fake. Every call carries the caller's {@link TenantContext} so a
 * channel can never be read or written outside its Organization (Req 1.2, 1.4).
 */
export interface ChannelStore {
  /** Persist a new channel within the caller's Organization. */
  create(ctx: TenantContext, input: CreateChannelInput): Promise<Channel>;
  /** Find a channel by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<Channel | null>;
  /** List every channel in the caller's Organization. */
  list(ctx: TenantContext): Promise<Channel[]>;
  /** Replace a channel's membership list; returns the updated channel or `null` if absent. */
  setMembers(ctx: TenantContext, id: string, members: string[]): Promise<Channel | null>;
}

/** Read-bounding options for message listings. */
export interface MessageListOptions {
  /** Maximum number of rows to return. */
  limit?: number;
  /** Number of rows to skip from the start. */
  offset?: number;
}

/**
 * The tenant-scoped persistence port over `channel_messages` (Req 27.2, 27.3).
 *
 * Messages are scoped through their parent channel's Organization. A
 * production `ChannelMessageRepository` satisfies this structurally; tests
 * substitute an in-memory fake.
 */
export interface ChannelMessageStore {
  /** Persist a new message. */
  create(ctx: TenantContext, input: CreateChannelMessageInput): Promise<ChannelMessage>;
  /** Find a message by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<ChannelMessage | null>;
  /** List a channel's messages in chronological order. */
  listByChannel(
    ctx: TenantContext,
    channelId: string,
    options?: MessageListOptions,
  ): Promise<ChannelMessage[]>;
  /** List the threaded replies to a parent message, in chronological order (Req 27.3). */
  listReplies(
    ctx: TenantContext,
    parentId: string,
    options?: MessageListOptions,
  ): Promise<ChannelMessage[]>;
}

/**
 * A unit of message content emitted for indexing into RAG / Unified Search
 * (Req 27.9).
 *
 * Carries exactly what the Knowledge_Ingestion_Service needs to index the
 * authorized content and attribute a search hit back to the originating channel
 * message, with no coupling to the Messaging_Service's internal types.
 */
export interface MessageIngestionItem {
  /** The originating message id. */
  messageId: string;
  /** The channel the message belongs to. */
  channelId: string;
  /** The author user id. */
  authorId: string;
  /** The message body text to index. */
  body: string;
  /** The message creation timestamp (ISO-8601). */
  createdAt: string;
}

/**
 * The narrow ingestion-on-write port (Req 27.9).
 *
 * When messaging content is created, the Messaging_Service emits it through
 * this port so the Knowledge_Ingestion_Service can index the authorized content
 * for retrieval through Unified Search. The Messaging_Service depends only on
 * this seam — never on the concrete Knowledge_Ingestion_Service — so the
 * dependency is inverted and substitutable in tests.
 */
export interface MessageIngestionEmitter {
  /**
   * Emit a posted message's content for indexing within the caller's
   * Organization.
   *
   * @param ctx The tenant context supplying the Organization scope.
   * @param item The message content to index.
   */
  emit(ctx: TenantContext, item: MessageIngestionItem): Promise<void>;
}
