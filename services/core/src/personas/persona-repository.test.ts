/**
 * Unit tests for the owner-scoped {@link PersonaRepository} (Req 9.4).
 *
 * With a fake {@link SqlClient} that captures every issued SQL text and its
 * positional parameters, these prove that:
 *   - INSERT forces `owner_id` to the acting user (`ctx.userId`), parameterized;
 *   - SELECT-by-id and list constrain on `owner_id`, so a user can never read
 *     another user's custom personas;
 *   - the `variables` JSONB column round-trips (written as a JSON string, read
 *     back from either a parsed array or a JSON string);
 *   - a missing tenant context fails closed.
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { MissingTenantContextError } from '../repositories/index.js';
import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import { PersonaRepository } from './persona-repository.js';
import type { PersonaRecord } from './types.js';

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
    const rows = this.responses.shift();
    return { rows: rows ?? [] };
  }

  get last(): CapturedQuery {
    const q = this.queries[this.queries.length - 1];
    if (q === undefined) throw new Error('no query captured');
    return q;
  }
}

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };

function personaRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
  return {
    id: 'persona-custom-1',
    owner_id: 'user-1',
    name: 'Mine',
    category: 'custom',
    system_prompt: 'You are mine.',
    is_default: false,
    variables: '[]',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function record(overrides: Partial<PersonaRecord> = {}): PersonaRecord {
  return {
    id: 'persona-custom-1',
    ownerId: 'user-1',
    name: 'Mine',
    category: 'custom',
    systemPrompt: 'You are mine.',
    isDefault: false,
    variables: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PersonaRepository (owner scope, Req 9.4)', () => {
  it('forces owner_id onto INSERT bound to the context user', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([personaRow()]);
    const repo = new PersonaRepository(sql);

    await repo.create(ctx, record({ variables: [{ name: 'tone', defaultValue: 'friendly' }] }));

    const { text, params } = sql.last;
    expect(text).toContain('INSERT INTO personas');
    expect(text).toContain('owner_id');
    // owner_id is the 2nd column; its value is the acting user, parameterized.
    expect(params).toContain('user-1');
    // variables are serialized to a JSON string.
    expect(params.some((p) => typeof p === 'string' && p.includes('"tone"'))).toBe(true);
  });

  it('scopes findById on owner_id', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([personaRow()]);
    const repo = new PersonaRepository(sql);

    const found = await repo.findById(ctx, 'persona-custom-1');

    const { text, params } = sql.last;
    expect(text).toContain('owner_id =');
    expect(params).toEqual(['persona-custom-1', 'user-1']);
    expect(found?.id).toBe('persona-custom-1');
  });

  it('returns null when no owner-scoped row matches', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([]);
    const repo = new PersonaRepository(sql);
    expect(await repo.findById(ctx, 'nope')).toBeNull();
  });

  it('scopes listOwned on owner_id and parses variables from a parsed array', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([
      personaRow({
        variables: [{ name: 'x', required: true, description: 'd', defaultValue: 'v' }],
      }),
    ]);
    const repo = new PersonaRepository(sql);

    const rows = await repo.listOwned(ctx);

    const { text, params } = sql.last;
    expect(text).toContain('WHERE owner_id =');
    expect(params).toEqual(['user-1']);
    expect(rows[0]?.variables).toEqual([
      { name: 'x', required: true, description: 'd', defaultValue: 'v' },
    ]);
  });

  it('parses variables from a JSON string column', async () => {
    const sql = new FakeSqlClient();
    sql.queueRows([personaRow({ variables: '[{"name":"y"}]' })]);
    const repo = new PersonaRepository(sql);
    const found = await repo.findById(ctx, 'persona-custom-1');
    expect(found?.variables).toEqual([{ name: 'y' }]);
  });

  it('fails closed without a tenant context', async () => {
    const sql = new FakeSqlClient();
    const repo = new PersonaRepository(sql);
    await expect(repo.findById(undefined as unknown as TenantContext, 'x')).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    expect(sql.queries).toHaveLength(0);
  });
});
