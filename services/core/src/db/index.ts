/**
 * Primary_Database schema, migrations, and partition helpers (Req 44).
 *
 * The relational schema (organizations, teams, projects, users, memberships,
 * policies, conversations, messages, prompts, personas, artifacts, files,
 * knowledge collections/sources/documents/chunks, knowledge pages, channels,
 * channel messages, documents, agents/runs/steps, workflows, usage records,
 * API keys, and audit logs — Req 44.1) is defined as ordered, idempotent `.sql`
 * files under `./migrations` and applied by {@link applyMigrations}.
 *
 * `usage_records` is month-partitioned (Req 44.7); {@link createUsageRecordsPartitionSql}
 * and friends render the monthly-partition DDL from application code.
 */

export {
  MIGRATIONS_DIR,
  DEFAULT_MIGRATIONS_TABLE,
  loadMigrations,
  applyMigrations,
  type Migration,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult,
} from './migrations.js';

export {
  USAGE_RECORDS_TABLE,
  usageRecordsPartitionName,
  monthRange,
  createUsageRecordsPartitionSql,
  createUpcomingUsageRecordsPartitionsSql,
  type MonthRange,
} from './partitions.js';

/**
 * Row-Level Security session binding (Req 1.2, 1.4): bind a connection's
 * `app.current_organization_id` GUC so the policies from migration 0015 scope
 * every query to the caller's Organization (the database-enforcement arm of
 * tenant isolation that complements the application-layer repository scoping).
 */
export {
  TENANT_SETTING,
  InvalidTenantSettingError,
  setTenantSession,
  resetTenantSession,
  withTenantSession,
  type SetTenantSessionOptions,
} from './rls.js';
