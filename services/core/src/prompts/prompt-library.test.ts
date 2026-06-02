/**
 * Unit tests for the Prompt_Library service (Req 10.1-10.7).
 *
 * These exercise the service against in-memory fakes for its three ports
 * (template store, version store, audit recorder), covering every acceptance
 * criterion with concrete examples and edge cases:
 *   - create stores title/content/category/tags/ownership and seeds version 1
 *     (Req 10.1);
 *   - visibility scoping: public is org-wide, personal is owner-only, and one
 *     user never sees another user's personal template (Req 10.2, 10.3);
 *   - fillVariables substitutes complete maps and rejects incomplete ones
 *     (Req 10.4);
 *   - edit increments the version and retains all prior versions (Req 10.5);
 *   - recordUse increments the usage count (Req 10.6);
 *   - analytics reports most-used / highest-rated / most-shared (Req 10.7).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import {
  CapturingAuditRecorder,
  InMemoryPromptTemplateStore,
  InMemoryPromptVersionStore,
  makePromptTemplate,
  sequentialPromptIdGenerator,
} from './fakes.js';
import { MissingPromptVariablesError, PromptTemplateNotFoundError } from './errors.js';
import { PromptLibrary } from './prompt-library.js';

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };

interface Harness {
  library: PromptLibrary;
  templates: InMemoryPromptTemplateStore;
  versions: InMemoryPromptVersionStore;
  audit: CapturingAuditRecorder;
}

function makeHarness(): Harness {
  const templates = new InMemoryPromptTemplateStore();
  // The version store resolves a template id to its org by consulting the
  // template store, modelling the parent-tenant scope.
  const orgOf = new Map<string, string>();
  const versions = new InMemoryPromptVersionStore((templateId) => orgOf.get(templateId));
  const audit = new CapturingAuditRecorder();
  const library = new PromptLibrary({
    templates,
    versions,
    audit,
    idGenerator: sequentialPromptIdGenerator(),
  });
  // Wrap create so every created template registers its org for the version store.
  const originalCreate = templates.create.bind(templates);
  templates.create = async (c, input) => {
    const created = await originalCreate(c, input);
    orgOf.set(created.id, created.organizationId);
    return created;
  };
  return { library, templates, versions, audit };
}

describe('PromptLibrary.create (Req 10.1)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('stores title, content, category, tags, and ownership', async () => {
    const tmpl = await h.library.create(
      ctx,
      {
        title: 'Bug report',
        content: 'Repro: {{steps}}',
        category: 'engineering',
        tags: ['qa', 'triage'],
      },
      'user-1',
    );

    expect(tmpl).toMatchObject({
      title: 'Bug report',
      content: 'Repro: {{steps}}',
      category: 'engineering',
      tags: ['qa', 'triage'],
      ownerId: 'user-1',
      organizationId: 'org-1',
      version: 1,
      usageCount: 0,
    });
  });

  it('defaults visibility to personal and owner to the acting user', async () => {
    const tmpl = await h.library.create(ctx, { title: 'T', content: 'C' });
    expect(tmpl.visibility).toBe('personal');
    expect(tmpl.ownerId).toBe('user-1');
  });

  it('seeds version 1 history and records an audit event', async () => {
    const tmpl = await h.library.create(ctx, { title: 'T', content: 'v1 body' });
    const versions = await h.library.listVersions(ctx, tmpl.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, content: 'v1 body' });
    expect(h.audit.withAction('prompt_template.create')).toHaveLength(1);
  });
});

describe('PromptLibrary visibility scoping (Req 10.2, 10.3 / Property 26)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('makes a public template available to other users in the Organization', async () => {
    const tmpl = await h.library.create(ctx, { title: 'Shared', content: 'C' }, 'user-1');
    await h.library.setVisibility(ctx, tmpl.id, 'public');

    const otherCtx: TenantContext = { organizationId: 'org-1', userId: 'user-2' };
    const visible = await h.library.listVisibleTo(otherCtx, 'user-2');
    expect(visible.map((t) => t.id)).toContain(tmpl.id);
    expect(await h.library.getForUser(otherCtx, tmpl.id, 'user-2')).not.toBeNull();
  });

  it('restricts a personal template to its owner only', async () => {
    const tmpl = await h.library.create(ctx, { title: 'Mine', content: 'C' }, 'user-1');
    // owner sees it
    const ownerVisible = await h.library.listVisibleTo(ctx, 'user-1');
    expect(ownerVisible.map((t) => t.id)).toContain(tmpl.id);

    // another user in the same org does not
    const otherCtx: TenantContext = { organizationId: 'org-1', userId: 'user-2' };
    const otherVisible = await h.library.listVisibleTo(otherCtx, 'user-2');
    expect(otherVisible.map((t) => t.id)).not.toContain(tmpl.id);
    expect(await h.library.getForUser(otherCtx, tmpl.id, 'user-2')).toBeNull();
  });

  it('records an audit event when visibility changes', async () => {
    const tmpl = await h.library.create(ctx, { title: 'T', content: 'C' });
    await h.library.setVisibility(ctx, tmpl.id, 'public');
    expect(h.audit.withAction('prompt_template.set_visibility')).toHaveLength(1);
  });

  it('throws when setting visibility on a missing template', async () => {
    await expect(h.library.setVisibility(ctx, 'nope', 'public')).rejects.toBeInstanceOf(
      PromptTemplateNotFoundError,
    );
  });
});

describe('PromptLibrary.fillVariables (Req 10.4)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('substitutes a complete variable map before use', async () => {
    const tmpl = await h.library.create(ctx, {
      title: 'T',
      content: 'Summarize {{topic}} for {{audience}}.',
    });
    const filled = await h.library.fillVariables(ctx, tmpl.id, {
      topic: 'pgvector',
      audience: 'execs',
    });
    expect(filled).toBe('Summarize pgvector for execs.');
    expect(filled).not.toMatch(/\{\{/);
  });

  it('rejects an incomplete variable map naming the unresolved variables', async () => {
    const tmpl = await h.library.create(ctx, {
      title: 'T',
      content: '{{a}} {{b}} {{c}}',
    });
    await expect(h.library.fillVariables(ctx, tmpl.id, { a: '1' })).rejects.toBeInstanceOf(
      MissingPromptVariablesError,
    );
    await expect(h.library.fillVariables(ctx, tmpl.id, { a: '1' })).rejects.toMatchObject({
      missing: ['b', 'c'],
    });
  });

  it('returns content unchanged when the template declares no variables', async () => {
    const tmpl = await h.library.create(ctx, { title: 'T', content: 'no vars' });
    expect(await h.library.fillVariables(ctx, tmpl.id, {})).toBe('no vars');
  });

  it('throws when filling a missing template', async () => {
    await expect(h.library.fillVariables(ctx, 'nope', {})).rejects.toBeInstanceOf(
      PromptTemplateNotFoundError,
    );
  });
});

describe('PromptLibrary.edit versioning (Req 10.5 / Property 25)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('increments the version and retains all prior versions', async () => {
    const tmpl = await h.library.create(ctx, { title: 'T', content: 'v1' });

    const afterFirst = await h.library.edit(ctx, tmpl.id, 'v2');
    expect(afterFirst.version).toBe(2);
    expect(afterFirst.content).toBe('v2');

    const afterSecond = await h.library.edit(ctx, tmpl.id, 'v3');
    expect(afterSecond.version).toBe(3);

    const versions = await h.library.listVersions(ctx, tmpl.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions.map((v) => v.content)).toEqual(['v1', 'v2', 'v3']);
    expect(h.audit.withAction('prompt_template.edit')).toHaveLength(2);
  });

  it('throws when editing a missing template', async () => {
    await expect(h.library.edit(ctx, 'nope', 'x')).rejects.toBeInstanceOf(
      PromptTemplateNotFoundError,
    );
  });
});

describe('PromptLibrary.recordUse (Req 10.6)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('increments the usage count on each use', async () => {
    const tmpl = await h.library.create(ctx, { title: 'T', content: 'C' });
    expect(await h.library.recordUse(ctx, tmpl.id)).toBe(1);
    expect(await h.library.recordUse(ctx, tmpl.id)).toBe(2);
    const reloaded = await h.library.get(ctx, tmpl.id);
    expect(reloaded?.usageCount).toBe(2);
  });

  it('throws when recording use of a missing template', async () => {
    await expect(h.library.recordUse(ctx, 'nope')).rejects.toBeInstanceOf(
      PromptTemplateNotFoundError,
    );
  });
});

describe('PromptLibrary.analytics (Req 10.7)', () => {
  it('reports most-used, highest-rated, and most-shared templates', async () => {
    const templates = new InMemoryPromptTemplateStore();
    const versions = new InMemoryPromptVersionStore(() => 'org-1');
    const audit = new CapturingAuditRecorder();
    const library = new PromptLibrary({ templates, versions, audit });

    templates.seed(
      makePromptTemplate({ id: 't1', title: 'A', usageCount: 5, ratingAvg: 2, shareCount: 1 }),
    );
    templates.seed(
      makePromptTemplate({ id: 't2', title: 'B', usageCount: 1, ratingAvg: 9, shareCount: 3 }),
    );
    templates.seed(
      makePromptTemplate({ id: 't3', title: 'C', usageCount: 3, ratingAvg: 4, shareCount: 8 }),
    );

    const report = await library.analytics(ctx, { organizationId: 'org-1' });

    expect(report.mostUsed.map((e) => e.templateId)).toEqual(['t1', 't3', 't2']);
    expect(report.highestRated.map((e) => e.templateId)).toEqual(['t2', 't3', 't1']);
    expect(report.mostShared.map((e) => e.templateId)).toEqual(['t3', 't2', 't1']);
    expect(report.mostUsed[0]).toMatchObject({ templateId: 't1', title: 'A', metric: 5 });
  });

  it('honors the per-list limit from the scope', async () => {
    const templates = new InMemoryPromptTemplateStore();
    const versions = new InMemoryPromptVersionStore(() => 'org-1');
    const audit = new CapturingAuditRecorder();
    const library = new PromptLibrary({ templates, versions, audit });

    for (let i = 0; i < 5; i += 1) {
      templates.seed(makePromptTemplate({ id: `t${i}`, usageCount: i }));
    }

    const report = await library.analytics(ctx, { organizationId: 'org-1', limit: 2 });
    expect(report.mostUsed).toHaveLength(2);
    expect(report.mostUsed.map((e) => e.templateId)).toEqual(['t4', 't3']);
  });
});
