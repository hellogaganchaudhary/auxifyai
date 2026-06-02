/**
 * Test fakes and builders for the Knowledge_Hub_Service.
 *
 * The service composes six injected ports — a {@link PageStore}, an
 * {@link AuditRecorder}, a {@link PageIngestionEmitter}, a {@link PageNotifier},
 * a {@link PageAuthorizer}, and a {@link PageAuthoringModel}. These in-memory
 * fakes let unit and property tests drive the service deterministically and
 * inspect what was persisted, audited, emitted for ingestion, and notified —
 * without a database, a model, or a network:
 *
 *   - {@link InMemoryPageStore} models the tenant-scoped page repository's
 *     observable behaviour: Organization scoping, the version-on-every-write
 *     invariant (Req 26.3), parent/permission updates, comments, and subscribers.
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert exactly which mutations and denials were audited (Req 26.9).
 *   - {@link CapturingIngestionEmitter} records every emitted
 *     {@link PageIngestionEvent} so a test can assert the ingestion-on-write hook
 *     fired (Req 26.8).
 *   - {@link CapturingPageNotifier} records every comment notification (Req 26.5).
 *   - {@link AllowAllPageAuthorizer} / {@link DenyAllPageAuthorizer} are simple
 *     authorizers for exercising the permission/denial paths independently of the
 *     default {@link import('./page-authorizer.js').PermissionsPageAuthorizer}.
 *   - {@link makePrincipal} / {@link makeRichContent} / {@link sequentialPageIdGenerator}
 *     are small builders with sensible defaults.
 *
 * These are imported directly from `./fakes.js` by the unit and property tests
 * (never from the package barrel), matching the established convention.
 */

import type { Principal, TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type { PageIdGenerator } from './knowledge-hub-service.js';
import type {
  CreateCommentRow,
  CreatePageRow,
  KnowledgePage,
  PageAuthorizer,
  PageAuthzDecision,
  PageComment,
  PageContentWrite,
  PageIngestionEmitter,
  PageIngestionEvent,
  PageNotifier,
  PagePermissions,
  PageStore,
  PageVersion,
  RichContent,
  UpdatePageContentRow,
} from './types.js';
import { DEFAULT_PAGE_PERMISSIONS } from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which mutations and denials were audited (Req 26.9).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
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

  /** Every recorded event with the given action (e.g. `knowledge_page.edit`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/** A captured ingestion emission as seen by the {@link PageIngestionEmitter} port. */
export interface CapturedIngestion {
  ctx: TenantContext;
  event: PageIngestionEvent;
}

/**
 * A capturing {@link PageIngestionEmitter} storing every emitted event so tests
 * can assert the ingestion-on-write hook fired (Req 26.8).
 */
export class CapturingIngestionEmitter implements PageIngestionEmitter {
  /** Every emitted ingestion event, in order. */
  readonly emitted: CapturedIngestion[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async emit(ctx: TenantContext, event: PageIngestionEvent): Promise<void> {
    this.emitted.push({ ctx: { ...ctx }, event: { ...event, attribution: { ...event.attribution } } });
  }

  /** The number of emissions so far. */
  get count(): number {
    return this.emitted.length;
  }

  /** Every emission for the given page id. */
  forPage(pageId: string): CapturedIngestion[] {
    return this.emitted.filter((e) => e.event.pageId === pageId);
  }

  /** The single most recent emission, or `undefined`. */
  get last(): CapturedIngestion | undefined {
    return this.emitted[this.emitted.length - 1];
  }
}

/** A captured comment notification as seen by the {@link PageNotifier} port. */
export interface CapturedNotification {
  ctx: TenantContext;
  pageId: string;
  commentId: string;
  subscriberIds: string[];
}

/** A capturing {@link PageNotifier} recording every comment notification (Req 26.5). */
export class CapturingPageNotifier implements PageNotifier {
  /** Every notification, in order. */
  readonly notifications: CapturedNotification[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async notify(
    ctx: TenantContext,
    notification: { pageId: string; commentId: string; subscriberIds: string[] },
  ): Promise<void> {
    this.notifications.push({
      ctx: { ...ctx },
      pageId: notification.pageId,
      commentId: notification.commentId,
      subscriberIds: [...notification.subscriberIds],
    });
  }

  /** The single most recent notification, or `undefined`. */
  get last(): CapturedNotification | undefined {
    return this.notifications[this.notifications.length - 1];
  }
}

/** A {@link PageAuthorizer} that permits every action (for testing happy paths). */
export class AllowAllPageAuthorizer implements PageAuthorizer {
  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async authorize(): Promise<PageAuthzDecision> {
    return { allowed: true, reason: 'allow-all test authorizer' };
  }
}

/** A {@link PageAuthorizer} that denies every action (for testing denial paths). */
export class DenyAllPageAuthorizer implements PageAuthorizer {
  constructor(private readonly reason: string = 'deny-all test authorizer') {}

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async authorize(): Promise<PageAuthzDecision> {
    return { allowed: false, reason: this.reason };
  }
}

function clonePermissions(perms: PagePermissions): PagePermissions {
  return {
    projectViewers: perms.projectViewers,
    projectEditors: perms.projectEditors,
    viewerIds: [...perms.viewerIds],
    editorIds: [...perms.editorIds],
  };
}

function cloneContent(content: RichContent): RichContent {
  return { format: content.format, text: content.text };
}

function clonePage(page: KnowledgePage): KnowledgePage {
  const copy: KnowledgePage = {
    id: page.id,
    organizationId: page.organizationId,
    projectId: page.projectId,
    title: page.title,
    content: cloneContent(page.content),
    authorId: page.authorId,
    version: page.version,
    permissions: clonePermissions(page.permissions),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
  if (page.parentId !== undefined) copy.parentId = page.parentId;
  return copy;
}

function cloneVersion(version: PageVersion): PageVersion {
  return {
    id: version.id,
    pageId: version.pageId,
    version: version.version,
    content: cloneContent(version.content),
    createdAt: version.createdAt,
  };
}

function cloneComment(comment: PageComment): PageComment {
  return { ...comment };
}

/**
 * An in-memory {@link PageStore} modelling the tenant-scoped page repository.
 *
 * Rows are confined to their Organization; {@link createPage} seeds version 1 and
 * {@link updateContent} appends the next version while advancing the head — so
 * the version-on-every-write invariant (Req 26.3) holds exactly as the real
 * repository enforces it. A monotonic injected clock makes timestamps strictly
 * increasing so version ordering is observable.
 */
export class InMemoryPageStore implements PageStore {
  private readonly pages = new Map<string, KnowledgePage>();
  private readonly versions = new Map<string, PageVersion[]>();
  private readonly comments = new Map<string, PageComment[]>();
  private readonly subscribers = new Map<string, Set<string>>();
  private clock: () => Date;

  /** @param now Injected clock so timestamps are deterministic and strictly increasing. */
  constructor(now: () => Date = () => new Date()) {
    this.clock = now;
  }

  /** Override the clock. */
  setClock(now: () => Date): void {
    this.clock = now;
  }

  /** Seed a fully-formed page row (e.g. another tenant's data). */
  seedPage(page: KnowledgePage): void {
    this.pages.set(page.id, clonePage(page));
    if (!this.versions.has(page.id)) {
      this.versions.set(page.id, [
        {
          id: `${page.id}-v${page.version}`,
          pageId: page.id,
          version: page.version,
          content: cloneContent(page.content),
          createdAt: page.createdAt,
        },
      ]);
    }
  }

  /** Register subscribers for a page (Req 26.5 notification target). */
  setSubscribers(pageId: string, subscriberIds: string[]): void {
    this.subscribers.set(pageId, new Set(subscriberIds));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async createPage(ctx: TenantContext, input: CreatePageRow): Promise<KnowledgePage> {
    const ts = this.clock().toISOString();
    const page: KnowledgePage = {
      id: input.id,
      organizationId: ctx.organizationId,
      projectId: input.projectId,
      title: input.title,
      content: cloneContent(input.content),
      authorId: input.authorId,
      version: 1,
      permissions: clonePermissions(input.permissions),
      createdAt: ts,
      updatedAt: ts,
    };
    if (input.parentId !== undefined) page.parentId = input.parentId;
    this.pages.set(page.id, page);
    // Seed version 1's history row (version-on-every-write invariant, Req 26.3).
    this.versions.set(page.id, [
      {
        id: input.versionId,
        pageId: page.id,
        version: 1,
        content: cloneContent(input.content),
        createdAt: ts,
      },
    ]);
    return clonePage(page);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findById(ctx: TenantContext, id: string): Promise<KnowledgePage | null> {
    const row = this.pages.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    return clonePage(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listByProject(ctx: TenantContext, projectId: string): Promise<KnowledgePage[]> {
    return [...this.pages.values()]
      .filter((p) => p.organizationId === ctx.organizationId && p.projectId === projectId)
      .map(clonePage);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async setParent(
    ctx: TenantContext,
    id: string,
    parentId: string | null,
  ): Promise<KnowledgePage | null> {
    const row = this.pages.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    if (parentId === null) {
      delete row.parentId;
    } else {
      row.parentId = parentId;
    }
    row.updatedAt = this.clock().toISOString();
    return clonePage(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async updateContent(
    ctx: TenantContext,
    id: string,
    input: UpdatePageContentRow,
  ): Promise<PageContentWrite | null> {
    const row = this.pages.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    const ts = this.clock().toISOString();
    const nextVersion = row.version + 1;
    row.content = cloneContent(input.content);
    row.version = nextVersion;
    row.updatedAt = ts;
    const version: PageVersion = {
      id: input.versionId,
      pageId: id,
      version: nextVersion,
      content: cloneContent(input.content),
      createdAt: ts,
    };
    const history = this.versions.get(id) ?? [];
    history.push(version);
    this.versions.set(id, history);
    return { page: clonePage(row), version: cloneVersion(version) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async updatePermissions(
    ctx: TenantContext,
    id: string,
    permissions: PagePermissions,
  ): Promise<KnowledgePage | null> {
    const row = this.pages.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    row.permissions = clonePermissions(permissions);
    row.updatedAt = this.clock().toISOString();
    return clonePage(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listVersions(ctx: TenantContext, id: string): Promise<PageVersion[]> {
    const row = this.pages.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return [];
    const history = this.versions.get(id) ?? [];
    return [...history].sort((a, b) => a.version - b.version).map(cloneVersion);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async getVersion(
    ctx: TenantContext,
    id: string,
    versionId: string,
  ): Promise<PageVersion | null> {
    const row = this.pages.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    const history = this.versions.get(id) ?? [];
    const found = history.find((v) => v.id === versionId);
    return found !== undefined ? cloneVersion(found) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async addComment(ctx: TenantContext, input: CreateCommentRow): Promise<PageComment> {
    const page = this.pages.get(input.pageId);
    if (page === undefined || page.organizationId !== ctx.organizationId) {
      throw new Error(`page "${input.pageId}" not found in tenant`);
    }
    const comment: PageComment = {
      id: input.id,
      pageId: input.pageId,
      authorId: input.authorId,
      anchor: input.anchor,
      body: input.body,
      createdAt: this.clock().toISOString(),
    };
    const list = this.comments.get(input.pageId) ?? [];
    list.push(comment);
    this.comments.set(input.pageId, list);
    return cloneComment(comment);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listComments(ctx: TenantContext, pageId: string): Promise<PageComment[]> {
    const page = this.pages.get(pageId);
    if (page === undefined || page.organizationId !== ctx.organizationId) return [];
    const list = this.comments.get(pageId) ?? [];
    return [...list]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map(cloneComment);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listSubscribers(ctx: TenantContext, pageId: string): Promise<string[]> {
    const page = this.pages.get(pageId);
    if (page === undefined || page.organizationId !== ctx.organizationId) return [];
    return [...(this.subscribers.get(pageId) ?? new Set<string>())];
  }
}

/** Build a {@link Principal} with sensible defaults; override field-by-field. */
export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    roles: ['standard_user'],
    teamIds: [],
    projectIds: ['proj-1'],
    allowedModels: [],
    premiumAuthorized: false,
    ...overrides,
  };
}

/** Build a {@link RichContent} markdown body with the given text. */
export function makeRichContent(text: string, format: RichContent['format'] = 'markdown'): RichContent {
  return { format, text };
}

/** Build {@link PagePermissions}, defaulting to {@link DEFAULT_PAGE_PERMISSIONS}. */
export function makePermissions(overrides: Partial<PagePermissions> = {}): PagePermissions {
  return {
    projectViewers: overrides.projectViewers ?? DEFAULT_PAGE_PERMISSIONS.projectViewers,
    projectEditors: overrides.projectEditors ?? DEFAULT_PAGE_PERMISSIONS.projectEditors,
    viewerIds: overrides.viewerIds ?? [],
    editorIds: overrides.editorIds ?? [],
  };
}

/**
 * A deterministic {@link PageIdGenerator} handing out `page-1`, `page-2`, …
 * page ids, `ver-1`, `ver-2`, … version-row ids, and `cmt-1`, `cmt-2`, …
 * comment ids, for assertion-friendly tests.
 */
export function sequentialPageIdGenerator(): PageIdGenerator {
  let pageCounter = 0;
  let versionCounter = 0;
  let commentCounter = 0;
  return {
    pageId: () => `page-${(pageCounter += 1)}`,
    versionId: () => `ver-${(versionCounter += 1)}`,
    commentId: () => `cmt-${(commentCounter += 1)}`,
  };
}

/**
 * Build a monotonic clock whose every call returns a strictly-increasing
 * timestamp, so version/comment timestamps are observable and ordered.
 */
export function monotonicClock(): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
  };
}
