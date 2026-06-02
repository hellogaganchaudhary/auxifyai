/**
 * Prompt_Library domain types (Req 10).
 *
 * These are the camelCase domain shapes the Prompt_Library returns to its
 * callers, distinct from the snake_case persistence rows handled by the
 * repository layer. {@link PromptTemplate} mirrors the design's "Personas,
 * Prompts, Artifacts" model; {@link PromptVersion} is the immutable per-edit
 * history row retained for Property 25 (Req 10.5).
 *
 * The service composes the {@link PromptTemplateStore} and
 * {@link PromptVersionStore} ports (structurally satisfied by the repositories
 * in `./prompt-repository`) plus the {@link AuditRecorder} port, so it stays
 * unit-testable behind narrow seams.
 */

import type { TenantContext } from '@auxify/types';

/** A prompt template's visibility (Req 10.2, 10.3). */
export type PromptVisibility = 'public' | 'personal';

/** All {@link PromptVisibility} values, for validation and test generators. */
export const PROMPT_VISIBILITIES: readonly PromptVisibility[] = ['public', 'personal'] as const;

/**
 * A prompt template in its domain shape (Req 10.1-10.7).
 *
 * Mirrors the design's `PromptTemplate` interface. `version` advances on every
 * edit (Req 10.5), `usageCount` on every use (Req 10.6); `ratingAvg` and
 * `shareCount` feed the analytics report (Req 10.7).
 */
export interface PromptTemplate {
  id: string;
  ownerId: string;
  organizationId: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  visibility: PromptVisibility;
  version: number;
  usageCount: number;
  ratingAvg: number;
  shareCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A single immutable prior-content snapshot of a template (Req 10.5). */
export interface PromptVersion {
  id: string;
  templateId: string;
  version: number;
  content: string;
  createdAt: string;
}

/** Fields a caller supplies to create a prompt template (Req 10.1). */
export interface PromptTemplateInput {
  /** The template title (Req 10.1). */
  title: string;
  /** The template body, which may contain `{{ variable }}` placeholders (Req 10.4). */
  content: string;
  /** The category the template is filed under (Req 10.1). Defaults to empty. */
  category?: string;
  /** Free-form tags (Req 10.1). Defaults to none. */
  tags?: string[];
  /** Initial visibility (Req 10.2, 10.3). Defaults to `personal` (Req 10.3). */
  visibility?: PromptVisibility;
  /** Optional explicit id; one is generated when omitted. */
  id?: string;
}

/** The Organization scope an analytics report is computed over (Req 10.7). */
export interface OrgScope {
  /** The Organization whose templates the report covers. */
  organizationId: string;
  /** Maximum entries per ranked list. Defaults to {@link DEFAULT_ANALYTICS_LIMIT}. */
  limit?: number;
}

/** A single ranked entry in a {@link PromptAnalytics} list. */
export interface PromptAnalyticsEntry {
  /** The template's id. */
  templateId: string;
  /** The template's title, for display. */
  title: string;
  /** The metric the entry is ranked by (usage count, rating average, or share count). */
  metric: number;
}

/**
 * The prompt analytics report (Req 10.7): the most-used, highest-rated, and
 * most-shared templates within an Organization, each ranked descending.
 */
export interface PromptAnalytics {
  mostUsed: PromptAnalyticsEntry[];
  highestRated: PromptAnalyticsEntry[];
  mostShared: PromptAnalyticsEntry[];
}

/** Default maximum number of entries returned per analytics ranked list. */
export const DEFAULT_ANALYTICS_LIMIT = 10 as const;

/**
 * The persistence port the Prompt_Library needs over `prompt_templates`.
 *
 * `PromptTemplateRepository` satisfies this structurally; tests substitute an
 * in-memory fake. Every method is tenant-scoped by its {@link TenantContext}.
 */
export interface PromptTemplateStore {
  create(ctx: TenantContext, input: CreatePromptTemplateRow): Promise<PromptTemplate>;
  findById(ctx: TenantContext, id: string): Promise<PromptTemplate | null>;
  /** All templates in the caller's Organization (used by analytics, Req 10.7). */
  listAll(ctx: TenantContext): Promise<PromptTemplate[]>;
  /**
   * Templates visible to `userId`: every public template in the Organization
   * plus the user's own personal templates (Req 10.2, 10.3 / Property 26).
   */
  listVisibleTo(ctx: TenantContext, userId: string): Promise<PromptTemplate[]>;
  update(
    ctx: TenantContext,
    id: string,
    patch: UpdatePromptTemplateRow,
  ): Promise<PromptTemplate | null>;
}

/** The persistence port the Prompt_Library needs over `prompt_versions`. */
export interface PromptVersionStore {
  /** Append an immutable version snapshot (Req 10.5). */
  append(ctx: TenantContext, input: AppendPromptVersionRow): Promise<PromptVersion>;
  /** List a template's versions in ascending version order (Req 10.5). */
  listByTemplate(ctx: TenantContext, templateId: string): Promise<PromptVersion[]>;
}

/** Row a caller supplies to create a template (tenant + owner are explicit columns). */
export interface CreatePromptTemplateRow {
  id: string;
  ownerId: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  visibility: PromptVisibility;
}

/** Mutable template columns (content/version/visibility/usage/rating/share). */
export interface UpdatePromptTemplateRow {
  title?: string;
  content?: string;
  category?: string;
  tags?: string[];
  visibility?: PromptVisibility;
  version?: number;
  usageCount?: number;
  ratingAvg?: number;
  shareCount?: number;
}

/** Row a caller supplies to append a version snapshot. */
export interface AppendPromptVersionRow {
  id: string;
  templateId: string;
  version: number;
  content: string;
}
