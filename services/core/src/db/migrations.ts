/**
 * Primary_Database migration loader and runner (Req 44.1, 44.8).
 *
 * The schema is defined as an ordered set of raw `.sql` files under
 * `./migrations`. Each file is:
 *   - **numbered** (`NNNN_name.sql`) so application order is deterministic, and
 *   - **idempotent** (`CREATE ... IF NOT EXISTS`, `CREATE OR REPLACE`, guarded
 *     triggers) so re-running a migration is a no-op.
 *
 * Migrations are applied through the same narrow {@link SqlClient} port used by
 * {@link PgVectorStore}, so the runner is driver-agnostic and unit-testable
 * without a live database. A `schema_migrations` ledger records which files have
 * been applied so a run only executes the pending tail of the list.
 *
 * A thin CLI wrapper that wires this runner to the `pg` driver lives at
 * `services/core/scripts/migrate.mjs`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SqlClient } from '../storage/pgvector.js';

/** Absolute path to the directory holding the ordered `.sql` migration files. */
export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/** Default name of the ledger table that records applied migrations. */
export const DEFAULT_MIGRATIONS_TABLE = 'schema_migrations';

/** A single migration: its ordered id, file name, and raw SQL body. */
export interface Migration {
  /** Numeric ordering key parsed from the file name (e.g. `1`, `12`). */
  readonly order: number;
  /** Stable identifier — the file name without extension (e.g. `0003_conversations_messages`). */
  readonly id: string;
  /** The migration file name (e.g. `0003_conversations_messages.sql`). */
  readonly fileName: string;
  /** The raw SQL body to execute. */
  readonly sql: string;
}

/** Matches `NNNN_some_name.sql` and captures the numeric prefix and the id. */
const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * Load all migration files from {@link MIGRATIONS_DIR} (or a supplied
 * directory), validated and sorted by their numeric prefix.
 *
 * Throws if a file name does not match the `NNNN_name.sql` convention or if two
 * files share the same numeric prefix, so ordering is always unambiguous.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const fileNames = readdirSync(dir).filter((name) => name.endsWith('.sql'));

  const migrations: Migration[] = [];
  const seenOrders = new Set<number>();

  for (const fileName of fileNames) {
    const match = MIGRATION_FILE_RE.exec(fileName);
    if (!match) {
      throw new Error(
        `Invalid migration file name "${fileName}"; expected NNNN_name.sql`,
      );
    }
    const order = Number.parseInt(match[1]!, 10);
    if (seenOrders.has(order)) {
      throw new Error(`Duplicate migration order ${order} (file "${fileName}")`);
    }
    seenOrders.add(order);

    migrations.push({
      order,
      id: fileName.slice(0, -'.sql'.length),
      fileName,
      sql: readFileSync(join(dir, fileName), 'utf8'),
    });
  }

  migrations.sort((a, b) => a.order - b.order);
  return migrations;
}

/** Options for {@link applyMigrations}. */
export interface ApplyMigrationsOptions {
  /** Directory to read migrations from. Defaults to {@link MIGRATIONS_DIR}. */
  dir?: string;
  /** Ledger table name. Defaults to {@link DEFAULT_MIGRATIONS_TABLE}. */
  migrationsTable?: string;
}

/** Result of an {@link applyMigrations} run. */
export interface ApplyMigrationsResult {
  /** Ids of migrations executed during this run, in application order. */
  applied: string[];
  /** Ids of migrations skipped because the ledger already recorded them. */
  skipped: string[];
}

/**
 * Apply every pending migration in order through the given {@link SqlClient}.
 *
 * The runner first ensures the ledger table exists, reads the set of
 * already-applied ids, then executes each remaining migration's full SQL body
 * (multi-statement, so dollar-quoted function/trigger bodies are preserved) and
 * records it in the ledger. Re-running after a completed run applies nothing.
 *
 * Pass a single dedicated connection (not a pool) so the optional surrounding
 * transaction semantics in the CLI behave as expected.
 */
export async function applyMigrations(
  client: SqlClient,
  options: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsResult> {
  const table = options.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE;
  const migrations = loadMigrations(options.dir);

  await client.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const existing = await client.query(`SELECT id FROM ${table}`);
  const appliedIds = new Set(existing.rows.map((row) => String(row.id)));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    await client.query(migration.sql);
    await client.query(`INSERT INTO ${table} (id) VALUES ($1)`, [migration.id]);
    applied.push(migration.id);
  }

  return { applied, skipped };
}
