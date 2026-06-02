/**
 * Unit tests for the tenant-scoped Prompt_Library repositories (Req 10, 1.2).
 *
 * Using a fake {@link SqlClient} that captures every issued SQL text and its
 * positional parameters, these prove that:
 *   - every SELECT/UPDATE carries the Organization predicate, and every INSERT
 *     sets/guards the tenant, so no operation is issued without tenant scoping;
 *   - `listVisibleTo` binds the Organization predicate FIRST, then the
 *     `(visibility = 'public' OR owner_id = $user)` disjunction, so the OR can
 *     never reach across tenants (Property 26 foundation);
 *   - `prompt_versions` is scoped through its parent template via the
 *     EXISTS/subquery guards (Req 10.5).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import { CrossTenantReferenceError } from '../repositories/index.js';
import { PromptTemplateRepository, PromptVersionRepository } from './prompt-repository.js';

interface CapturedQuery {
  text: string;
  params: unknown[];
}

class FakeSqlClient implements SqlClient {
  readonly queries: CapturedQuery[] = [];
  private responses: SqlRow[][] = [];

  queueRows(rows: SqlRow[]): void {
    this.responses.push(rows);
  }

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ text, params });
    return { rows: this.responses.shift() ?? [] };
  }

  get last(): CapturedQuery {
    const q = this.queries[this.queries.length - 1];
    if (q === undefined) throw new Error('no query captured');
    return q;
  }
}

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };

function templateRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
  return {
    id: 'tmpl-1',
    owner_id: 'user-1',
    organization_id: 'org-1',
    title: 'Title',
    content: 'Body',
    category: 'general',
    tags: ['a', 'b'],
    visibility: 'personal',
    version: 1,
    usage_count: 0,
    rating_avg: 0,
    share_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function versionRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
  return {
    id: 'ver-1',
    template_id: 'tmpl-1',
    version: 1,
    content: 'Body',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PromptTemplateRepository (direct tenant scope)', () => {
  it('forces organization_id onto INSERT and maps the returned row', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([templateRow()]);
    const repo = new PromptTemplateRepository(sql);

    const created = await repo.create(ctx, {
      id: 'tmpl-1',
      ownerId: 'user-1',
      title: 'Title',
      content: 'Body',
      category: 'general',
      tags: ['a', 'b'],
      visibility: 'personal',
    });

    expect(sql.last.text).toMatch(/^INSERT INTO prompt_templates/);
    expect(sql.last.text).toContain('organization_id');
    expect(sql.last.text).toContain('RETURNING *');
    expect(sql.last.params[0]).toBe('org-1');
    expect(created).toMatchObject({
      id: 'tmpl-1',
      ownerId: 'user-1',
      organizationId: 'org-1',
      tags: ['a', 'b'],
      visibility: 'personal',
      version: 1,
      usageCount: 0,
    });
  });

  it('injects organization_id = $1 first on findById', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([templateRow()]);
    const repo = new PromptTemplateRepository(sql);

    await repo.findById(ctx, 'tmpl-1');

    expect(sql.last.text).toMatch(/WHERE organization_id = \$1/);
    expect(sql.last.params[0]).toBe('org-1');
    expect(sql.last.params).toContain('tmpl-1');
  });

  it('listVisibleTo binds org first then the public-or-owner disjunction', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([templateRow()]);
    const repo = new PromptTemplateRepository(sql);

    await repo.listVisibleTo(ctx, 'user-7');

    const { text, params } = sql.last;
    expect(text).toContain('WHERE organization_id = $1');
    expect(text).toContain("(visibility = 'public' OR owner_id = $2)");
    expect(text).toContain('ORDER BY created_at DESC');
    // org bound first, owner second — disjunction cannot escape the tenant.
    expect(params[0]).toBe('org-1');
    expect(params[1]).toBe('user-7');
  });

  it('scopes UPDATE by organization_id and never reassigns the tenant column', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([templateRow({ visibility: 'public' })]);
    const repo = new PromptTemplateRepository(sql);

    await repo.update(ctx, 'tmpl-1', { visibility: 'public' });

    const { text } = sql.last;
    expect(text).toMatch(/^UPDATE prompt_templates SET/);
    expect(text).toContain('WHERE organization_id =');
    const setPortion = text.slice(text.indexOf('SET'), text.indexOf('WHERE'));
    expect(setPortion).not.toContain('organization_id');
  });

  it('returns null from update when no tenant-scoped row matched', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]);
    const repo = new PromptTemplateRepository(sql);

    expect(await repo.update(ctx, 'missing', { content: 'x' })).toBeNull();
  });
});

describe('PromptVersionRepository (parent tenant scope through prompt_templates)', () => {
  it('guards INSERT with an EXISTS check against the parent template tenant', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([versionRow()]);
    const repo = new PromptVersionRepository(sql);

    await repo.append(ctx, { id: 'ver-1', templateId: 'tmpl-1', version: 1, content: 'Body' });

    const { text, params } = sql.last;
    expect(text).toMatch(/^INSERT INTO prompt_versions/);
    expect(text).toContain('WHERE EXISTS (SELECT 1 FROM prompt_templates');
    expect(text).toContain('organization_id =');
    expect(text).toContain('RETURNING *');
    expect(params).toContain('org-1');
    expect(params).toContain('tmpl-1');
  });

  it('throws CrossTenantReferenceError when the parent template is foreign', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]); // EXISTS guard matched nothing
    const repo = new PromptVersionRepository(sql);

    await expect(
      repo.append(ctx, { id: 'ver-1', templateId: 'tmpl-x', version: 1, content: 'Body' }),
    ).rejects.toBeInstanceOf(CrossTenantReferenceError);
  });

  it('scopes listByTemplate through the parent subquery, ascending by version', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([versionRow({ version: 1 }), versionRow({ id: 'ver-2', version: 2 })]);
    const repo = new PromptVersionRepository(sql);

    const versions = await repo.listByTemplate(ctx, 'tmpl-1');

    const { text, params } = sql.last;
    expect(text).toContain(
      'template_id IN (SELECT id FROM prompt_templates WHERE organization_id = $1)',
    );
    expect(text).toContain('ORDER BY version ASC');
    expect(params[0]).toBe('org-1');
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
});
