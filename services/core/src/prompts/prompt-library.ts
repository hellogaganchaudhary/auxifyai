/**
 * The Prompt_Library (Req 10).
 *
 * A library of shared and personal prompt templates: create, visibility
 * (public org-wide / personal owner-only), `{{ variable }}` filling, versioned
 * edits with retained history, usage counting, and the analytics report. It
 * composes three injected ports so it is unit-testable without a database:
 *
 *   - a {@link PromptTemplateStore} (satisfied by `PromptTemplateRepository`)
 *     and a {@link PromptVersionStore} (satisfied by `PromptVersionRepository`)
 *     — both tenant-scoped, so every operation is confined to the caller's
 *     Organization (Req 1.2, 1.4); and
 *   - an {@link AuditRecorder} port (the concrete Audit_Service, task 3.9) — so
 *     every mutation (create, visibility change, edit) is recorded in the
 *     immutable audit trail (Req 37.1).
 *
 * Responsibilities mapped to acceptance criteria:
 *   - {@link create} — stores title/content/category/tags/ownership and seeds
 *     version 1's history snapshot (Req 10.1), audited.
 *   - {@link setVisibility} — marks a template public (available to all users in
 *     the owning Organization, Req 10.2) or personal (restricted to its owner,
 *     Req 10.3), audited. The visibility *scoping* is enforced in
 *     {@link listVisibleTo} / {@link getForUser} (Property 26).
 *   - {@link fillVariables} — substitutes declared `{{ var }}` values before use,
 *     rejecting an incomplete map so substitution is complete (Req 10.4 /
 *     Property 24).
 *   - {@link edit} — increments the version and retains the prior version as an
 *     immutable snapshot (Req 10.5 / Property 25), audited.
 *   - {@link recordUse} — increments the usage count (Req 10.6).
 *   - {@link analytics} — reports most-used, highest-rated, and most-shared
 *     templates within the Organization (Req 10.7).
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import { computePromptAnalytics } from './analytics.js';
import { MissingPromptVariablesError, PromptTemplateNotFoundError } from './errors.js';
import {
  DEFAULT_ANALYTICS_LIMIT,
  type OrgScope,
  type PromptAnalytics,
  type PromptTemplate,
  type PromptTemplateInput,
  type PromptTemplateStore,
  type PromptVersion,
  type PromptVersionStore,
  type PromptVisibility,
} from './types.js';
import { findMissingVariables, substituteVariables } from './variables.js';

/** Generates unique ids for templates and version snapshots (injectable for tests). */
export interface PromptIdGenerator {
  /** A unique prompt template id. */
  templateId(): string;
  /** A unique prompt version id. */
  versionId(): string;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: PromptIdGenerator = {
  templateId: () => randomUUID(),
  versionId: () => randomUUID(),
};

/** Construction dependencies for the {@link PromptLibrary}. */
export interface PromptLibraryOptions {
  /** The templates store (tenant-scoped `PromptTemplateRepository`). */
  templates: PromptTemplateStore;
  /** The versions store (tenant-scoped `PromptVersionRepository`). */
  versions: PromptVersionStore;
  /** The append-only audit sink; mutations are recorded through it (Req 37.1). */
  audit: AuditRecorder;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: PromptIdGenerator;
}

/**
 * The Prompt_Library service. Construct once with its ports, then call its
 * methods with the acting user's {@link TenantContext}.
 */
export class PromptLibrary {
  private readonly templates: PromptTemplateStore;
  private readonly versions: PromptVersionStore;
  private readonly audit: AuditRecorder;
  private readonly ids: PromptIdGenerator;

  constructor(options: PromptLibraryOptions) {
    this.templates = options.templates;
    this.versions = options.versions;
    this.audit = options.audit;
    this.ids = options.idGenerator ?? defaultIdGenerator;
  }

  /**
   * Create a prompt template storing its title, content, category, tags, and
   * ownership (Req 10.1). Visibility defaults to `personal` (Req 10.3). The
   * initial content is also captured as version 1's immutable snapshot so the
   * full edit history is retained from creation (Req 10.5). Audited.
   */
  async create(
    ctx: TenantContext,
    input: PromptTemplateInput,
    ownerId: string = ctx.userId,
  ): Promise<PromptTemplate> {
    const id = input.id ?? this.ids.templateId();
    const template = await this.templates.create(ctx, {
      id,
      ownerId,
      title: input.title,
      content: input.content,
      category: input.category ?? '',
      tags: input.tags ?? [],
      visibility: input.visibility ?? 'personal',
    });
    // Seed version 1's history snapshot so prior content is always retrievable.
    await this.versions.append(ctx, {
      id: this.ids.versionId(),
      templateId: template.id,
      version: template.version,
      content: template.content,
    });
    await this.audit.record(ctx, {
      action: 'prompt_template.create',
      resourceType: 'prompt_template',
      resourceId: template.id,
      metadata: { ownerId, visibility: template.visibility },
    });
    return template;
  }

  /** Fetch a template by id within the caller's Organization, or `null`. */
  async get(ctx: TenantContext, id: string): Promise<PromptTemplate | null> {
    return this.templates.findById(ctx, id);
  }

  /**
   * Set a template's visibility: `public` makes it available to all users in the
   * owning Organization (Req 10.2); `personal` restricts it to the owning user
   * (Req 10.3). Audited. Raises {@link PromptTemplateNotFoundError} when no
   * template matches within the caller's Organization.
   */
  async setVisibility(ctx: TenantContext, id: string, visibility: PromptVisibility): Promise<void> {
    const updated = await this.templates.update(ctx, id, { visibility });
    if (updated === null) {
      throw new PromptTemplateNotFoundError(id);
    }
    await this.audit.record(ctx, {
      action: 'prompt_template.set_visibility',
      resourceType: 'prompt_template',
      resourceId: id,
      metadata: { visibility },
    });
  }

  /**
   * List the templates a user may access (Req 10.2, 10.3 / Property 26): every
   * public template in the Organization plus the user's own personal templates,
   * and never another user's personal template. Reads are not audited.
   */
  async listVisibleTo(ctx: TenantContext, userId: string = ctx.userId): Promise<PromptTemplate[]> {
    return this.templates.listVisibleTo(ctx, userId);
  }

  /**
   * Fetch a template only if it is visible to `userId` (public, or owned by the
   * user); otherwise `null`. This is the single-template counterpart to
   * {@link listVisibleTo} and enforces the same visibility scoping (Property 26).
   */
  async getForUser(
    ctx: TenantContext,
    id: string,
    userId: string = ctx.userId,
  ): Promise<PromptTemplate | null> {
    const template = await this.templates.findById(ctx, id);
    if (template === null) return null;
    if (template.visibility === 'public' || template.ownerId === userId) return template;
    return null;
  }

  /**
   * Fill a template's `{{ variable }}` placeholders with the supplied values and
   * return the substituted text ready to send to a model (Req 10.4).
   *
   * Filling must be complete: if any declared variable has no value, a
   * {@link MissingPromptVariablesError} naming the unresolved variables is
   * thrown rather than emitting text with leftover placeholders — guaranteeing
   * the produced text has every declared variable replaced (Property 24).
   * Raises {@link PromptTemplateNotFoundError} when no template matches.
   */
  async fillVariables(
    ctx: TenantContext,
    id: string,
    vars: Record<string, string>,
  ): Promise<string> {
    const template = await this.templates.findById(ctx, id);
    if (template === null) {
      throw new PromptTemplateNotFoundError(id);
    }
    const missing = findMissingVariables(template.content, vars);
    if (missing.length > 0) {
      throw new MissingPromptVariablesError(id, missing);
    }
    return substituteVariables(template.content, vars);
  }

  /**
   * Edit a template's content: increment its version and retain the prior
   * version as an immutable snapshot (Req 10.5 / Property 25). Audited. Raises
   * {@link PromptTemplateNotFoundError} when no template matches within the
   * caller's Organization.
   *
   * The prior content (the version about to be superseded) is appended to the
   * version history, then the head row advances to the new content and the next
   * version number — so after N edits the head is version N+1 and all prior
   * versions remain retrievable.
   */
  async edit(ctx: TenantContext, id: string, content: string): Promise<PromptTemplate> {
    const current = await this.templates.findById(ctx, id);
    if (current === null) {
      throw new PromptTemplateNotFoundError(id);
    }
    const nextVersion = current.version + 1;
    const updated = await this.templates.update(ctx, id, {
      content,
      version: nextVersion,
    });
    if (updated === null) {
      // Concurrent deletion between the read and the update.
      throw new PromptTemplateNotFoundError(id);
    }
    // Retain the new content as its own immutable version snapshot, mirroring
    // the seeded version-1 snapshot from create() so history is contiguous.
    await this.versions.append(ctx, {
      id: this.ids.versionId(),
      templateId: id,
      version: nextVersion,
      content,
    });
    await this.audit.record(ctx, {
      action: 'prompt_template.edit',
      resourceType: 'prompt_template',
      resourceId: id,
      metadata: { version: nextVersion },
    });
    return updated;
  }

  /** List a template's retained version history, ascending by version (Req 10.5). */
  async listVersions(ctx: TenantContext, id: string): Promise<PromptVersion[]> {
    return this.versions.listByTemplate(ctx, id);
  }

  /**
   * Record a use of a template by incrementing its usage count (Req 10.6).
   * Returns the new usage count. Raises {@link PromptTemplateNotFoundError} when
   * no template matches within the caller's Organization.
   */
  async recordUse(ctx: TenantContext, id: string): Promise<number> {
    const current = await this.templates.findById(ctx, id);
    if (current === null) {
      throw new PromptTemplateNotFoundError(id);
    }
    const usageCount = current.usageCount + 1;
    const updated = await this.templates.update(ctx, id, { usageCount });
    if (updated === null) {
      throw new PromptTemplateNotFoundError(id);
    }
    return updated.usageCount;
  }

  /**
   * Report the most-used, highest-rated, and most-shared templates within an
   * Organization (Req 10.7). The scope's Organization must match the caller's
   * tenant; ranking is delegated to the pure {@link computePromptAnalytics}.
   * Reads are not audited.
   */
  async analytics(ctx: TenantContext, scope: OrgScope): Promise<PromptAnalytics> {
    const templates = await this.templates.listAll(ctx);
    const limit = scope.limit ?? DEFAULT_ANALYTICS_LIMIT;
    return computePromptAnalytics(templates, limit);
  }
}
