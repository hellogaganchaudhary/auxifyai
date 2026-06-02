-- Migration 0011: Usage records (month-partitioned)
--
-- Usage records are the per-request cost/latency ledger driving analytics and
-- budgets (Req 31.1, 22.1). They are PARTITIONED BY RANGE on created_at by month
-- (Req 44.7) to preserve query performance over the 2-year retention window
-- (Req 22.6). Old months can be detached/dropped cheaply as a partition.
--
-- PostgreSQL requires the partition key to be part of every unique constraint /
-- primary key on a partitioned table, so the primary key is (id, created_at).
--
-- Monthly partitions are created with the create_usage_records_partition()
-- helper below (see also services/core/src/db/partitions.ts which renders the
-- same DDL from application code). One example partition for the migration's
-- own month is created up front; operations should pre-create upcoming months.
--
-- Requirements: 22.1, 22.6, 31.1, 44.7, 44.8.

CREATE TABLE IF NOT EXISTS usage_records (
  id              TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  organization_id TEXT        NOT NULL,
  team_id         TEXT        NOT NULL DEFAULT '',
  project_id      TEXT        NOT NULL DEFAULT '',
  user_id         TEXT        NOT NULL DEFAULT '',
  model           TEXT        NOT NULL DEFAULT '',
  provider        TEXT        NOT NULL DEFAULT '',
  input_tokens    INTEGER     NOT NULL DEFAULT 0,
  output_tokens   INTEGER     NOT NULL DEFAULT 0,
  cost            NUMERIC(18, 8) NOT NULL DEFAULT 0,
  latency_ms      INTEGER     NOT NULL DEFAULT 0,
  request_type    TEXT        NOT NULL DEFAULT '',
  tool_call_count INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS usage_records_organization_id_idx
  ON usage_records (organization_id);
CREATE INDEX IF NOT EXISTS usage_records_org_created_idx
  ON usage_records (organization_id, created_at);
CREATE INDEX IF NOT EXISTS usage_records_project_id_idx ON usage_records (project_id);
CREATE INDEX IF NOT EXISTS usage_records_team_id_idx ON usage_records (team_id);

-- Helper: create one monthly partition covering [month_start, month_start + 1 month).
-- Idempotent (CREATE TABLE IF NOT EXISTS). `p_month` may be any date/timestamp
-- within the target month; it is truncated to the first of the month.
--
-- Partition naming: usage_records_pYYYYMM (e.g. usage_records_p2026_06).
CREATE OR REPLACE FUNCTION create_usage_records_partition(p_month DATE)
  RETURNS void
  LANGUAGE plpgsql
AS $$
DECLARE
  start_date DATE := date_trunc('month', p_month)::date;
  end_date   DATE := (date_trunc('month', p_month) + INTERVAL '1 month')::date;
  part_name  TEXT := format('usage_records_p%s', to_char(start_date, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records '
    || 'FOR VALUES FROM (%L) TO (%L)',
    part_name, start_date, end_date
  );
END;
$$;

-- Example partition: provision the current month so inserts succeed immediately
-- after migration. A scheduled job (or ops runbook) should pre-create upcoming
-- months ahead of time using create_usage_records_partition().
SELECT create_usage_records_partition(date_trunc('month', now())::date);

-- A catch-all DEFAULT partition guarantees inserts never fail if a month's
-- partition is missing; rows can later be redistributed once the proper monthly
-- partition exists.
CREATE TABLE IF NOT EXISTS usage_records_default
  PARTITION OF usage_records DEFAULT;
