/**
 * The Messaging_Service (Req 27.1-27.9).
 *
 * The native team-communication service: channels, direct messages, threaded
 * replies, real-time delivery, notifications for inactive recipients, file
 * sharing via the Document_Management_Service, authorized ranked search, AI
 * assistance via the Chat_Service, private-channel access restriction, and
 * ingestion-on-write so messaging content is retrievable through Unified Search.
 *
 * It composes a small set of injected ports so it is pure orchestration and
 * fully unit-testable without a database, WebSocket transport, or AI provider:
 *
 *   - a {@link ChannelStore} and a {@link ChannelMessageStore} — both
 *     tenant-scoped, so every operation is automatically confined to the
 *     caller's Organization (Req 1.2, 1.4);
 *   - the shared {@link AuditRecorder} port (the concrete Audit_Service) — so
 *     every channel mutation and *every denied private-channel access* is
 *     recorded in the immutable audit trail (Req 27.8, 37.1, 37.2); and
 *   - the {@link MessageIngestionEmitter} port — so *every created message* is
 *     emitted for indexing into RAG / Unified Search on write (Req 27.9) without
 *     a hard dependency on the Knowledge_Ingestion_Service.
 *
 * Real-time delivery (Req 27.2), inactive-recipient notification (Req 27.4),
 * file storage (Req 27.5), and AI assistance (Req 27.7) are reached only through
 * further optional ports ({@link RealtimeDelivery}, {@link PresenceTracker},
 * {@link MessageNotifier}, {@link MessagingFileStore}, {@link MessagingChatAssistant})
 * so the service never couples to the WebSocket_Gateway, the
 * Document_Management_Service, or the Chat_Service.
 *
 * Direct messages are modelled as private channels restricted to their members,
 * so the access model (Req 27.8) is uniform across channels and DMs.
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import {
  ChannelAccessDeniedError,
  ChannelMessageNotFoundError,
  ChannelNotFoundError,
} from './errors.js';
import { searchMessages } from './search.js';
import type {
  Channel,
  ChannelCreate,
  ChannelMessage,
  ChannelMessageStore,
  ChannelStore,
  MessageIngestionEmitter,
  MessagePost,
  MessageSearchHit,
} from './types.js';

/** Generates unique ids (injectable for deterministic tests). */
export interface MessagingIdGenerator {
  /** A unique channel id. */
  channelId(): string;
  /** A unique message id. */
  messageId(): string;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: MessagingIdGenerator = {
  channelId: () => randomUUID(),
  messageId: () => randomUUID(),
};

/**
 * Real-time delivery of a posted message to its authorized recipients over the
 * WebSocket_Gateway (Req 27.2).
 *
 * The Messaging_Service computes the authorized recipients (a channel's
 * members) and hands them to this port after persisting; the transport adapter
 * (the WebSocket_Gateway) decides who is connected. Optional: when no delivery
 * port is wired, the service still persists and indexes the message.
 */
export interface RealtimeDelivery {
  /**
   * Deliver a persisted message to the given recipient user ids in real time.
   *
   * @param ctx The tenant context.
   * @param message The persisted message.
   * @param recipientIds The authorized recipient user ids.
   */
  deliver(ctx: TenantContext, message: ChannelMessage, recipientIds: string[]): Promise<void>;
}

/**
 * Tracks which users are actively viewing a channel, so the Messaging_Service
 * can decide who needs a notification (Req 27.4). Optional.
 */
export interface PresenceTracker {
  /**
   * Whether `userId` is actively viewing `channelId` right now.
   *
   * @returns `true` if actively viewing (no notification needed).
   */
  isViewing(userId: string, channelId: string): boolean;
}

/**
 * Generates a notification for a user who was delivered a message they are not
 * actively viewing (Req 27.4). Optional.
 */
export interface MessageNotifier {
  /**
   * Generate a notification for an inactive recipient.
   *
   * @param ctx The tenant context.
   * @param input The recipient and the message that triggered the notification.
   */
  notify(
    ctx: TenantContext,
    input: { userId: string; channelId: string; messageId: string },
  ): Promise<void>;
}

/** A file a user shares into a channel or DM (Req 27.5). */
export interface MessagingUploadedFile {
  /** The file's display name. */
  name: string;
  /** The file's MIME content type. */
  contentType: string;
  /** The file's size in bytes. */
  sizeBytes: number;
}

/**
 * Stores a shared file through the Document_Management_Service and returns the
 * stored reference to attach to the message (Req 27.5). Optional — required only
 * to call {@link MessagingService.shareFile}.
 */
export interface MessagingFileStore {
  /**
   * Store a shared file and return its Document_Management_Service reference.
   *
   * @param ctx The tenant context.
   * @param file The file to store.
   * @returns The stored reference to attach to the message.
   */
  store(ctx: TenantContext, file: MessagingUploadedFile): Promise<{ ref: string }>;
}

/**
 * Invokes the Chat_Service to produce an AI assistant reply for a conversation
 * (Req 27.7). Optional — required only to call {@link MessagingService.aiAssist}.
 */
export interface MessagingChatAssistant {
  /**
   * Produce an AI reply body for a prompt in the context of a channel.
   *
   * @param ctx The tenant context.
   * @param input The requesting channel and the user's prompt.
   * @returns The assistant's reply body to post into the channel.
   */
  assist(ctx: TenantContext, input: { channelId: string; prompt: string }): Promise<string>;
}

/** Construction dependencies for the {@link MessagingService}. */
export interface MessagingServiceOptions {
  /** The channels store (tenant-scoped). */
  channels: ChannelStore;
  /** The channel-messages store (tenant-scoped). */
  messages: ChannelMessageStore;
  /** The append-only audit sink; every mutation and denial is recorded (Req 27.8, 37.1). */
  audit: AuditRecorder;
  /** The ingestion-on-write emitter; every created message is emitted (Req 27.9). */
  ingestion: MessageIngestionEmitter;
  /** Optional real-time delivery over the WebSocket_Gateway (Req 27.2). */
  delivery?: RealtimeDelivery;
  /** Optional active-viewer tracker for inactive-recipient notification (Req 27.4). */
  presence?: PresenceTracker;
  /** Optional notification generator for inactive recipients (Req 27.4). */
  notifier?: MessageNotifier;
  /** Optional Document_Management_Service file store for file sharing (Req 27.5). */
  fileStore?: MessagingFileStore;
  /** Optional Chat_Service bridge for AI assistance (Req 27.7). */
  assistant?: MessagingChatAssistant;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: MessagingIdGenerator;
  /** Optional clock for timestamps (deterministic tests). */
  now?: () => Date;
  /** The author id used for posted AI assistant replies (defaults to `assistant`). */
  assistantUserId?: string;
}

/**
 * The Messaging_Service. Construct once with its ports, then call its methods
 * with the acting user's {@link TenantContext}.
 */
export class MessagingService {
  private readonly channels: ChannelStore;
  private readonly messages: ChannelMessageStore;
  private readonly audit: AuditRecorder;
  private readonly ingestion: MessageIngestionEmitter;
  private readonly delivery: RealtimeDelivery | undefined;
  private readonly presence: PresenceTracker | undefined;
  private readonly notifier: MessageNotifier | undefined;
  private readonly fileStore: MessagingFileStore | undefined;
  private readonly assistant: MessagingChatAssistant | undefined;
  private readonly ids: MessagingIdGenerator;
  private readonly now: () => Date;
  private readonly assistantUserId: string;

  constructor(options: MessagingServiceOptions) {
    this.channels = options.channels;
    this.messages = options.messages;
    this.audit = options.audit;
    this.ingestion = options.ingestion;
    this.delivery = options.delivery;
    this.presence = options.presence;
    this.notifier = options.notifier;
    this.fileStore = options.fileStore;
    this.assistant = options.assistant;
    this.ids = options.idGenerator ?? defaultIdGenerator;
    this.now = options.now ?? ((): Date => new Date());
    this.assistantUserId = options.assistantUserId ?? 'assistant';
  }

  /**
   * Create a channel, persisting its name, owning Team or Project, visibility
   * setting, and membership list (Req 27.1). The acting user is always included
   * in the membership list so the creator can access a private channel they
   * just made. The creation is recorded in the Audit_Service.
   */
  async createChannel(ctx: TenantContext, input: ChannelCreate): Promise<Channel> {
    const id = input.id ?? this.ids.channelId();
    const members = dedupe([...(input.members ?? []), ctx.userId]);
    const channel = await this.channels.create(ctx, {
      id,
      name: input.name,
      ownerScope: input.ownerScope,
      ownerScopeId: input.ownerScopeId,
      visibility: input.visibility ?? 'public',
      members,
    });
    await this.audit.record(ctx, {
      action: 'channel.create',
      resourceType: 'channel',
      resourceId: channel.id,
      metadata: {
        ownerScope: channel.ownerScope,
        ownerScopeId: channel.ownerScopeId,
        visibility: channel.visibility,
      },
    });
    return channel;
  }

  /**
   * List the channels the acting user is authorized to access (Req 27.8): every
   * public channel in the Organization plus the private channels the user is a
   * member of. Reads are not audited.
   */
  async listChannels(ctx: TenantContext, userId: string = ctx.userId): Promise<Channel[]> {
    const channels = await this.channels.list(ctx);
    return channels.filter((channel) => canAccess(channel, userId));
  }

  /**
   * Add a user to a channel's membership list (Req 27.1). The change is recorded
   * in the Audit_Service. Raises {@link ChannelNotFoundError} when no channel
   * matches within the caller's Organization.
   */
  async addMember(ctx: TenantContext, channelId: string, userId: string): Promise<Channel> {
    const channel = await this.requireChannel(ctx, channelId);
    if (channel.members.includes(userId)) {
      return channel;
    }
    const updated = await this.channels.setMembers(ctx, channelId, [...channel.members, userId]);
    if (updated === null) {
      throw new ChannelNotFoundError(channelId);
    }
    await this.audit.record(ctx, {
      action: 'channel.add_member',
      resourceType: 'channel',
      resourceId: channelId,
      metadata: { userId },
    });
    return updated;
  }

  /**
   * Post a message to a channel or direct message (Req 27.2). The message is
   * persisted, delivered in real time to the channel's authorized recipients
   * (Req 27.2), a notification is generated for every recipient not actively
   * viewing the channel (Req 27.4), and the content is emitted for indexing into
   * Unified Search (Req 27.9).
   *
   * Access to a private channel is restricted to its members (Req 27.8): a
   * non-member's attempt is recorded in the Audit_Service and rejected with a
   * {@link ChannelAccessDeniedError}. Raises {@link ChannelNotFoundError} when no
   * channel matches within the caller's Organization.
   */
  async post(ctx: TenantContext, channelId: string, input: MessagePost): Promise<ChannelMessage> {
    const channel = await this.requireChannel(ctx, channelId);
    const authorId = input.authorId ?? ctx.userId;
    await this.assertCanAccess(ctx, channel, authorId, 'channel.post');
    return this.persistAndFanOut(ctx, channel, { ...input, authorId });
  }

  /**
   * Reply to a message in a thread (Req 27.3): the reply is associated with the
   * parent message and the service maintains thread order by creation time. The
   * reply is delivered, notified, and indexed exactly like a top-level message.
   *
   * Raises {@link ChannelMessageNotFoundError} when the parent does not exist in
   * the caller's Organization, and applies the same private-channel access
   * restriction as {@link post} (Req 27.8).
   */
  async reply(
    ctx: TenantContext,
    parentId: string,
    input: MessagePost,
  ): Promise<ChannelMessage> {
    const parent = await this.messages.findById(ctx, parentId);
    if (parent === null) {
      throw new ChannelMessageNotFoundError(parentId);
    }
    const channel = await this.requireChannel(ctx, parent.channelId);
    const authorId = input.authorId ?? ctx.userId;
    await this.assertCanAccess(ctx, channel, authorId, 'channel.reply');
    return this.persistAndFanOut(ctx, channel, { ...input, authorId, parentId });
  }

  /**
   * List a channel's messages in chronological order (Req 27.2, 27.3),
   * restricted to authorized readers (Req 27.8). A non-member's attempt to read
   * a private channel is audited and rejected with a
   * {@link ChannelAccessDeniedError}. Reads are not audited on success.
   */
  async listMessages(
    ctx: TenantContext,
    channelId: string,
    userId: string = ctx.userId,
  ): Promise<ChannelMessage[]> {
    const channel = await this.requireChannel(ctx, channelId);
    await this.assertCanAccess(ctx, channel, userId, 'channel.read');
    return this.messages.listByChannel(ctx, channelId);
  }

  /**
   * List the threaded replies to a parent message in thread order (Req 27.3),
   * restricted to authorized readers of the parent's channel (Req 27.8). Raises
   * {@link ChannelMessageNotFoundError} when the parent does not exist in the
   * caller's Organization.
   */
  async listThread(
    ctx: TenantContext,
    parentId: string,
    userId: string = ctx.userId,
  ): Promise<ChannelMessage[]> {
    const parent = await this.messages.findById(ctx, parentId);
    if (parent === null) {
      throw new ChannelMessageNotFoundError(parentId);
    }
    const channel = await this.requireChannel(ctx, parent.channelId);
    await this.assertCanAccess(ctx, channel, userId, 'channel.read');
    return this.messages.listReplies(ctx, parentId);
  }

  /**
   * Share a file in a channel or direct message (Req 27.5): the file is stored
   * through the Document_Management_Service and the stored reference is attached
   * to a new message. Requires a {@link MessagingFileStore} to be wired. The
   * message is delivered, notified, and indexed like any other post (Req 27.2,
   * 27.4, 27.9) and is subject to the same private-channel access restriction
   * (Req 27.8).
   */
  async shareFile(
    ctx: TenantContext,
    channelId: string,
    file: MessagingUploadedFile,
    input: Omit<MessagePost, 'fileRef'> = { body: '' },
  ): Promise<ChannelMessage> {
    if (this.fileStore === undefined) {
      throw new Error('Messaging_Service: no file store wired for shareFile (Req 27.5)');
    }
    const channel = await this.requireChannel(ctx, channelId);
    const authorId = input.authorId ?? ctx.userId;
    await this.assertCanAccess(ctx, channel, authorId, 'channel.share_file');
    const stored = await this.fileStore.store(ctx, file);
    return this.persistAndFanOut(ctx, channel, { ...input, authorId, fileRef: stored.ref });
  }

  /**
   * Search the messages the user is authorized to access, ranked by relevance
   * (Req 27.6). The candidate set is restricted to channels the user can access
   * (Req 27.8): public channels plus the private channels they are a member of.
   * Reads are not audited.
   */
  async search(
    ctx: TenantContext,
    query: string,
    userId: string = ctx.userId,
  ): Promise<MessageSearchHit[]> {
    const accessible = (await this.channels.list(ctx)).filter((channel) =>
      canAccess(channel, userId),
    );
    const candidates: ChannelMessage[] = [];
    for (const channel of accessible) {
      const messages = await this.messages.listByChannel(ctx, channel.id);
      candidates.push(...messages);
    }
    return searchMessages(candidates, query);
  }

  /**
   * Request AI assistance in a conversation (Req 27.7): invoke the Chat_Service
   * through the {@link MessagingChatAssistant} port and post the AI response in
   * the requesting channel. The posted response is delivered, notified, and
   * indexed like any other message (Req 27.2, 27.4, 27.9). Requires a
   * {@link MessagingChatAssistant} to be wired. The requesting user must be able
   * to access the channel (Req 27.8).
   */
  async aiAssist(
    ctx: TenantContext,
    channelId: string,
    prompt: string,
  ): Promise<ChannelMessage> {
    if (this.assistant === undefined) {
      throw new Error('Messaging_Service: no chat assistant wired for aiAssist (Req 27.7)');
    }
    const channel = await this.requireChannel(ctx, channelId);
    await this.assertCanAccess(ctx, channel, ctx.userId, 'channel.ai_assist');
    const body = await this.assistant.assist(ctx, { channelId, prompt });
    return this.persistAndFanOut(ctx, channel, { body, authorId: this.assistantUserId });
  }

  /**
   * Persist a message, then fan out: deliver in real time (Req 27.2), notify
   * inactive recipients (Req 27.4), and emit the content for indexing (Req 27.9).
   * Shared by {@link post}, {@link reply}, {@link shareFile}, and {@link aiAssist}.
   */
  private async persistAndFanOut(
    ctx: TenantContext,
    channel: Channel,
    input: MessagePost & { parentId?: string },
  ): Promise<ChannelMessage> {
    const id = input.id ?? this.ids.messageId();
    const message = await this.messages.create(ctx, {
      id,
      channelId: channel.id,
      authorId: input.authorId ?? ctx.userId,
      body: input.body,
      createdAt: this.now().toISOString(),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.fileRef !== undefined ? { fileRef: input.fileRef } : {}),
    });

    const recipients = channel.members.filter((memberId) => memberId !== message.authorId);

    // Real-time delivery to authorized recipients over the WebSocket_Gateway (Req 27.2).
    if (this.delivery !== undefined) {
      await this.delivery.deliver(ctx, message, recipients);
    }

    // Notify recipients who are not actively viewing the channel (Req 27.4).
    if (this.notifier !== undefined) {
      for (const userId of recipients) {
        const viewing = this.presence?.isViewing(userId, channel.id) ?? false;
        if (!viewing) {
          await this.notifier.notify(ctx, {
            userId,
            channelId: channel.id,
            messageId: message.id,
          });
        }
      }
    }

    // Ingestion-on-write so the authorized content is retrievable via Unified Search (Req 27.9).
    await this.ingestion.emit(ctx, {
      messageId: message.id,
      channelId: message.channelId,
      authorId: message.authorId,
      body: message.body,
      createdAt: message.createdAt,
    });

    return message;
  }

  /** Load a channel or raise {@link ChannelNotFoundError}. */
  private async requireChannel(ctx: TenantContext, channelId: string): Promise<Channel> {
    const channel = await this.channels.findById(ctx, channelId);
    if (channel === null) {
      throw new ChannelNotFoundError(channelId);
    }
    return channel;
  }

  /**
   * Enforce the private-channel access restriction (Req 27.8): a non-member's
   * attempt is recorded in the Audit_Service and rejected with a
   * {@link ChannelAccessDeniedError}. Public channels are accessible org-wide.
   */
  private async assertCanAccess(
    ctx: TenantContext,
    channel: Channel,
    userId: string,
    action: string,
  ): Promise<void> {
    if (canAccess(channel, userId)) {
      return;
    }
    await this.audit.record(ctx, {
      action: `${action}.denied`,
      resourceType: 'channel',
      resourceId: channel.id,
      actorId: userId,
      metadata: { reason: 'not_a_member', visibility: channel.visibility },
    });
    throw new ChannelAccessDeniedError(channel.id, userId);
  }
}

/**
 * Whether `userId` may access `channel` (Req 27.8): a public channel is
 * accessible to anyone in the Organization; a private channel only to its
 * members.
 */
export function canAccess(channel: Channel, userId: string): boolean {
  return channel.visibility === 'public' || channel.members.includes(userId);
}

/** Return a copy of `values` with duplicates removed, preserving first-seen order. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
