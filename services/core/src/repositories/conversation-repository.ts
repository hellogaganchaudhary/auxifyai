/**
 * Tenant-scoped repository for {@link ConversationRecord} over the
 * `conversations` table (migration 0003).
 *
 * Conversations carry `organization_id` directly, so this repository uses the
 * default {@link DirectTenantScope}: every read/update/delete is constrained by
 * `organization_id = $n` and every insert forces the caller's Organization onto
 * the row (Req 1.2). It also demonstrates the row↔domain mapping pattern later
 * repositories follow.
 */

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlRow } from '../storage/pgvector.js';
import { TenantScopedRepository, type ListOptions } from './base-repository.js';
import type { ColumnValue } from './sql.js';

/** A conversation's sharing mode (mirrors the `share_mode` CHECK constraint). */
export type ConversationShareMode = 'read' | 'collab';

/**
 * A persisted conversation (mirrors the `conversations` columns). `organizationId`
 * is owned by the repository: callers never set it on create — it is derived
 * from the {@link TenantContext}.
 */
export interface ConversationRecord {
  id: string;
  organizationId: string;
  projectId: string;
  ownerId: string;
  title: string;
  folderId: string | null;
  archived: boolean;
  shareToken: string | null;
  shareMode: ConversationShareMode | null;
  personaId: string | null;
  activeModelId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The fields a caller supplies to create a conversation (tenant is implicit). */
export interface CreateConversationInput {
  id: string;
  projectId: string;
  ownerId: string;
  title?: string;
  folderId?: string | null;
  archived?: boolean;
  shareToken?: string | null;
  shareMode?: ConversationShareMode | null;
  personaId?: string | null;
  activeModelId?: string | null;
}

/** Mutable conversation fields (Req 5.1–5.7). */
export interface UpdateConversationInput {
  title?: string;
  folderId?: string | null;
  archived?: boolean;
  shareToken?: string | null;
  shareMode?: ConversationShareMode | null;
  personaId?: string | null;
  activeModelId?: string | null;
}

function asStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Repository over `conversations`, always scoped to the caller's Organization. */
export class ConversationRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'conversations') {
    super(sql, { table, scope: { kind: 'direct', column: 'organization_id' } });
  }

  /** Map a DB row to the domain record. */
  private toRecord(row: SqlRow): ConversationRecord {
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      projectId: String(row.project_id),
      ownerId: String(row.owner_id),
      title: String(row.title ?? ''),
      folderId: asStringOrNull(row.folder_id),
      archived: Boolean(row.archived),
      shareToken: asStringOrNull(row.share_token),
      shareMode: asStringOrNull(row.share_mode) as ConversationShareMode | null,
      personaId: asStringOrNull(row.persona_id),
      activeModelId: asStringOrNull(row.active_model_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** Create a conversation in the caller's Organization (Req 5.1). */
  async create(ctx: TenantContext, input: CreateConversationInput): Promise<ConversationRecord> {
    const columns: ColumnValue[] = [
      { column: 'id', value: input.id },
      { column: 'project_id', value: input.projectId },
      { column: 'owner_id', value: input.ownerId },
      { column: 'title', value: input.title ?? '' },
      { column: 'folder_id', value: input.folderId ?? null },
      { column: 'archived', value: input.archived ?? false },
      { column: 'share_token', value: input.shareToken ?? null },
      { column: 'share_mode', value: input.shareMode ?? null },
      { column: 'persona_id', value: input.personaId ?? null },
      { column: 'active_model_id', value: input.activeModelId ?? null },
    ];
    const row = await this.insertRow(ctx, columns);
    return this.toRecord(row);
  }

  /** Fetch a conversation by id within the caller's Organization, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<ConversationRecord | null> {
    const row = await this.selectById(ctx, id);
    return row === null ? null : this.toRecord(row);
  }

  /**
   * List an owner's conversations, most-recently-updated first (Req 5.2 /
   * Property 17), within the caller's Organization.
   */
  async listByOwner(
    ctx: TenantContext,
    ownerId: string,
    options: Pick<ListOptions, 'limit' | 'offset'> = {},
  ): Promise<ConversationRecord[]> {
    const rows = await this.selectRows(ctx, {
      where: [{ column: 'owner_id', value: ownerId }],
      orderBy: 'updated_at',
      direction: 'DESC',
      limit: options.limit,
      offset: options.offset,
    });
    return rows.map((row) => this.toRecord(row));
  }

  /** List all conversations in the caller's Organization (most recent first). */
  async list(
    ctx: TenantContext,
    options: Pick<ListOptions, 'limit' | 'offset'> = {},
  ): Promise<ConversationRecord[]> {
    const rows = await this.selectRows(ctx, {
      orderBy: 'updated_at',
      direction: 'DESC',
      limit: options.limit,
      offset: options.offset,
    });
    return rows.map((row) => this.toRecord(row));
  }

  /** Update a conversation by id within the caller's Organization. */
  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateConversationInput,
  ): Promise<ConversationRecord | null> {
    const set: ColumnValue[] = [];
    if (input.title !== undefined) set.push({ column: 'title', value: input.title });
    if (input.folderId !== undefined) set.push({ column: 'folder_id', value: input.folderId });
    if (input.archived !== undefined) set.push({ column: 'archived', value: input.archived });
    if (input.shareToken !== undefined)
      set.push({ column: 'share_token', value: input.shareToken });
    if (input.shareMode !== undefined) set.push({ column: 'share_mode', value: input.shareMode });
    if (input.personaId !== undefined) set.push({ column: 'persona_id', value: input.personaId });
    if (input.activeModelId !== undefined) {
      set.push({ column: 'active_model_id', value: input.activeModelId });
    }
    // Bump the update timestamp so list ordering reflects the mutation (Req 5.2).
    set.push({ column: 'updated_at', value: new Date().toISOString() });

    const row = await this.updateById(ctx, id, set);
    return row === null ? null : this.toRecord(row);
  }

  /** Delete a conversation by id within the caller's Organization. */
  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    return this.deleteById(ctx, id);
  }
}
