/**
 * Tenant-scoped repositories for the Prompt_Library over `prompt_templates` and
 * `prompt_versions` (migration 0004).
 *
 * Both tables carry `organization_id` (the versions table inherits the tenant
 * through its template, but also stores it for a direct scope), so each
 * repository extends {@link TenantScopedRepository} with the default
 * {@link DirectTenantScope}: every read/update/delete is constrained by
 * `organization_id = $n` and every insert forces the caller's Organization onto
 * the row (Req 1.2).
 *
 * {@link PromptTemplateRepository.listVisibleTo} is the one query that the
 * AND-only base `where` cannot express: a user sees every **public** template
 * in their Organization plus their **own personal** templates (Req 10.2, 10.3 /
 * Property 26). It is assembled here as a parameterized statement with the
 * Organization predicate FIRST, then the `(visibility = 'public' OR owner_id =
 * $user)` disjunction — so tenant scoping is never weakened by the OR.
 */

import type { TenantContext } from '@auxify/types';

import { assertTenantContext } from '../repositories/errors.js';
import { TenantScopedRepository } from '../repositories/base-repository.js';
import { ParamCollector } from '../repositories/sql.js';
import type { SqlClient, SqlRow } from '../storage/pgvector.js';
import type {
  AppendPromptVersionRow,
  CreatePromptTemplateRow,
  PromptTemplate,
  PromptVersion,
  PromptVisibility,
  UpdatePromptTemplateRow,
} from './types.js';

/** Coerce a Postgres TEXT[] column into a string array (drivers vary). */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) return (JSON.parse(trimmed) as unknown[]).map((v) => String(v));
  }
  return [];
}

/** Map a `prompt_templates` row to the domain {@link PromptTemplate}. */
function toTemplate(row: SqlRow): PromptTemplate {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    organizationId: String(row.organization_id),
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    category: String(row.category ?? ''),
    tags: toStringArray(row.tags),
    visibility: String(row.visibility ?? 'personal') as PromptVisibility,
    version: Number(row.version ?? 1),
    usageCount: Number(row.usage_count ?? 0),
    ratingAvg: Number(row.rating_avg ?? 0),
    shareCount: Number(row.share_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Map a `prompt_versions` row to the domain {@link PromptVersion}. */
function toVersion(row: SqlRow): PromptVersion {
  return {
    id: String(row.id),
    templateId: String(row.template_id),
    version: Number(row.version ?? 1),
    content: String(row.content ?? ''),
    createdAt: String(row.created_at),
  };
}

/** Repository over `prompt_templates`, always scoped to the caller's Organization. */
export class PromptTemplateRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'prompt_templates') {
    super(sql, { table, scope: { kind: 'direct', column: 'organization_id' } });
  }

  /** Create a template in the caller's Organization (Req 10.1). */
  async create(ctx: TenantContext, input: CreatePromptTemplateRow): Promise<PromptTemplate> {
    const row = await this.insertRow(ctx, [
      { column: 'id', value: input.id },
      { column: 'owner_id', value: input.ownerId },
      { column: 'title', value: input.title },
      { column: 'content', value: input.content },
      { column: 'category', value: input.category },
      { column: 'tags', value: input.tags },
      { column: 'visibility', value: input.visibility },
    ]);
    return toTemplate(row);
  }

  /** Fetch a template by id within the caller's Organization, or `null`. */
  async findById(ctx: TenantContext, id: string): Promise<PromptTemplate | null> {
    const row = await this.selectById(ctx, id);
    return row === null ? null : toTemplate(row);
  }

  /** List every template in the caller's Organization (used by analytics, Req 10.7). */
  async listAll(ctx: TenantContext): Promise<PromptTemplate[]> {
    const rows = await this.selectRows(ctx, { orderBy: 'created_at', direction: 'DESC' });
    return rows.map(toTemplate);
  }

  /**
   * List the templates visible to `userId` (Req 10.2, 10.3 / Property 26): every
   * public template in the Organization plus the user's own personal templates.
   *
   * The Organization predicate is bound FIRST so the disjunction can never reach
   * across tenants; within the tenant a row is visible iff it is public or owned
   * by the user.
   */
  async listVisibleTo(ctx: TenantContext, userId: string): Promise<PromptTemplate[]> {
    assertTenantContext(ctx);
    const params = new ParamCollector();
    const orgPlaceholder = params.add(ctx.organizationId);
    const ownerPlaceholder = params.add(userId);
    const text =
      `SELECT * FROM ${this.table} ` +
      `WHERE organization_id = ${orgPlaceholder} ` +
      `AND (visibility = 'public' OR owner_id = ${ownerPlaceholder}) ` +
      `ORDER BY created_at DESC`;
    const result = await this.sql.query(text, params.params);
    return result.rows.map(toTemplate);
  }

  /** Update mutable template columns within the caller's Organization. */
  async update(
    ctx: TenantContext,
    id: string,
    patch: UpdatePromptTemplateRow,
  ): Promise<PromptTemplate | null> {
    const set: { column: string; value: unknown }[] = [];
    if (patch.title !== undefined) set.push({ column: 'title', value: patch.title });
    if (patch.content !== undefined) set.push({ column: 'content', value: patch.content });
    if (patch.category !== undefined) set.push({ column: 'category', value: patch.category });
    if (patch.tags !== undefined) set.push({ column: 'tags', value: patch.tags });
    if (patch.visibility !== undefined) set.push({ column: 'visibility', value: patch.visibility });
    if (patch.version !== undefined) set.push({ column: 'version', value: patch.version });
    if (patch.usageCount !== undefined) {
      set.push({ column: 'usage_count', value: patch.usageCount });
    }
    if (patch.ratingAvg !== undefined) set.push({ column: 'rating_avg', value: patch.ratingAvg });
    if (patch.shareCount !== undefined) {
      set.push({ column: 'share_count', value: patch.shareCount });
    }
    // Bump the update timestamp so listings reflect the mutation.
    set.push({ column: 'updated_at', value: new Date().toISOString() });

    const row = await this.updateById(ctx, id, set);
    return row === null ? null : toTemplate(row);
  }
}

/**
 * Repository over `prompt_versions`, scoped to the caller's Organization
 * *through its parent template*.
 *
 * The `prompt_versions` table (migration 0004) has no `organization_id` column —
 * it carries the tenant via its `template_id` foreign key into
 * `prompt_templates`. A {@link ParentTenantScope} therefore guards every insert
 * with an `EXISTS` check against the parent's Organization and scopes every read
 * with `template_id IN (SELECT id FROM prompt_templates WHERE organization_id =
 * $n)`, so a version can never attach to — or be read across — another tenant.
 */
export class PromptVersionRepository extends TenantScopedRepository {
  constructor(sql: SqlClient, table = 'prompt_versions') {
    super(sql, {
      table,
      scope: { kind: 'parent', foreignKey: 'template_id', parentTable: 'prompt_templates' },
    });
  }

  /** Append an immutable version snapshot of a template's content (Req 10.5). */
  async append(ctx: TenantContext, input: AppendPromptVersionRow): Promise<PromptVersion> {
    const row = await this.insertRow(ctx, [
      { column: 'id', value: input.id },
      { column: 'template_id', value: input.templateId },
      { column: 'version', value: input.version },
      { column: 'content', value: input.content },
    ]);
    return toVersion(row);
  }

  /** List a template's versions in ascending version order (Req 10.5 / Property 25). */
  async listByTemplate(ctx: TenantContext, templateId: string): Promise<PromptVersion[]> {
    const rows = await this.selectRows(ctx, {
      where: [{ column: 'template_id', value: templateId }],
      orderBy: 'version',
      direction: 'ASC',
    });
    return rows.map(toVersion);
  }
}
