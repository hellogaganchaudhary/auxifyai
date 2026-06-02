/**
 * Unit tests for the Knowledge_Hub_Service (Req 26.1-26.9).
 *
 * These exercise the service against in-memory fakes for its ports (page store,
 * audit recorder, ingestion emitter, notifier, authorizer, authoring model),
 * covering every acceptance criterion with concrete examples and edge cases:
 *   - createPage() persists title/content/author/Project/timestamp, seeds
 *     version 1, audits, and emits for ingestion (Req 26.1, 26.8);
 *   - setParent() maintains the hierarchy, rejects cycles / cross-space parents,
 *     and navigationTree() presents the tree (Req 26.2);
 *   - edit() creates a new version and retains all prior versions, audits, and
 *     re-emits for ingestion (Req 26.3, 26.8);
 *   - restoreVersion() sets content to a prior version and records a NEW version
 *     entry (Req 26.4);
 *   - comment() persists an anchored comment and notifies subscribers (Req 26.5);
 *   - setPermissions() persists permissions and is enforced via the authorizer
 *     on every operation (Req 26.6);
 *   - aiAuthor()/acceptDraft() generate a draft and save only on accept (Req 26.7);
 *   - a denied modification is rejected AND recorded in the Audit_Service
 *     (Req 26.9);
 *   - tenant isolation: a page in another Organization is invisible (Req 1.4).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { KnowledgeHubService } from './knowledge-hub-service.js';
import {
  InvalidPageHierarchyError,
  PageAccessDeniedError,
  PageNotFoundError,
  PageVersionNotFoundError,
} from './errors.js';
import {
  AllowAllPageAuthorizer,
  CapturingAuditRecorder,
  CapturingIngestionEmitter,
  CapturingPageNotifier,
  DenyAllPageAuthorizer,
  InMemoryPageStore,
  makePermissions,
  makePrincipal,
  makeRichContent,
  monotonicClock,
  sequentialPageIdGenerator,
} from './fakes.js';
import { PermissionsPageAuthorizer } from './page-authorizer.js';
import type { PageAuthorizer } from './types.js';

const PROJECT = 'proj-1';

interface Harness {
  service: KnowledgeHubService;
  store: InMemoryPageStore;
  audit: CapturingAuditRecorder;
  ingestion: CapturingIngestionEmitter;
  notifier: CapturingPageNotifier;
}

function makeHarness(authorizer: PageAuthorizer = new AllowAllPageAuthorizer()): Harness {
  const store = new InMemoryPageStore(monotonicClock());
  const audit = new CapturingAuditRecorder();
  const ingestion = new CapturingIngestionEmitter();
  const notifier = new CapturingPageNotifier();
  const service = new KnowledgeHubService({
    pages: store,
    audit,
    ingestion,
    notifier,
    authorizer,
    idGenerator: sequentialPageIdGenerator(),
  });
  return { service, store, audit, ingestion, notifier };
}

const principal = makePrincipal({ userId: 'user-1', organizationId: 'org-1', projectIds: [PROJECT] });

describe('KnowledgeHubService.createPage (Req 26.1, 26.8)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('persists title, content, author, Project, and creation timestamp at version 1', async () => {
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Onboarding',
      content: makeRichContent('Welcome to the team'),
    });
    expect(page.id).toBe('page-1');
    expect(page.title).toBe('Onboarding');
    expect(page.content.text).toBe('Welcome to the team');
    expect(page.authorId).toBe('user-1');
    expect(page.projectId).toBe(PROJECT);
    expect(page.organizationId).toBe('org-1');
    expect(page.version).toBe(1);
    expect(page.createdAt).toBeTruthy();
  });

  it('records the creation in the Audit_Service', async () => {
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Onboarding',
      content: makeRichContent('Welcome'),
    });
    const events = h.audit.withAction('knowledge_page.create');
    expect(events).toHaveLength(1);
    expect(events[0]!.event.resourceId).toBe(page.id);
    expect(events[0]!.event.resourceType).toBe('knowledge_page');
  });

  it('emits the page content for ingestion on create (Req 26.8)', async () => {
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Onboarding',
      content: makeRichContent('Welcome to the team'),
    });
    expect(h.ingestion.count).toBe(1);
    const emitted = h.ingestion.last!.event;
    expect(emitted.pageId).toBe(page.id);
    expect(emitted.text).toBe('Welcome to the team');
    expect(emitted.attribution.sourceId).toBe(page.id);
    expect(emitted.attribution.sourceTitle).toBe('Onboarding');
    expect(emitted.attribution.location).toBeTruthy();
    expect(emitted.attribution.link).toBeTruthy();
  });

  it('rejects a parent in a different Project space', async () => {
    const other = await h.service.createPage(
      makePrincipal({ projectIds: ['proj-2'] }),
      { projectId: 'proj-2', title: 'Other', content: makeRichContent('x') },
    );
    await expect(
      h.service.createPage(principal, {
        projectId: PROJECT,
        title: 'Child',
        content: makeRichContent('y'),
        parentId: other.id,
      }),
    ).rejects.toBeInstanceOf(InvalidPageHierarchyError);
  });
});

describe('KnowledgeHubService hierarchy (Req 26.2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('maintains parent-child hierarchy and presents the navigation tree', async () => {
    const root = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Root',
      content: makeRichContent('r'),
    });
    const child = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Child',
      content: makeRichContent('c'),
      parentId: root.id,
    });
    const tree = await h.service.navigationTree(principal, PROJECT);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe(root.id);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children[0]!.id).toBe(child.id);
  });

  it('setParent re-parents a page and audits the change', async () => {
    const a = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'A',
      content: makeRichContent('a'),
    });
    const b = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'B',
      content: makeRichContent('b'),
    });
    await h.service.setParent(principal, b.id, a.id);
    const reloaded = await h.service.getPage(principal, b.id);
    expect(reloaded!.parentId).toBe(a.id);
    expect(h.audit.withAction('knowledge_page.set_parent')).toHaveLength(1);
  });

  it('rejects a re-parent that would create a cycle', async () => {
    const a = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'A',
      content: makeRichContent('a'),
    });
    const b = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'B',
      content: makeRichContent('b'),
      parentId: a.id,
    });
    // Making A a child of B (its own descendant) is a cycle.
    await expect(h.service.setParent(principal, a.id, b.id)).rejects.toBeInstanceOf(
      InvalidPageHierarchyError,
    );
  });
});

describe('KnowledgeHubService.edit version retention (Req 26.3, 26.8)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('creates a new version and retains all prior versions', async () => {
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Doc',
      content: makeRichContent('v1'),
    });
    await h.service.edit(principal, page.id, makeRichContent('v2'));
    await h.service.edit(principal, page.id, makeRichContent('v3'));

    const versions = await h.service.listVersions(principal, page.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions.map((v) => v.content.text)).toEqual(['v1', 'v2', 'v3']);

    const head = await h.service.getPage(principal, page.id);
    expect(head!.version).toBe(3);
    expect(head!.content.text).toBe('v3');
  });

  it('audits each edit and re-emits content for ingestion', async () => {
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Doc',
      content: makeRichContent('v1'),
    });
    const ingestionBefore = h.ingestion.count;
    await h.service.edit(principal, page.id, makeRichContent('v2'));
    expect(h.audit.withAction('knowledge_page.edit')).toHaveLength(1);
    expect(h.ingestion.count).toBe(ingestionBefore + 1);
    expect(h.ingestion.last!.event.text).toBe('v2');
    expect(h.ingestion.last!.event.version).toBe(2);
  });

  it('throws PageNotFoundError editing a non-existent page', async () => {
    await expect(
      h.service.edit(principal, 'missing', makeRichContent('x')),
    ).rejects.toBeInstanceOf(PageNotFoundError);
  });
});

describe('KnowledgeHubService.restoreVersion (Req 26.4)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('sets content to a prior version and records a new version entry', async () => {
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Doc',
      content: makeRichContent('v1'),
    });
    await h.service.edit(principal, page.id, makeRichContent('v2'));
    const versions = await h.service.listVersions(principal, page.id);
    const v1 = versions.find((v) => v.version === 1)!;

    const restored = await h.service.restoreVersion(principal, page.id, v1.id);
    expect(restored.version).toBe(3); // a NEW version entry (Req 26.4)
    expect(restored.content.text).toBe('v1');

    const head = await h.service.getPage(principal, page.id);
    expect(head!.content.text).toBe('v1');
    expect(head!.version).toBe(3);

    const afterRestore = await h.service.listVersions(principal, page.id);
    expect(afterRestore.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(h.audit.withAction('knowledge_page.restore_version')).toHaveLength(1);
  });

  it('throws PageVersionNotFoundError for an unknown version', async () => {
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Doc',
      content: makeRichContent('v1'),
    });
    await expect(
      h.service.restoreVersion(principal, page.id, 'no-such-version'),
    ).rejects.toBeInstanceOf(PageVersionNotFoundError);
  });
});

describe('KnowledgeHubService.comment (Req 26.5)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('persists an anchored comment with author and timestamp and notifies subscribers', async () => {
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Doc',
      content: makeRichContent('body'),
    });
    h.store.setSubscribers(page.id, ['user-2', 'user-3', 'user-1']);

    const comment = await h.service.comment(principal, page.id, {
      anchor: 'para-2',
      body: 'Great point',
    });
    expect(comment.anchor).toBe('para-2');
    expect(comment.authorId).toBe('user-1');
    expect(comment.createdAt).toBeTruthy();

    const stored = await h.service.listComments(principal, page.id);
    expect(stored).toHaveLength(1);

    // Subscribers notified, excluding the comment's own author.
    expect(h.notifier.last!.subscriberIds.sort()).toEqual(['user-2', 'user-3']);
    expect(h.audit.withAction('knowledge_page.comment')).toHaveLength(1);
  });
});

describe('KnowledgeHubService.setPermissions and enforcement (Req 26.6, 26.9)', () => {
  it('persists permissions and audits the change', async () => {
    const h = makeHarness();
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Doc',
      content: makeRichContent('body'),
    });
    await h.service.setPermissions(
      principal,
      page.id,
      makePermissions({ projectEditors: false, editorIds: ['user-9'] }),
    );
    const reloaded = await h.service.getPage(principal, page.id);
    expect(reloaded!.permissions.projectEditors).toBe(false);
    expect(reloaded!.permissions.editorIds).toEqual(['user-9']);
    expect(h.audit.withAction('knowledge_page.set_permissions')).toHaveLength(1);
  });

  it('denies a modification AND records the denied attempt (Req 26.9)', async () => {
    // Allow create (so we can seed a page), then deny everything else.
    const store = new InMemoryPageStore(monotonicClock());
    const audit = new CapturingAuditRecorder();
    const ingestion = new CapturingIngestionEmitter();
    const notifier = new CapturingPageNotifier();
    const service = new KnowledgeHubService({
      pages: store,
      audit,
      ingestion,
      notifier,
      authorizer: new DenyAllPageAuthorizer('insufficient permission'),
      idGenerator: sequentialPageIdGenerator(),
    });
    // Seed a page directly (createPage doesn't authorize, but edit does).
    const page = await store.createPage(
      { organizationId: 'org-1', userId: 'user-1' },
      {
        id: 'page-1',
        versionId: 'ver-1',
        projectId: PROJECT,
        title: 'Doc',
        content: makeRichContent('v1'),
        authorId: 'author-x',
        permissions: makePermissions(),
      },
    );

    await expect(
      service.edit(principal, page.id, makeRichContent('v2')),
    ).rejects.toBeInstanceOf(PageAccessDeniedError);

    // The denial is audited and no new version was created.
    expect(audit.withAction('knowledge_page.access_denied')).toHaveLength(1);
    const versions = await service.listVersions(principal, page.id);
    expect(versions).toHaveLength(1);
  });
});

describe('KnowledgeHubService AI authoring (Req 26.7)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('generates a draft without saving, then saves only on accept', async () => {
    const page = await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Doc',
      content: makeRichContent('original'),
    });
    const draft = await h.service.aiAuthor(principal, page.id, 'rewritten body');
    expect(draft.draft.text).toBe('rewritten body');
    expect(draft.baseVersion).toBe(1);

    // aiAuthor did NOT persist a new version.
    let head = await h.service.getPage(principal, page.id);
    expect(head!.content.text).toBe('original');
    expect(head!.version).toBe(1);

    // Accepting the draft saves it as a new version (Req 26.3, 26.7).
    await h.service.acceptDraft(principal, draft);
    head = await h.service.getPage(principal, page.id);
    expect(head!.content.text).toBe('rewritten body');
    expect(head!.version).toBe(2);
    expect(h.audit.withAction('knowledge_page.ai_author')).toHaveLength(1);
  });
});

describe('KnowledgeHubService.search (Req 26.x)', () => {
  it('returns matching pages within the space ranked by relevance', async () => {
    const h = makeHarness();
    await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Deployment Guide',
      content: makeRichContent('how to deploy the service'),
    });
    await h.service.createPage(principal, {
      projectId: PROJECT,
      title: 'Style Guide',
      content: makeRichContent('coding conventions'),
    });
    const hits = await h.service.search(principal, PROJECT, 'deploy');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.page.title).toBe('Deployment Guide');
  });
});

describe('KnowledgeHubService tenant isolation (Req 1.4)', () => {
  it('does not surface a page from another Organization', async () => {
    const h = makeHarness();
    const orgAPrincipal = makePrincipal({ organizationId: 'org-a', projectIds: [PROJECT] });
    const page = await h.service.createPage(orgAPrincipal, {
      projectId: PROJECT,
      title: 'Secret',
      content: makeRichContent('classified'),
    });
    const orgBPrincipal = makePrincipal({ organizationId: 'org-b', projectIds: [PROJECT] });
    expect(await h.service.getPage(orgBPrincipal, page.id)).toBeNull();
    await expect(
      h.service.edit(orgBPrincipal, page.id, makeRichContent('hacked')),
    ).rejects.toBeInstanceOf(PageNotFoundError);
  });
});

describe('PermissionsPageAuthorizer (Req 26.6)', () => {
  const authorizer = new PermissionsPageAuthorizer();
  const basePage = {
    id: 'page-1',
    organizationId: 'org-1',
    projectId: PROJECT,
    title: 'Doc',
    content: makeRichContent('body'),
    authorId: 'author-1',
    version: 1,
    permissions: makePermissions(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('lets the author edit', async () => {
    const author = makePrincipal({ userId: 'author-1', projectIds: [] });
    const d = await authorizer.authorize(author, basePage, 'edit');
    expect(d.allowed).toBe(true);
  });

  it('lets an org admin edit even outside the Project', async () => {
    const admin = makePrincipal({ userId: 'admin-1', roles: ['admin'], projectIds: [] });
    const d = await authorizer.authorize(admin, basePage, 'manage');
    expect(d.allowed).toBe(true);
  });

  it('denies a non-member without an explicit grant', async () => {
    const outsider = makePrincipal({ userId: 'outsider', projectIds: [] });
    const d = await authorizer.authorize(outsider, basePage, 'edit');
    expect(d.allowed).toBe(false);
  });

  it('allows a project member to view but not edit when projectEditors is false', async () => {
    const page = { ...basePage, permissions: makePermissions({ projectEditors: false }) };
    const member = makePrincipal({ userId: 'member', projectIds: [PROJECT] });
    expect((await authorizer.authorize(member, page, 'view')).allowed).toBe(true);
    expect((await authorizer.authorize(member, page, 'edit')).allowed).toBe(false);
  });

  it('denies cross-Organization access', async () => {
    const other = makePrincipal({ userId: 'x', organizationId: 'org-2', projectIds: [PROJECT] });
    expect((await authorizer.authorize(other, basePage, 'view')).allowed).toBe(false);
  });
});
