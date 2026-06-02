/**
 * Test fakes and builders for the Prompt_Library.
 *
 * The service composes three injected ports — a {@link PromptTemplateStore}, a
 * {@link PromptVersionStore}, and an {@link AuditRecorder}. These in-memory
 * fakes let unit and property tests drive the service deterministically and
 * inspect what was persisted and audited, without a database:
 *
 *   - {@link InMemoryPromptTemplateStore} models the tenant-scoped
 *     `PromptTemplateRepository`'s observable behaviour: rows confined to their
 *     Organization, `listVisibleTo` returning public-org + owner-personal rows
 *     (Property 26), and `update` bumping `updatedAt`.
 *   - {@link InMemoryPromptVersionStore} models `PromptVersionRepository`:
 *     append-only version snapshots scoped through their parent template's
 *     Organization, listed ascending by version (Property 25).
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert which mutations were audited.
 *   - {@link makePromptTemplate} / {@link sequentialPromptIdGenerator} are small
 *     builders with sensible defaults.
 *
 * The fakes are exported (not test-only) so the concurrent property tests
 * (tasks 9.4 and 9.6) reuse exactly the same doubles.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type { PromptIdGenerator } from './prompt-library.js';
import type {
  AppendPromptVersionRow,
  CreatePromptTemplateRow,
  PromptTemplate,
  PromptTemplateStore,
  PromptVersion,
  PromptVersionStore,
  UpdatePromptTemplateRow,
} from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which mutations were audited (Req 37.1).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({
      ctx: { ...ctx },
      event: { ...event, metadata: { ...(event.metadata ?? {}) } },
    });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `prompt_template.edit`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }
}

/** Clone a template row so callers can never mutate stored state. */
function cloneTemplate(record: PromptTemplate): PromptTemplate {
  return { ...record, tags: [...record.tags] };
}

/**
 * An in-memory {@link PromptTemplateStore} modelling the tenant-scoped
 * `PromptTemplateRepository`: rows are confined to their Organization, and
 * `listVisibleTo` enforces the public-org + owner-personal visibility scope.
 */
export class InMemoryPromptTemplateStore implements PromptTemplateStore {
  private readonly rows = new Map<string, PromptTemplate>();
  private clock: () => Date;

  /** @param now Injected clock so `updatedAt`/`createdAt` are deterministic. */
  constructor(now: () => Date = () => new Date('2026-01-01T00:00:00.000Z')) {
    this.clock = now;
  }

  /** Seed a fully-formed row (e.g. another tenant's data, fixed timestamps). */
  seed(record: PromptTemplate): void {
    this.rows.set(record.id, cloneTemplate(record));
  }

  async create(ctx: TenantContext, input: CreatePromptTemplateRow): Promise<PromptTemplate> {
    const ts = this.clock().toISOString();
    const record: PromptTemplate = {
      id: input.id,
      ownerId: input.ownerId,
      organizationId: ctx.organizationId,
      title: input.title,
      content: input.content,
      category: input.category,
      tags: [...input.tags],
      visibility: input.visibility,
      version: 1,
      usageCount: 0,
      ratingAvg: 0,
      shareCount: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.set(record.id, record);
    return cloneTemplate(record);
  }

  async findById(ctx: TenantContext, id: string): Promise<PromptTemplate | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    return cloneTemplate(row);
  }

  async listAll(ctx: TenantContext): Promise<PromptTemplate[]> {
    return [...this.rows.values()]
      .filter((r) => r.organizationId === ctx.organizationId)
      .map(cloneTemplate);
  }

  async listVisibleTo(ctx: TenantContext, userId: string): Promise<PromptTemplate[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.organizationId === ctx.organizationId &&
          (r.visibility === 'public' || r.ownerId === userId),
      )
      .map(cloneTemplate);
  }

  async update(
    ctx: TenantContext,
    id: string,
    patch: UpdatePromptTemplateRow,
  ): Promise<PromptTemplate | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.content !== undefined) row.content = patch.content;
    if (patch.category !== undefined) row.category = patch.category;
    if (patch.tags !== undefined) row.tags = [...patch.tags];
    if (patch.visibility !== undefined) row.visibility = patch.visibility;
    if (patch.version !== undefined) row.version = patch.version;
    if (patch.usageCount !== undefined) row.usageCount = patch.usageCount;
    if (patch.ratingAvg !== undefined) row.ratingAvg = patch.ratingAvg;
    if (patch.shareCount !== undefined) row.shareCount = patch.shareCount;
    row.updatedAt = this.clock().toISOString();
    return cloneTemplate(row);
  }
}

/** Clone a version row so stored state is immutable. */
function cloneVersion(record: PromptVersion): PromptVersion {
  return { ...record };
}

/**
 * An in-memory {@link PromptVersionStore} modelling the parent-scoped
 * `PromptVersionRepository`: append-only snapshots scoped through their parent
 * template's Organization, listed ascending by version.
 */
export class InMemoryPromptVersionStore implements PromptVersionStore {
  private readonly rows = new Map<string, PromptVersion>();

  /**
   * @param templateOrg Resolves a template id to its owning Organization,
   *   modelling the parent-tenant scope. A template not in the map (or in a
   *   different org) yields no rows for that tenant.
   */
  constructor(private readonly templateOrg: (templateId: string) => string | undefined) {}

  async append(ctx: TenantContext, input: AppendPromptVersionRow): Promise<PromptVersion> {
    // Mirror the repository's EXISTS guard: the parent must belong to the tenant.
    if (this.templateOrg(input.templateId) !== ctx.organizationId) {
      throw new Error(
        `Cannot append prompt version: template "${input.templateId}" is not in the current tenant`,
      );
    }
    const record: PromptVersion = {
      id: input.id,
      templateId: input.templateId,
      version: input.version,
      content: input.content,
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    };
    this.rows.set(record.id, cloneVersion(record));
    return cloneVersion(record);
  }

  async listByTemplate(ctx: TenantContext, templateId: string): Promise<PromptVersion[]> {
    if (this.templateOrg(templateId) !== ctx.organizationId) return [];
    return [...this.rows.values()]
      .filter((r) => r.templateId === templateId)
      .sort((a, b) => a.version - b.version)
      .map(cloneVersion);
  }
}

/** Build a {@link PromptTemplate} with sensible defaults; override field-by-field. */
export function makePromptTemplate(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'tmpl-1',
    ownerId: 'user-1',
    organizationId: 'org-1',
    title: 'Untitled',
    content: '',
    category: '',
    tags: [],
    visibility: 'personal',
    version: 1,
    usageCount: 0,
    ratingAvg: 0,
    shareCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A deterministic {@link PromptIdGenerator} handing out `tmpl-1`, `tmpl-2`, …
 * template ids and `ver-1`, `ver-2`, … version ids, for assertion-friendly
 * tests.
 */
export function sequentialPromptIdGenerator(): PromptIdGenerator {
  let templateCounter = 0;
  let versionCounter = 0;
  return {
    templateId: () => `tmpl-${(templateCounter += 1)}`,
    versionId: () => `ver-${(versionCounter += 1)}`,
  };
}
