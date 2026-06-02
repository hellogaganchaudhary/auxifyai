/**
 * Tenant-scoped repository for {@link Artifact}/{@link ArtifactVersion} over the
 * `artifacts` and `artifact_versions` tables (migration 0004).
 *
 * Like `messages`, artifacts carry no `organization_id` column — they are
 * tenant scoped *through their parent conversation*. This repository therefore
 * extends {@link TenantScopedRepository} with a {@link ParentTenantScope}: every
 * read/update/delete is constrained by
 * `conversation_id IN (SELECT id FROM conversations WHERE organization_id = $n)`,
 * and every insert is guarded by an `EXISTS` check so an artifact can never be
 * attached to another tenant's conversation (Req 1.2, 1.4).
 *
 * `artifact_versions` are one level deeper — scoped through their parent
 * artifact, which is in turn scoped through its conversation. Rather than open
 * a second base scope, the version reads/writes here are *gated* by first
 * resolving the parent artifact through the tenant-scoped artifact query: a
 * version is only ever read or written for an artifact the caller's tenant can
 * see. This keeps the cross-tenant guarantee intact while supporting the
 * two-level hierarchy.
 *
 * The repository owns the **version-on-every-write** invariant (Req 12.4):
 *   - {@link create} inserts the artifact head (version 1) and its version-1
 *     history row;
 *   - {@link updateContent} appends the next version row and advances the head.
 * Prior version rows are never updated or deleted, so the full history is
 * always retrievable (Property 25, task 9.6).
 */

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlRow } from '../storage/pgvector.js';
import { TenantScopedRepository } from '../repositories/base-repository.js';
import type { ColumnValue } from '../repositories/sql.js';
import { isArtifactType, type Artifact, type ArtifactType, type ArtifactVersion } from './types.js';

/** Parse a Postgres `text[]` value (driver may hand back a JS array already). */
function parseTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    // A pg text[] literal looks like `{a,b}`; an empty array is `{}`.
    const trimmed = value.trim();
    if (trimmed === '{}' || trimmed === '') return [];
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.replace(/^"|"$/g, ''))
        .filter((entry) => entry.length > 0);
    }
  }
  return [];
}

/**
 * Repository over `artifacts` (+ `artifact_versions`), tenant-scoped through the
 * parent `conversations` table's `organization_id`.
 */
export class ArtifactRepository extends TenantScopedRepository {
  private readonly versionsTable: string;

  constructor(
    sql: SqlClient,
    table = 'artifacts',
    parentTable = 'conversations',
    versionsTable = 'artifact_versions',
  ) {
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
    this.versionsTable = versionsTable;
  }

  /** Map an `artifacts` row to the domain {@link Artifact}. */
  private toArtifact(row: SqlRow): Artifact {
    const type = String(row.type);
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      type: (isArtifactType(type) ? type : 'markdown') as ArtifactType,
      content: String(row.content ?? ''),
      version: Number(row.version ?? 1),
      sharedWith: parseTextArray(row.shared_with),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** Map an `artifact_versions` row to the domain {@link ArtifactVersion}. */
  private toVersion(row: SqlRow): ArtifactVersion {
    return {
      id: String(row.id),
      artifactId: String(row.artifact_id),
      version: Number(row.version),
      content: String(row.content ?? ''),
      createdAt: String(row.created_at),
    };
  }

  /**
   * Create an artifact head at version 1 under a conversation owned by the
   * caller's Organization, and append its version-1 history row (Req 12.4).
   * Throws {@link import('../repositories/index.js').CrossTenantReferenceError}
   * if the conversation is not in the caller's tenant.
   */
  async create(
    ctx: TenantContext,
    input: {
      id: string;
      versionId: string;
      conversationId: string;
      type: ArtifactType;
      content: string;
    },
  ): Promise<Artifact> {
    const columns: ColumnValue[] = [
      { column: 'id', value: input.id },
      { column: 'conversation_id', value: input.conversationId },
      { column: 'type', value: input.type },
      { column: 'content', value: input.content },
      { column: 'version', value: 1 },
    ];
    // The parent EXISTS guard in insertRow enforces tenant ownership.
    const row = await this.insertRow(ctx, columns);
    const artifact = this.toArtifact(row);
    // Append the immutable version-1 history row (Req 12.4).
    await this.insertVersionRow(input.versionId, artifact.id, 1, artifact.content);
    return artifact;
  }

  /** Fetch an artifact by id within the caller's Organization, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<Artifact | null> {
    const row = await this.selectById(ctx, id);
    return row === null ? null : this.toArtifact(row);
  }

  /** List a conversation's artifacts within the caller's Organization (newest first). */
  async listByConversation(ctx: TenantContext, conversationId: string): Promise<Artifact[]> {
    const rows = await this.selectRows(ctx, {
      where: [{ column: 'conversation_id', value: conversationId }],
      orderBy: 'created_at',
      direction: 'DESC',
    });
    return rows.map((row) => this.toArtifact(row));
  }

  /**
   * Replace an artifact's content: append the next version-history row and
   * advance the head version (Req 12.4). Returns the updated artifact, or
   * `null` if no artifact matched within the caller's Organization. The append
   * happens first so a retained version always exists for the new content.
   */
  async updateContent(
    ctx: TenantContext,
    id: string,
    input: { versionId: string; content: string },
  ): Promise<Artifact | null> {
    const current = await this.findById(ctx, id);
    if (current === null) return null;
    const nextVersion = current.version + 1;
    // Retain the new content as an immutable version row *before* advancing the
    // head, so history can never lag behind the content (Req 12.4).
    await this.insertVersionRow(input.versionId, id, nextVersion, input.content);
    const row = await this.updateById(ctx, id, [
      { column: 'content', value: input.content },
      { column: 'version', value: nextVersion },
      { column: 'updated_at', value: new Date().toISOString() },
    ]);
    return row === null ? null : this.toArtifact(row);
  }

  /** Replace an artifact's shared-with member list (Req 12.6). */
  async updateSharedWith(
    ctx: TenantContext,
    id: string,
    members: string[],
  ): Promise<Artifact | null> {
    const row = await this.updateById(ctx, id, [
      { column: 'shared_with', value: members },
      { column: 'updated_at', value: new Date().toISOString() },
    ]);
    return row === null ? null : this.toArtifact(row);
  }

  /**
   * List every retained version of an artifact, oldest first (Req 12.4). The
   * parent artifact is resolved through the tenant-scoped query first, so a
   * version is only returned for an artifact the caller's tenant can see.
   */
  async listVersions(ctx: TenantContext, id: string): Promise<ArtifactVersion[]> {
    const artifact = await this.findById(ctx, id);
    if (artifact === null) return [];
    const result = await this.sql.query(
      `SELECT * FROM ${this.versionsTable} WHERE artifact_id = $1 ORDER BY version ASC`,
      [id],
    );
    return result.rows.map((row) => this.toVersion(row));
  }

  /** Fetch a single retained version of an artifact within the tenant, or `null`. */
  async getVersion(
    ctx: TenantContext,
    id: string,
    version: number,
  ): Promise<ArtifactVersion | null> {
    const artifact = await this.findById(ctx, id);
    if (artifact === null) return null;
    const result = await this.sql.query(
      `SELECT * FROM ${this.versionsTable} WHERE artifact_id = $1 AND version = $2 LIMIT 1`,
      [id, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.toVersion(row);
  }

  /** Insert an immutable `artifact_versions` row. */
  private async insertVersionRow(
    id: string,
    artifactId: string,
    version: number,
    content: string,
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO ${this.versionsTable} (id, artifact_id, version, content) VALUES ($1, $2, $3, $4)`,
      [id, artifactId, version, content],
    );
  }
}
