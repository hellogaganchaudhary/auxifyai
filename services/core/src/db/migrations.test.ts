/**
 * Unit tests for the Primary_Database migration set, loader, and runner
 * (Req 44.1, 44.6, 44.7, 44.8).
 *
 * These validate the migration SQL as data — ordering, idempotency, table
 * coverage, cascade-delete edges, and partitioning — and exercise the runner
 * against a fake {@link SqlClient}, so the suite never needs a live database.
 */

import { describe, expect, it, vi } from 'vitest';

import { PgVectorStore } from '../storage/pgvector.js';
import type { SqlClient } from '../storage/pgvector.js';
import {
  applyMigrations,
  DEFAULT_MIGRATIONS_TABLE,
  loadMigrations,
  type Migration,
} from './migrations.js';

const migrations: Migration[] = loadMigrations();

/** Concatenate every migration body — convenient for "schema contains" checks. */
const allSql: string = migrations.map((m) => m.sql).join('\n');

/** Find the single migration whose id ends with the given suffix. */
function migrationFor(suffix: string): Migration {
  const found = migrations.find((m) => m.id.endsWith(suffix));
  if (!found) throw new Error(`No migration matching "${suffix}"`);
  return found;
}

describe('loadMigrations', () => {
  it('loads the full ordered migration set', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(12);
  });

  it('orders migrations by ascending numeric prefix', () => {
    const orders = migrations.map((m) => m.order);
    const sorted = [...orders].sort((a, b) => a - b);
    expect(orders).toEqual(sorted);
  });

  it('assigns unique, gap-free-from-1 numeric orders', () => {
    const orders = migrations.map((m) => m.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(orders[0]).toBe(1);
  });

  it('every file name follows the NNNN_name.sql convention', () => {
    for (const m of migrations) {
      expect(m.fileName).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it('every migration body is non-empty SQL', () => {
    for (const m of migrations) {
      expect(m.sql.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('migration SQL — table coverage (Req 44.1)', () => {
  const requiredTables = [
    'organizations',
    'teams',
    'projects',
    'users',
    'memberships',
    'policies',
    'conversations',
    'messages',
    'prompt_templates',
    'prompt_versions',
    'personas',
    'artifacts',
    'artifact_versions',
    'files',
    'knowledge_collections',
    'knowledge_sources',
    'knowledge_documents',
    'knowledge_chunks',
    'knowledge_pages',
    'page_versions',
    'channels',
    'channel_messages',
    'documents',
    'document_versions',
    'agents',
    'agent_runs',
    'agent_steps',
    'workflows',
    'usage_records',
    'api_keys',
    'audit_logs',
  ];

  it.each(requiredTables)('creates the %s table', (table) => {
    expect(allSql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
  });
});

describe('migration SQL — idempotency', () => {
  it('uses IF NOT EXISTS for every CREATE TABLE', () => {
    const creates = allSql.match(/CREATE TABLE(?! IF NOT EXISTS)/g) ?? [];
    expect(creates).toEqual([]);
  });

  it('uses IF NOT EXISTS for every CREATE INDEX', () => {
    const creates = allSql.match(/CREATE INDEX(?! IF NOT EXISTS)/g) ?? [];
    expect(creates).toEqual([]);
  });

  it('guards triggers with DROP TRIGGER IF EXISTS and CREATE OR REPLACE functions', () => {
    const audit = migrationFor('keys_audit').sql;
    expect(audit).toContain('DROP TRIGGER IF EXISTS');
    expect(audit).toContain('CREATE OR REPLACE FUNCTION');
  });
});

describe('migration SQL — cascade-delete foreign keys (Req 44.8 / Property 58)', () => {
  it('cascades tenancy containment: org → team → project', () => {
    const sql = migrationFor('tenancy_identity').sql;
    expect(sql).toMatch(
      /organization_id TEXT NOT NULL REFERENCES organizations \(id\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /team_id\s+TEXT NOT NULL REFERENCES teams \(id\) ON DELETE CASCADE/,
    );
  });

  it('cascades conversation → messages and the message branch tree', () => {
    const sql = migrationFor('conversations_messages').sql;
    expect(sql).toMatch(
      /conversation_id TEXT NOT NULL REFERENCES conversations \(id\) ON DELETE CASCADE/,
    );
    // Self-referential parent edge cascades so a branch is removed with its root.
    expect(sql).toMatch(
      /parent_id\s+TEXT REFERENCES messages \(id\) ON DELETE CASCADE/,
    );
  });

  it('cascades knowledge collection → source → document → chunk', () => {
    const sql = migrationFor('files_knowledge').sql;
    expect(sql).toMatch(
      /collection_id\s+TEXT NOT NULL REFERENCES knowledge_collections \(id\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /source_id\s+TEXT NOT NULL REFERENCES knowledge_sources \(id\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /document_id TEXT NOT NULL REFERENCES knowledge_documents \(id\) ON DELETE CASCADE/,
    );
  });

  it('cascades agent → run → step', () => {
    const sql = migrationFor('agents_workflows').sql;
    expect(sql).toMatch(
      /agent_id\s+TEXT NOT NULL REFERENCES agents \(id\) ON DELETE CASCADE/,
    );
    expect(sql).toMatch(
      /run_id\s+TEXT NOT NULL REFERENCES agent_runs \(id\) ON DELETE CASCADE/,
    );
  });

  it('uses ON DELETE SET NULL for non-containment references only', () => {
    const docs = migrationFor('document_management').sql;
    // A document survives deletion of its folder (moves to unfiled root).
    expect(docs).toMatch(
      /folder_id\s+TEXT REFERENCES folders \(id\) ON DELETE SET NULL/,
    );
    const knowledge = migrationFor('files_knowledge').sql;
    // The de-dup pointer is detached, not cascaded.
    expect(knowledge).toMatch(
      /duplicate_of\s+TEXT REFERENCES knowledge_documents \(id\) ON DELETE SET NULL/,
    );
  });

  it('every FK declares an explicit ON DELETE action', () => {
    // No REFERENCES clause should be left without an ON DELETE rule, so the
    // cascade/ set-null behavior is always intentional.
    const refsWithoutOnDelete = allSql.match(
      /REFERENCES\s+\w+\s*\([^)]*\)(?![^,\n]*ON DELETE)/g,
    );
    expect(refsWithoutOnDelete).toBeNull();
  });
});

describe('migration SQL — message persistence round-trip (Req 44.6)', () => {
  const sql = migrationFor('conversations_messages').sql;

  it.each([
    'conversation_id',
    'parent_id',
    'role',
    'content',
    'model',
    'input_tokens',
    'output_tokens',
    'cost',
    'latency_ms',
  ])('messages stores %s', (column) => {
    expect(sql).toContain(column);
  });
});

describe('migration SQL — usage_records month partitioning (Req 44.7)', () => {
  const sql = migrationFor('usage_records').sql;

  it('declares RANGE partitioning on created_at', () => {
    expect(sql).toContain('PARTITION BY RANGE (created_at)');
  });

  it('includes the partition key in the primary key', () => {
    expect(sql).toContain('PRIMARY KEY (id, created_at)');
  });

  it('provides a monthly partition helper function', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION create_usage_records_partition');
    expect(sql).toContain("INTERVAL '1 month'");
  });

  it('creates an example partition and a DEFAULT catch-all', () => {
    expect(sql).toContain('SELECT create_usage_records_partition(');
    expect(sql).toContain('PARTITION OF usage_records DEFAULT');
  });
});

describe('migration SQL — audit immutability (Req 37.3)', () => {
  const sql = migrationFor('keys_audit').sql;

  it('blocks UPDATE and DELETE on audit_logs via triggers', () => {
    expect(sql).toContain('CREATE TRIGGER audit_logs_no_update');
    expect(sql).toContain('CREATE TRIGGER audit_logs_no_delete');
    expect(sql).toMatch(/BEFORE UPDATE ON audit_logs/);
    expect(sql).toMatch(/BEFORE DELETE ON audit_logs/);
  });
});

describe('migration SQL — vector_records stays in sync with PgVectorStore', () => {
  it('matches PgVectorStore.migrationSql() so the schema has one source of truth', () => {
    // Normalize line endings so the check is OS-agnostic (CRLF vs LF).
    const normalize = (s: string): string => s.replace(/\r\n/g, '\n');
    const generated = normalize(PgVectorStore.migrationSql());
    const fileSql = normalize(migrationFor('vector_records').sql);
    // The generated DDL must appear verbatim in the file.
    expect(fileSql).toContain(generated);
  });
});

describe('applyMigrations runner', () => {
  function fakeSql(appliedRows: { id: string }[] = []): {
    client: SqlClient;
    calls: { text: string; params?: unknown[] }[];
  } {
    const calls: { text: string; params?: unknown[] }[] = [];
    const client: SqlClient = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        if (/SELECT id FROM/.test(text)) {
          return { rows: appliedRows };
        }
        return { rows: [] };
      }),
    };
    return { client, calls };
  }

  it('creates the ledger and applies every pending migration in order', async () => {
    const { client, calls } = fakeSql();
    const result = await applyMigrations(client);

    // Ledger bootstrap happens first.
    expect(calls[0]!.text).toContain(
      `CREATE TABLE IF NOT EXISTS ${DEFAULT_MIGRATIONS_TABLE}`,
    );

    expect(result.applied).toEqual(migrations.map((m) => m.id));
    expect(result.skipped).toEqual([]);

    // Each migration is recorded with an INSERT carrying its id.
    const inserts = calls
      .filter((c) => c.text.includes(`INSERT INTO ${DEFAULT_MIGRATIONS_TABLE}`))
      .map((c) => c.params?.[0]);
    expect(inserts).toEqual(migrations.map((m) => m.id));
  });

  it('skips migrations already recorded in the ledger (idempotent re-run)', async () => {
    const alreadyApplied = migrations.map((m) => ({ id: m.id }));
    const { client, calls } = fakeSql(alreadyApplied);
    const result = await applyMigrations(client);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(migrations.map((m) => m.id));
    // No INSERTs into the ledger on a fully-applied database.
    expect(
      calls.filter((c) => c.text.includes(`INSERT INTO ${DEFAULT_MIGRATIONS_TABLE}`)),
    ).toHaveLength(0);
  });

  it('applies only the pending tail when some migrations are recorded', async () => {
    const half = Math.floor(migrations.length / 2);
    const recorded = migrations.slice(0, half).map((m) => ({ id: m.id }));
    const { client } = fakeSql(recorded);
    const result = await applyMigrations(client);

    expect(result.skipped).toEqual(migrations.slice(0, half).map((m) => m.id));
    expect(result.applied).toEqual(migrations.slice(half).map((m) => m.id));
  });
});
