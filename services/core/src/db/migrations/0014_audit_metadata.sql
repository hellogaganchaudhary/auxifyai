-- Migration 0014: audit log structured metadata
--
-- Adds an optional structured-context column to audit_logs so the Audit_Service
-- can attach domain context to a tracked action (e.g. the denial reason for an
-- access-control decision, or the source/destination Team of a project move)
-- without widening the fixed actor/action/resource/org/timestamp/IP/user-agent
-- shape (Req 37.1, 37.2). The column defaults to an empty JSON object so
-- existing rows and metadata-free appends remain valid.
--
-- Audit logs stay immutable (Req 37.3): the append-only guard triggers from
-- migration 0010 continue to block UPDATE/DELETE; this migration only adds a
-- column (DDL), it does not relax those guards.
--
-- Requirements: 37.1, 37.2, 44.1.

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
