/**
 * Tests for the database-enforcement arm of tenant isolation (Req 1.2, 1.4):
 *
 *   1. **Migration structure** — validate `0015_row_level_security.sql` as data:
 *      every tenant-scoped table ENABLEs *and* FORCEs RLS, has an idempotent
 *      policy (DROP POLICY IF EXISTS before CREATE POLICY) bound to the session
 *      GUC, and uses one consistent setting name. The Docker daemon may be down,
 *      so we never need a live database to assert the policy surface is complete.
 *   2. **Session helper** — unit + property tests for `rls.ts` against a fake
 *      {@link SqlClient}: it binds the correct GUC, fails closed on a missing
 *      context, rejects injection-unsafe ids, and wraps work in a transaction
 *      that commits on success and rolls back on failure.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { loadMigrations, type Migration } from './migrations.js';
import {
  InvalidTenantSettingError,
  resetTenantSession,
  setTenantSession,
  TENANT_SETTING,
  withTenantSession,
} from './rls.js';
import { MissingTenantContextError } from '../repositories/errors.js';
import type { SqlClient } from '../storage/pgvector.js';

/** The single RLS migration under test. */
function rlsMigration(): Migration {
  const found = loadMigrations().find((m) => m.id.endsWith('row_level_security'));
  if (!found) throw new Error('No 0015_row_level_security migration found');
  return found;
}

const rlsSql: string = rlsMigration().sql;

/**
 * Every tenant-scoped table that must be protected by RLS. `organizations` is
 * scoped by its own id; the rest carry `organization_id` directly or are scoped
 * through an ancestor that does.
 */
const TENANT_SCOPED_TABLES = [
  // Direct organization_id (and the organizations root).
  'organizations',
  'teams',
  'projects',
  'users',
  'memberships',
  'policies',
  'conversations',
  'prompt_templates',
  'files',
  'knowledge_collections',
  'knowledge_pages',
  'channels',
  'folders',
  'documents',
  'agents',
  'workflows',
  'api_keys',
  'audit_logs',
  'invitations',
  'usage_records',
  'vector_records',
  // Parent-scoped (no organization_id of their own).
  'messages',
  'prompt_versions',
  'artifacts',
  'artifact_versions',
  'knowledge_sources',
  'knowledge_documents',
  'knowledge_chunks',
  'page_versions',
  'page_comments',
  'channel_messages',
  'document_versions',
  'agent_runs',
  'agent_steps',
  'notifications',
  'personas',
] as const;

describe('0015 RLS migration — structure (Req 1.4)', () => {
  it('is registered as migration 0015, after the highest existing migration', () => {
    expect(rlsMigration().order).toBe(15);
  });

  it.each(TENANT_SCOPED_TABLES)('enables ROW LEVEL SECURITY on %s', (table) => {
    expect(rlsSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
  });

  it.each(TENANT_SCOPED_TABLES)('forces ROW LEVEL SECURITY on %s', (table) => {
    // FORCE makes the policy apply even to the table owner the app connects as,
    // so isolation cannot be silently bypassed by normal traffic.
    expect(rlsSql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  });

  it.each(TENANT_SCOPED_TABLES)('creates an isolation policy for %s', (table) => {
    expect(rlsSql).toContain(`CREATE POLICY ${table}_tenant_isolation ON ${table}`);
  });

  it.each(TENANT_SCOPED_TABLES)(
    'guards %s policy with DROP POLICY IF EXISTS (idempotent re-run)',
    (table) => {
      expect(rlsSql).toContain(
        `DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};`,
      );
    },
  );

  it('binds every policy to the one consistent session GUC', () => {
    // The migration must reference exactly the setting the helper sets, and no
    // other ad-hoc setting name.
    const gucRefs = rlsSql.match(/current_setting\('([^']+)', true\)/g) ?? [];
    expect(gucRefs.length).toBeGreaterThan(0);
    for (const ref of gucRefs) {
      expect(ref).toContain(TENANT_SETTING);
    }
  });

  it('uses the missing-ok form of current_setting so an unbound session fails closed', () => {
    // current_setting(name, true) returns NULL (not an error) when unset, so a
    // connection that never binds a tenant sees no rows.
    expect(rlsSql).not.toMatch(/current_setting\('app\.current_organization_id'\)/);
    expect(rlsSql).toContain(`current_setting('${TENANT_SETTING}', true)`);
  });

  it('gives each policy both a USING and a WITH CHECK clause (reads and writes scoped)', () => {
    const using = rlsSql.match(/USING \(/g) ?? [];
    const withCheck = rlsSql.match(/WITH CHECK \(/g) ?? [];
    expect(using.length).toBe(TENANT_SCOPED_TABLES.length);
    expect(withCheck.length).toBe(TENANT_SCOPED_TABLES.length);
  });

  it('scopes organizations by their own id, not a missing organization_id column', () => {
    // organizations has no organization_id column; it is scoped by its own id.
    expect(rlsSql).toContain('CREATE POLICY organizations_tenant_isolation ON organizations');
    expect(rlsSql).toMatch(
      /organizations_tenant_isolation[\s\S]*?USING \(id = current_setting\('app\.current_organization_id', true\)\)/,
    );
  });

  it('scopes messages through their parent conversation (no organization_id column)', () => {
    expect(rlsSql).toMatch(
      /messages_tenant_isolation[\s\S]*conversation_id IN \(\s*SELECT id FROM conversations/,
    );
  });

  it('scopes personas to allow the shared NULL-owner catalogue plus per-tenant user personas', () => {
    expect(rlsSql).toMatch(/personas_tenant_isolation[\s\S]*owner_id IS NULL/);
  });
});

/** A fake SqlClient that records the statements and params issued against it. */
function fakeClient(): {
  client: SqlClient;
  calls: { text: string; params?: unknown[] }[];
} {
  const calls: { text: string; params?: unknown[] }[] = [];
  const client: SqlClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rows: [] };
    }),
  };
  return { client, calls };
}

const ctx: TenantContext = { organizationId: 'org_123', userId: 'user_1' };

describe('setTenantSession (Req 1.2, 1.4)', () => {
  it('binds the tenant GUC transaction-locally via set_config by default', async () => {
    const { client, calls } = fakeClient();
    await setTenantSession(client, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('set_config($1, $2, $3)');
    expect(calls[0]!.params).toEqual([TENANT_SETTING, 'org_123', true]);
  });

  it('binds session-wide when local is false', async () => {
    const { client, calls } = fakeClient();
    await setTenantSession(client, ctx, { local: false });
    expect(calls[0]!.params).toEqual([TENANT_SETTING, 'org_123', false]);
  });

  it('fails closed on a missing tenant context (no SQL issued)', async () => {
    const { client, calls } = fakeClient();
    await expect(
      setTenantSession(client, undefined as unknown as TenantContext),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
    expect(calls).toHaveLength(0);
  });

  it('rejects an injection-unsafe organization id before issuing SQL', async () => {
    const { client, calls } = fakeClient();
    const evil: TenantContext = {
      organizationId: "org'; DROP TABLE users; --",
      userId: 'user_1',
    };
    await expect(setTenantSession(client, evil)).rejects.toBeInstanceOf(
      InvalidTenantSettingError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('resetTenantSession', () => {
  it('issues RESET for the tenant setting', async () => {
    const { client, calls } = fakeClient();
    await resetTenantSession(client);
    expect(calls[0]!.text).toBe(`RESET ${TENANT_SETTING}`);
  });
});

describe('withTenantSession', () => {
  it('opens a transaction, binds the tenant, runs work, and commits', async () => {
    const { client, calls } = fakeClient();
    const result = await withTenantSession(client, ctx, async () => 'done');

    expect(result).toBe('done');
    const texts = calls.map((c) => c.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts.some((t) => t.includes('set_config'))).toBe(true);
    expect(texts.at(-1)).toBe('COMMIT');
    expect(texts).not.toContain('ROLLBACK');
  });

  it('rolls back and re-throws when the work fails', async () => {
    const { client, calls } = fakeClient();
    const boom = new Error('work failed');

    await expect(
      withTenantSession(client, ctx, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const texts = calls.map((c) => c.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
  });

  it('never opens a transaction for an invalid context', async () => {
    const { client, calls } = fakeClient();
    await expect(
      withTenantSession(client, { organizationId: '', userId: 'u' }, async () => 1),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
    expect(calls).toHaveLength(0);
  });
});

describe('setTenantSession — property: safe ids bind verbatim, unsafe ids are refused', () => {
  it('binds any [A-Za-z0-9_-] org id as the set_config value parameter', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9_-]+$/),
        async (organizationId) => {
          const { client, calls } = fakeClient();
          await setTenantSession(client, { organizationId, userId: 'u' });
          // The id is always bound as a positional parameter (never concatenated)
          // and round-trips unchanged.
          expect(calls[0]!.params).toEqual([TENANT_SETTING, organizationId, true]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses any org id containing a character outside the safe set', async () => {
    await fc.assert(
      fc.asyncProperty(
        // At least one disallowed character (quote, space, semicolon, etc.).
        fc
          .string({ minLength: 1 })
          .filter((s) => !/^[A-Za-z0-9_-]+$/.test(s)),
        async (organizationId) => {
          const { client, calls } = fakeClient();
          await expect(
            setTenantSession(client, { organizationId, userId: 'u' }),
          ).rejects.toBeInstanceOf(InvalidTenantSettingError);
          // Fail-closed: nothing is ever sent to the database.
          expect(calls).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
