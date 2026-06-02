/**
 * CLI to apply the Primary_Database migrations against a live PostgreSQL 16
 * instance (Req 44.1). Thin wrapper over {@link applyMigrations}: it opens a
 * single `pg` connection (the `pg.Client` `query(text, params)` signature
 * satisfies the {@link SqlClient} port used by the runner), applies every
 * pending migration in order, then pre-creates a window of upcoming monthly
 * `usage_records` partitions (Req 44.7).
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@localhost:5432/auxify \
 *     pnpm --filter @auxify/core db:migrate
 *
 * Optional env:
 *   PARTITION_MONTHS_AHEAD  number of future monthly partitions to pre-create
 *                           (default 3).
 *
 * Idempotent: re-running applies only migrations not yet recorded in the
 * `schema_migrations` ledger and creates only partitions that do not yet exist.
 */

import { Client } from 'pg';

import {
  applyMigrations,
  createUpcomingUsageRecordsPartitionsSql,
} from '../src/db/index.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required, e.g. postgres://user:pass@localhost:5432/auxify',
    );
  }

  const monthsAhead = Number.parseInt(
    process.env.PARTITION_MONTHS_AHEAD ?? '3',
    10,
  );

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await applyMigrations(client);
    if (result.applied.length > 0) {
      console.log(`Applied ${result.applied.length} migration(s):`);
      for (const id of result.applied) console.log(`  + ${id}`);
    } else {
      console.log('No pending migrations.');
    }
    if (result.skipped.length > 0) {
      console.log(`Skipped ${result.skipped.length} already-applied migration(s).`);
    }

    // Pre-create upcoming monthly usage_records partitions (Req 44.7).
    const now = new Date();
    const partitionSql = createUpcomingUsageRecordsPartitionsSql(
      now,
      Math.max(1, monthsAhead),
    );
    await client.query(partitionSql);
    console.log(`Ensured ${Math.max(1, monthsAhead)} monthly usage_records partition(s).`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
