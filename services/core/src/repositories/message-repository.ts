/**
 * Tenant-scoped repository for {@link MessageRecord} over the `messages` table
 * (migration 0003).
 *
 * Unlike conversations, messages have no `organization_id` column — they are
 * tenant-scoped *through their parent conversation*. This repository therefore
 * uses a {@link ParentTenantScope}: every read/update/delete is constrained by
 * `conversation_id IN (SELECT id FROM conversations WHERE organization_id = $n)`,
 * and every insert is guarded by an `EXISTS` check so a message can never be
 * attached to another tenant's conversation (a {@link CrossTenantReferenceError}
 * is raised otherwise). This is the canonical pattern for child tables, proving
 * the base supports parent-derived tenancy in addition to a direct column
 * (Req 1.2, 44.1, 44.6).
 */

import type { ContentBlock, TenantContext } from '@auxify/types';

import type { SqlClient, SqlRow } from '../storage/pgvector.js';
import { TenantScopedRepository, type ListOptions } from './base-repository.js';
import type { ColumnValue } from './sql.js';

/** Roles permitted by the `messages.role` CHECK constraint. */
export type MessageRole = 'user' | 'assistant' | 'system';

/** Values permitted by the `messages.rating` CHECK constraint. */
export type MessageRating = 'up' | 'neutral' | 'down';

/**
 * A persisted message carrying the full request outcome (Req 44.6). Nullable
 * columns are modelled as `T | null` (explicit SQL NULL).
 */
export interface MessageRecord {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: MessageRole;
  content: ContentBlock[];
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  latencyMs: number | null;
  rating: MessageRating | null;
  pinned: boolean;
  attachments: unknown[];
  createdAt: string;
}

/** Fields a caller supplies to create a message (tenant is implicit via parent). */
export interface CreateMessageInput {
  id: string;
  conversationId: string;
  parentId?: string | null;
  role: MessageRole;
  content?: ContentBlock[];
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cost?: number | null;
  latencyMs?: number | null;
  rating?: MessageRating | null;
  pinned?: boolean;
  attachments?: unknown[];
}

/** Mutable message fields (rating, pinning — Req 6.5, 6.6). */
export interface UpdateMessageInput {
  rating?: MessageRating | null;
  pinned?: boolean;
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Repository over `messages`, tenant-scoped through the parent `conversations`
 * table's `organization_id`.
 */
export class MessageRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'messages', parentTable = 'conversations') {
    super(sql, {
      table,
      scope: {
        kind: 'parent',
        foreignKey: 'conversation_id',
        parentTable,
        parentIdColumn: 'id',
        parentTenantColumn: 'organization_id',
      },
    });
  }

  /** Map a DB row to the domain record, crossing the JSONB parse boundary. */
  private toRecord(row: SqlRow): MessageRecord {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      parentId: stringOrNull(row.parent_id),
      role: String(row.role) as MessageRole,
      content: parseJsonColumn<ContentBlock[]>(row.content, []),
      model: stringOrNull(row.model),
      inputTokens: numberOrNull(row.input_tokens),
      outputTokens: numberOrNull(row.output_tokens),
      cost: numberOrNull(row.cost),
      latencyMs: numberOrNull(row.latency_ms),
      rating: stringOrNull(row.rating) as MessageRating | null,
      pinned: Boolean(row.pinned),
      attachments: parseJsonColumn<unknown[]>(row.attachments, []),
      createdAt: String(row.created_at),
    };
  }

  /**
   * Persist a message under a conversation owned by the caller's Organization
   * (Req 44.6). Throws {@link CrossTenantReferenceError} if the conversation is
   * not in the caller's tenant.
   */
  async create(ctx: TenantContext, input: CreateMessageInput): Promise<MessageRecord> {
    const columns: ColumnValue[] = [
      { column: 'id', value: input.id },
      { column: 'conversation_id', value: input.conversationId },
      { column: 'parent_id', value: input.parentId ?? null },
      { column: 'role', value: input.role },
      { column: 'content', value: JSON.stringify(input.content ?? []) },
      { column: 'model', value: input.model ?? null },
      { column: 'input_tokens', value: input.inputTokens ?? null },
      { column: 'output_tokens', value: input.outputTokens ?? null },
      { column: 'cost', value: input.cost ?? null },
      { column: 'latency_ms', value: input.latencyMs ?? null },
      { column: 'rating', value: input.rating ?? null },
      { column: 'pinned', value: input.pinned ?? false },
      { column: 'attachments', value: JSON.stringify(input.attachments ?? []) },
    ];
    const row = await this.insertRow(ctx, columns);
    return this.toRecord(row);
  }

  /** Fetch a message by id within the caller's Organization, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<MessageRecord | null> {
    const row = await this.selectById(ctx, id);
    return row === null ? null : this.toRecord(row);
  }

  /**
   * List a conversation's messages in chronological order, scoped to the
   * caller's Organization (a foreign conversation yields no rows).
   */
  async listByConversation(
    ctx: TenantContext,
    conversationId: string,
    options: Pick<ListOptions, 'limit' | 'offset'> = {},
  ): Promise<MessageRecord[]> {
    const rows = await this.selectRows(ctx, {
      where: [{ column: 'conversation_id', value: conversationId }],
      orderBy: 'created_at',
      direction: 'ASC',
      limit: options.limit,
      offset: options.offset,
    });
    return rows.map((row) => this.toRecord(row));
  }

  /** Update a message's rating/pinned state within the caller's Organization. */
  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateMessageInput,
  ): Promise<MessageRecord | null> {
    const set: ColumnValue[] = [];
    if (input.rating !== undefined) set.push({ column: 'rating', value: input.rating });
    if (input.pinned !== undefined) set.push({ column: 'pinned', value: input.pinned });
    const row = await this.updateById(ctx, id, set);
    return row === null ? null : this.toRecord(row);
  }

  /** Delete a message by id within the caller's Organization. */
  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    return this.deleteById(ctx, id);
  }
}
