-- Migration 0009: Agents, runs, steps, workflows
--
-- Agents are Project-scoped. A run records aggregate metrics and a terminal
-- status; each step records the tool invocation and whether it was denied
-- (Req 15.x, 16.x). Workflows are Project-scoped step graphs (Req 17.x).
--
-- Requirements: 15.x, 16.x, 17.x, 44.8.

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  system_prompt   TEXT        NOT NULL DEFAULT '',
  allowed_tools   TEXT[]      NOT NULL DEFAULT '{}',
  model           TEXT        NOT NULL DEFAULT '',
  safety_limits   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  template_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_organization_id_idx ON agents (organization_id);
CREATE INDEX IF NOT EXISTS agents_project_id_idx ON agents (project_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN (
                        'running', 'completed', 'cancelled',
                        'stopped_step_limit', 'stopped_time_limit',
                        'stopped_budget_cap', 'failed'
                      )),
  total_steps       INTEGER     NOT NULL DEFAULT 0,
  total_tokens      INTEGER     NOT NULL DEFAULT 0,
  total_cost        NUMERIC(18, 8) NOT NULL DEFAULT 0,
  total_duration_ms INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_agent_id_idx ON agent_runs (agent_id);

CREATE TABLE IF NOT EXISTS agent_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  step_number INTEGER     NOT NULL,
  tool        TEXT        NOT NULL DEFAULT '',
  input       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  output      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  duration_ms INTEGER     NOT NULL DEFAULT 0,
  denied      BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_steps_run_step_unique UNIQUE (run_id, step_number)
);
CREATE INDEX IF NOT EXISTS agent_steps_run_id_idx ON agent_steps (run_id);

CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  steps           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  cadence         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflows_organization_id_idx ON workflows (organization_id);
CREATE INDEX IF NOT EXISTS workflows_project_id_idx ON workflows (project_id);
