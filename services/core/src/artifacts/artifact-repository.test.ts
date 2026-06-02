/**
 * Unit tests for the tenant-scoped {@link ArtifactRepository} (Req 12.4, 1.2).
 *
 * Using a fake {@link SqlClient} that captures every issued SQL text and its
 * positional parameters, these prove that:
 *   - artifacts are scoped through their parent conversation — every
 *     SELECT/UPDATE carries the
 *     `conversation_id IN (SELECT id FROM conversations WHERE organization_id = $1)`
 *     predicate, and INSERT is guarded by an EXISTS check so an artifact can
 *     never attach to another tenant's conversation;
 *   - the version-on-every-write invariant holds: create appends a version-1
 *     row, and updateContent appends the next version row *before* advancing the
 *     head (Req 12.4);
 *   - artifact_versions reads resolve the parent artifact through the
 *     tenant-scoped query first, then list ascending by version.
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import { CrossTenantReferenceError } from '../repositories/index.js';
import { ArtifactRepository } from './artifact-repository.js';

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

function artifactRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
  return {
    id: 'art-1',
    conversation_id: 'conv-1',
    type: 'markdown',
    content: 'body',
    version: 1,
    shared_with: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function versionRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
  return {
    id: 'ver-1',
    artifact_id: 'art-1',
    version: 1,
    content: 'body',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ArtifactRepository.create (parent tenant scope through conversations)', () => {
  it('guards the artifact INSERT with an EXISTS check then appends the version-1 row', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([artifactRow()]); // artifact INSERT ... RETURNING *
    // version-1 INSERT returns nothing
    const repo = new ArtifactRepository(sql);

    const created = await repo.create(ctx, {
      id: 'art-1',
      versionId: 'ver-1',
      conversationId: 'conv-1',
      type: 'markdown',
      content: 'body',
    });

    const insert = sql.queries[0]!;
    expect(insert.text).toMatch(/^INSERT INTO artifacts/);
    expect(insert.text).toContain('WHERE EXISTS (SELECT 1 FROM conversations');
    expect(insert.text).toContain('organization_id =');
    expect(insert.text).toContain('RETURNING *');
    expect(insert.params).toContain('org-1');
    expect(insert.params).toContain('conv-1');

    const versionInsert = sql.queries[1]!;
    expect(versionInsert.text).toMatch(/^INSERT INTO artifact_versions/);
    expect(versionInsert.params).toEqual(['ver-1', 'art-1', 1, 'body']);

    expect(created).toMatchObject({
      id: 'art-1',
      conversationId: 'conv-1',
      type: 'markdown',
      content: 'body',
      version: 1,
      sharedWith: [],
    });
  });

  it('throws CrossTenantReferenceError when the parent conversation is foreign', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]); // EXISTS guard matched nothing
    const repo = new ArtifactRepository(sql);

    await expect(
      repo.create(ctx, {
        id: 'art-1',
        versionId: 'ver-1',
        conversationId: 'foreign',
        type: 'markdown',
        content: 'body',
      }),
    ).rejects.toBeInstanceOf(CrossTenantReferenceError);
  });
});

describe('ArtifactRepository reads carry the parent-tenant predicate', () => {
  it('findById scopes through the conversation subquery, org bound first', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([artifactRow()]);
    const repo = new ArtifactRepository(sql);

    const found = await repo.findById(ctx, 'art-1');

    const { text, params } = sql.last;
    expect(text).toContain(
      'conversation_id IN (SELECT id FROM conversations WHERE organization_id = $1)',
    );
    expect(params[0]).toBe('org-1');
    expect(params).toContain('art-1');
    expect(found?.id).toBe('art-1');
  });

  it('listByConversation orders newest-first within the tenant', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([artifactRow({ id: 'art-2' }), artifactRow({ id: 'art-1' })]);
    const repo = new ArtifactRepository(sql);

    const rows = await repo.listByConversation(ctx, 'conv-1');

    const { text, params } = sql.last;
    expect(text).toContain('organization_id = $1');
    expect(text).toContain('ORDER BY created_at DESC');
    expect(params[0]).toBe('org-1');
    expect(rows.map((r) => r.id)).toEqual(['art-2', 'art-1']);
  });

  it('parses a text[] shared_with literal into a string array', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([artifactRow({ shared_with: '{user-2,user-3}' })]);
    const repo = new ArtifactRepository(sql);

    const found = await repo.findById(ctx, 'art-1');
    expect(found?.sharedWith).toEqual(['user-2', 'user-3']);
  });
});

describe('ArtifactRepository.updateContent (version on every write, Req 12.4)', () => {
  it('appends the next version row before advancing the head version', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([artifactRow({ version: 1, content: 'v1' })]); // findById
    sql.queueRows([]); // version INSERT
    sql.queueRows([artifactRow({ version: 2, content: 'v2' })]); // UPDATE ... RETURNING *
    const repo = new ArtifactRepository(sql);

    const updated = await repo.updateContent(ctx, 'art-1', { versionId: 'ver-2', content: 'v2' });

    // Order: findById, version INSERT, UPDATE.
    const versionInsert = sql.queries[1]!;
    expect(versionInsert.text).toMatch(/^INSERT INTO artifact_versions/);
    expect(versionInsert.params).toEqual(['ver-2', 'art-1', 2, 'v2']);

    const update = sql.queries[2]!;
    expect(update.text).toMatch(/^UPDATE artifacts SET/);
    expect(update.text).toContain('content =');
    expect(update.text).toContain('version =');
    expect(update.text).toContain(
      'conversation_id IN (SELECT id FROM conversations WHERE organization_id =',
    );
    const setPortion = update.text.slice(update.text.indexOf('SET'), update.text.indexOf('WHERE'));
    expect(setPortion).not.toContain('conversation_id');

    expect(updated).toMatchObject({ version: 2, content: 'v2' });
  });

  it('returns null without writing a version when the artifact is not in the tenant', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]); // findById finds nothing
    const repo = new ArtifactRepository(sql);

    expect(
      await repo.updateContent(ctx, 'missing', { versionId: 'ver-2', content: 'x' }),
    ).toBeNull();
    // No version INSERT and no UPDATE were issued.
    expect(sql.queries.every((q) => !q.text.startsWith('INSERT INTO artifact_versions'))).toBe(
      true,
    );
    expect(sql.queries.every((q) => !q.text.startsWith('UPDATE artifacts'))).toBe(true);
  });
});

describe('ArtifactRepository.updateSharedWith (Req 12.6)', () => {
  it('updates only shared_with + updated_at, scoped to the tenant', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([artifactRow({ shared_with: '{user-2}' })]);
    const repo = new ArtifactRepository(sql);

    const updated = await repo.updateSharedWith(ctx, 'art-1', ['user-2']);

    const { text } = sql.last;
    expect(text).toMatch(/^UPDATE artifacts SET/);
    expect(text).toContain('shared_with =');
    const setPortion = text.slice(text.indexOf('SET'), text.indexOf('WHERE'));
    expect(setPortion).not.toContain('conversation_id');
    expect(updated?.sharedWith).toEqual(['user-2']);
  });
});

describe('ArtifactRepository version reads (scoped through the parent artifact)', () => {
  it('listVersions resolves the parent first then lists ascending by version', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([artifactRow()]); // findById
    sql.queueRows([versionRow({ version: 1 }), versionRow({ id: 'ver-2', version: 2 })]);
    const repo = new ArtifactRepository(sql);

    const versions = await repo.listVersions(ctx, 'art-1');

    // The parent artifact is resolved through the tenant-scoped query first.
    expect(sql.queries[0]!.text).toContain('SELECT * FROM artifacts');
    const { text, params } = sql.last;
    expect(text).toContain('SELECT * FROM artifact_versions WHERE artifact_id = $1');
    expect(text).toContain('ORDER BY version ASC');
    expect(params).toEqual(['art-1']);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it('listVersions returns [] without a version query when the artifact is foreign', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]); // findById finds nothing
    const repo = new ArtifactRepository(sql);

    expect(await repo.listVersions(ctx, 'foreign')).toEqual([]);
    expect(sql.queries.every((q) => !q.text.includes('FROM artifact_versions'))).toBe(true);
  });

  it('getVersion resolves the parent then fetches a single version', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([artifactRow()]); // findById
    sql.queueRows([versionRow({ version: 2, content: 'v2' })]);
    const repo = new ArtifactRepository(sql);

    const version = await repo.getVersion(ctx, 'art-1', 2);

    const { text, params } = sql.last;
    expect(text).toContain(
      'SELECT * FROM artifact_versions WHERE artifact_id = $1 AND version = $2',
    );
    expect(text).toContain('LIMIT 1');
    expect(params).toEqual(['art-1', 2]);
    expect(version).toMatchObject({ version: 2, content: 'v2' });
  });

  it('getVersion returns null when the artifact is foreign', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]); // findById finds nothing
    const repo = new ArtifactRepository(sql);

    expect(await repo.getVersion(ctx, 'foreign', 1)).toBeNull();
  });
});
