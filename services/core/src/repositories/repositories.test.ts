/**
 * Unit tests for the tenant-scoped repository layer (Req 1.2, 44.1).
 *
 * These prove, with a fake {@link SqlClient} that captures every issued SQL text
 * and its positional parameters, that:
 *   - every SELECT/UPDATE/DELETE carries the Organization predicate, and every
 *     INSERT sets or guards `organization_id`, so no operation is ever issued
 *     without tenant scoping;
 *   - the tenant predicate is bound to `ctx.organizationId` (parameterized, not
 *     interpolated);
 *   - omitting the tenant context is impossible by both type and runtime guard;
 *   - parent-scoped children (messages) can never attach to another tenant's
 *     conversation.
 *
 * The exhaustive over-all-inputs guarantee lives in the companion property test
 * (`tenant-scoping.property.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import {
  ConversationRepository,
  CrossTenantReferenceError,
  MessageRepository,
  MissingTenantContextError,
  TenantCrudRepository,
} from './index.js';

/** A single captured query: its SQL text and bound positional parameters. */
interface CapturedQuery {
  text: string;
  params: unknown[];
}

/**
 * A fake {@link SqlClient} that records every query and returns programmable
 * rows. The default response echoes the INSERT values so `RETURNING *` mappers
 * have something to map; tests can override per-call responses.
 */
class FakeSqlClient implements SqlClient {
  readonly queries: CapturedQuery[] = [];
  private responses: SqlRow[][] = [];

  /** Queue the rows returned by the next query (FIFO). */
  queueRows(rows: SqlRow[]): void {
    this.responses.push(rows);
  }

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ text, params });
    const rows = this.responses.shift();
    return { rows: rows ?? [] };
  }

  /** The most recently issued query. */
  get last(): CapturedQuery {
    const q = this.queries[this.queries.length - 1];
    if (q === undefined) throw new Error('no query captured');
    return q;
  }
}

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };
const otherOrgCtx: TenantContext = { organizationId: 'org-2', userId: 'user-2' };

function conversationRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
  return {
    id: 'conv-1',
    organization_id: 'org-1',
    project_id: 'proj-1',
    owner_id: 'user-1',
    title: 'Hello',
    folder_id: null,
    archived: false,
    share_token: null,
    share_mode: null,
    persona_id: null,
    active_model_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function messageRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
  return {
    id: 'msg-1',
    conversation_id: 'conv-1',
    parent_id: null,
    role: 'user',
    content: '[]',
    model: null,
    input_tokens: null,
    output_tokens: null,
    cost: null,
    latency_ms: null,
    rating: null,
    pinned: false,
    attachments: '[]',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ConversationRepository — direct `organization_id` scope.
// ---------------------------------------------------------------------------

describe('ConversationRepository (direct tenant scope)', () => {
  it('forces organization_id onto INSERT bound to the context org', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([conversationRow()]);
    const repo = new ConversationRepository(sql);

    await repo.create(ctx, { id: 'conv-1', projectId: 'proj-1', ownerId: 'user-1', title: 'Hi' });

    const { text, params } = sql.last;
    expect(text).toMatch(/^INSERT INTO conversations/);
    expect(text).toContain('organization_id');
    expect(text).toContain('RETURNING *');
    // organization_id is the first bound column and equals the context org.
    expect(params[0]).toBe('org-1');
  });

  it('ignores any caller-supplied organization_id and uses the context org', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([conversationRow()]);
    const repo = new ConversationRepository(sql);

    // Force a hostile organization_id through an untyped cast.
    await repo.create(ctx, {
      id: 'conv-1',
      projectId: 'proj-1',
      ownerId: 'user-1',
      // @ts-expect-error — organization_id is not part of the input by design.
      organization_id: 'org-EVIL',
    });

    expect(sql.last.params).toContain('org-1');
    expect(sql.last.params).not.toContain('org-EVIL');
  });

  it('injects organization_id = $1 first on findById', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([conversationRow()]);
    const repo = new ConversationRepository(sql);

    await repo.findById(ctx, 'conv-1');

    const { text, params } = sql.last;
    expect(text).toMatch(/WHERE organization_id = \$1/);
    expect(params[0]).toBe('org-1');
    expect(params).toContain('conv-1');
  });

  it('orders listByOwner by updated_at DESC within the tenant', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([conversationRow(), conversationRow({ id: 'conv-2' })]);
    const repo = new ConversationRepository(sql);

    await repo.listByOwner(ctx, 'user-1');

    const { text, params } = sql.last;
    expect(text).toContain('WHERE organization_id = $1');
    expect(text).toContain('owner_id = $2');
    expect(text).toContain('ORDER BY updated_at DESC');
    expect(params[0]).toBe('org-1');
  });

  it('scopes UPDATE by organization_id and never reassigns the tenant column', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([conversationRow({ title: 'Renamed' })]);
    const repo = new ConversationRepository(sql);

    await repo.update(ctx, 'conv-1', { title: 'Renamed' });

    const { text, params } = sql.last;
    expect(text).toMatch(/^UPDATE conversations SET/);
    expect(text).toContain('WHERE organization_id =');
    expect(text).toContain('RETURNING *');
    // organization_id must not appear in the SET clause.
    const setPortion = text.slice(text.indexOf('SET'), text.indexOf('WHERE'));
    expect(setPortion).not.toContain('organization_id');
    expect(params).toContain('org-1');
  });

  it('scopes DELETE by organization_id', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([{ id: 'conv-1' }]);
    const repo = new ConversationRepository(sql);

    const deleted = await repo.delete(ctx, 'conv-1');

    expect(deleted).toBe(true);
    expect(sql.last.text).toMatch(/^DELETE FROM conversations WHERE organization_id = \$1/);
    expect(sql.last.params[0]).toBe('org-1');
  });

  it('returns false from delete when no tenant-scoped row matched', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]);
    const repo = new ConversationRepository(sql);

    expect(await repo.delete(ctx, 'conv-x')).toBe(false);
  });

  it('does not see another organization rows (different bound org)', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]); // org-2 sees nothing for an org-1 row
    const repo = new ConversationRepository(sql);

    const found = await repo.findById(otherOrgCtx, 'conv-1');

    expect(found).toBeNull();
    expect(sql.last.params[0]).toBe('org-2');
  });
});

// ---------------------------------------------------------------------------
// MessageRepository — parent-derived scope through conversations.
// ---------------------------------------------------------------------------

describe('MessageRepository (parent tenant scope)', () => {
  it('guards INSERT with an EXISTS check against the parent tenant', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([messageRow()]);
    const repo = new MessageRepository(sql);

    await repo.create(ctx, { id: 'msg-1', conversationId: 'conv-1', role: 'user' });

    const { text, params } = sql.last;
    expect(text).toMatch(/^INSERT INTO messages/);
    expect(text).toContain('WHERE EXISTS (SELECT 1 FROM conversations');
    expect(text).toContain('organization_id =');
    expect(text).toContain('RETURNING *');
    expect(params).toContain('org-1');
    expect(params).toContain('conv-1');
  });

  it('throws CrossTenantReferenceError when the parent conversation is foreign', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]); // EXISTS guard matched nothing → no row returned
    const repo = new MessageRepository(sql);

    await expect(
      repo.create(otherOrgCtx, { id: 'msg-1', conversationId: 'conv-1', role: 'user' }),
    ).rejects.toBeInstanceOf(CrossTenantReferenceError);
  });

  it('injects the parent-subquery predicate on listByConversation', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([messageRow()]);
    const repo = new MessageRepository(sql);

    await repo.listByConversation(ctx, 'conv-1');

    const { text, params } = sql.last;
    expect(text).toContain(
      'conversation_id IN (SELECT id FROM conversations WHERE organization_id = $1)',
    );
    expect(text).toContain('ORDER BY created_at ASC');
    expect(params[0]).toBe('org-1');
  });

  it('scopes findById through the parent subquery', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([messageRow()]);
    const repo = new MessageRepository(sql);

    await repo.findById(ctx, 'msg-1');

    expect(sql.last.text).toContain(
      'conversation_id IN (SELECT id FROM conversations WHERE organization_id = $1)',
    );
    expect(sql.last.params[0]).toBe('org-1');
  });

  it('scopes UPDATE and DELETE through the parent subquery', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([messageRow({ rating: 'up' })]);
    const repo = new MessageRepository(sql);

    await repo.update(ctx, 'msg-1', { rating: 'up', pinned: true });
    expect(sql.last.text).toContain('WHERE conversation_id IN (SELECT id FROM conversations');
    expect(sql.last.text).toContain('RETURNING *');

    sql.queueRows([{ id: 'msg-1' }]);
    await repo.delete(ctx, 'msg-1');
    expect(sql.last.text).toMatch(/^DELETE FROM messages WHERE conversation_id IN/);
    expect(sql.last.params[0]).toBe('org-1');
  });

  it('round-trips content/attachments JSONB through create → map', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([
      messageRow({
        content: JSON.stringify([{ type: 'markdown', data: { text: 'hi' } }]),
        attachments: JSON.stringify([{ id: 'a1' }]),
        cost: '0.01234567',
        input_tokens: 10,
      }),
    ]);
    const repo = new MessageRepository(sql);

    const created = await repo.create(ctx, {
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: [{ type: 'markdown', data: { text: 'hi' } }],
      attachments: [{ id: 'a1' }],
      cost: 0.01234567,
      inputTokens: 10,
    });

    expect(created.content).toEqual([{ type: 'markdown', data: { text: 'hi' } }]);
    expect(created.attachments).toEqual([{ id: 'a1' }]);
    expect(created.cost).toBe(0.01234567);
    expect(created.inputTokens).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Generic TenantCrudRepository — direct and parent scope.
// ---------------------------------------------------------------------------

describe('TenantCrudRepository (generic, reusable by later tasks)', () => {
  it('injects organization_id on every operation for a direct-scoped table', async () => {
    const sql = new FakeSqlClient();
    const repo = new TenantCrudRepository(sql, { table: 'prompt_templates' });

    sql.queueRows([{ id: 'p1', organization_id: 'org-1', title: 'T' }]);
    await repo.create(ctx, { id: 'p1', title: 'T' });
    expect(sql.last.text).toMatch(/^INSERT INTO prompt_templates/);
    expect(sql.last.params[0]).toBe('org-1');

    sql.queueRows([{ id: 'p1' }]);
    await repo.findById(ctx, 'p1');
    expect(sql.last.text).toContain('WHERE organization_id = $1');

    sql.queueRows([{ id: 'p1' }]);
    await repo.list(ctx, { orderBy: 'created_at', direction: 'DESC', limit: 10 });
    expect(sql.last.text).toContain('WHERE organization_id = $1');
    expect(sql.last.text).toContain('ORDER BY created_at DESC');

    sql.queueRows([{ id: 'p1' }]);
    await repo.update(ctx, 'p1', { title: 'T2' });
    expect(sql.last.text).toContain('WHERE organization_id =');

    sql.queueRows([{ id: 'p1' }]);
    await repo.delete(ctx, 'p1');
    expect(sql.last.text).toMatch(/^DELETE FROM prompt_templates WHERE organization_id = \$1/);
  });

  it('supports a custom tenant column name', async () => {
    const sql = new FakeSqlClient();
    const repo = new TenantCrudRepository(sql, {
      table: 'audit_logs',
      scope: { kind: 'direct', column: 'org_id' },
    });

    sql.queueRows([{ id: 'a1' }]);
    await repo.findById(ctx, 'a1');
    expect(sql.last.text).toContain('WHERE org_id = $1');
  });

  it('supports a parent-derived scope for a child table', async () => {
    const sql = new FakeSqlClient();
    const repo = new TenantCrudRepository(sql, {
      table: 'message_reactions',
      scope: { kind: 'parent', foreignKey: 'message_id', parentTable: 'messages' },
    });

    sql.queueRows([{ id: 'r1' }]);
    await repo.list(ctx);
    expect(sql.last.text).toContain(
      'WHERE message_id IN (SELECT id FROM messages WHERE organization_id = $1)',
    );
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: a tenant context is mandatory at runtime, not just by type.
// ---------------------------------------------------------------------------

describe('tenant context is mandatory (fail-closed, Req 1.2)', () => {
  const missing: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['empty organizationId', { organizationId: '', userId: 'u' }],
    ['missing organizationId', { userId: 'u' }],
    ['empty userId', { organizationId: 'org-1', userId: '' }],
    ['non-object', 42],
  ];

  it.each(missing)('rejects create with %s context before issuing SQL', async (_label, bad) => {
    const sql = new FakeSqlClient();
    const repo = new ConversationRepository(sql);

    await expect(
      // Forge a bad context through `any` to model programmatic misuse.
      repo.create(bad as TenantContext, { id: 'c', projectId: 'p', ownerId: 'o' }),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
    // No SQL must have been issued.
    expect(sql.queries).toHaveLength(0);
  });

  it.each(missing)('rejects findById with %s context before issuing SQL', async (_label, bad) => {
    const sql = new FakeSqlClient();
    const repo = new MessageRepository(sql);

    await expect(repo.findById(bad as TenantContext, 'm')).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    expect(sql.queries).toHaveLength(0);
  });
});
