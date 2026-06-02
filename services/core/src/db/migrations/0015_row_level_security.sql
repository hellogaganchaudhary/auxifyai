-- Migration 0015: Row-Level Security (tenant isolation at the database layer)
--
-- This is the **database-enforcement** arm of the platform's defense-in-depth
-- tenant isolation (design "Multi-Tenancy Model"). The application arm — the
-- repository layer that injects an `organization_id` predicate into every query
-- (Req 1.2) — already exists. This migration adds the second, independent arm:
-- PostgreSQL Row-Level Security (RLS) bound to the session's Organization so a
-- query issued in one Organization's context can never return — or write —
-- another Organization's rows, even if an application-layer predicate is ever
-- missed (Req 1.4).
--
-- Session binding (the GUC)
-- -------------------------
-- A request handler binds the session tenant before running queries by setting
-- the custom GUC `app.current_organization_id` to the caller's Organization id
-- (see services/core/src/db/rls.ts: setTenantSession / withTenantSession). Every
-- policy compares the row's Organization against:
--
--     current_setting('app.current_organization_id', true)
--
-- The second argument (`missing_ok = true`) makes an *unset* GUC return SQL NULL
-- instead of raising, so a connection that has not bound a tenant sees NO rows
-- (`organization_id = NULL` is NULL → not true). RLS therefore fails **closed**:
-- forgetting to bind the session denies access rather than leaking it.
--
-- ENABLE + FORCE
-- --------------
-- Each tenant-scoped table is `ENABLE`d *and* `FORCE`d. FORCE makes the policy
-- apply even to the table owner (the role migrations and the app connect as),
-- so the only way to bypass isolation is a dedicated BYPASSRLS/superuser role —
-- never normal application traffic.
--
-- Scoping strategies (mirroring the repository layer's DirectTenantScope /
-- ParentTenantScope)
-- ------------------------------------------------------------------------------
--   * Direct  — the table carries `organization_id`; the policy compares it to
--               the session GUC directly. `organizations` is the special root,
--               scoped by its own `id`.
--   * Parent  — the table has no `organization_id` and is scoped through the
--               nearest ancestor that does, via an `IN (SELECT … WHERE
--               organization_id = <guc>)` subquery (the SQL analogue of the
--               base repository's parent-scope predicate / EXISTS guard).
--
-- Two tables need a tailored predicate, documented inline below:
--   * personas        — system/default & predefined personas have a NULL owner
--                        and are shared across tenants; user personas are scoped
--                        through their owning user's Organization.
--   * channel_messages — a channel message is scoped by its channel; a direct
--                        message (channel_id NULL) is scoped by its author.
--
-- Idempotency
-- -----------
-- ENABLE/FORCE are no-ops when already set. `CREATE POLICY` has no IF NOT
-- EXISTS, so every policy is preceded by `DROP POLICY IF EXISTS … ON <table>`;
-- re-running the migration recreates the same policy unchanged.
--
-- Requirements: 1.2, 1.4.

-- ============================================================================
-- Root tenant table — organizations (scoped by its own id)
-- ============================================================================
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
CREATE POLICY organizations_tenant_isolation ON organizations
  USING (id = current_setting('app.current_organization_id', true))
  WITH CHECK (id = current_setting('app.current_organization_id', true));

-- ============================================================================
-- Direct-scoped tables (carry an organization_id column)
-- ============================================================================

-- teams
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS teams_tenant_isolation ON teams;
CREATE POLICY teams_tenant_isolation ON teams
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- projects
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_tenant_isolation ON projects;
CREATE POLICY projects_tenant_isolation ON projects
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_tenant_isolation ON users;
CREATE POLICY users_tenant_isolation ON users
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- memberships
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memberships_tenant_isolation ON memberships;
CREATE POLICY memberships_tenant_isolation ON memberships
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- policies
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS policies_tenant_isolation ON policies;
CREATE POLICY policies_tenant_isolation ON policies
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- conversations
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversations_tenant_isolation ON conversations;
CREATE POLICY conversations_tenant_isolation ON conversations
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- prompt_templates
ALTER TABLE prompt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prompt_templates_tenant_isolation ON prompt_templates;
CREATE POLICY prompt_templates_tenant_isolation ON prompt_templates
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- files
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS files_tenant_isolation ON files;
CREATE POLICY files_tenant_isolation ON files
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- knowledge_collections
ALTER TABLE knowledge_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_collections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_collections_tenant_isolation ON knowledge_collections;
CREATE POLICY knowledge_collections_tenant_isolation ON knowledge_collections
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- knowledge_pages
ALTER TABLE knowledge_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_pages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_pages_tenant_isolation ON knowledge_pages;
CREATE POLICY knowledge_pages_tenant_isolation ON knowledge_pages
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- channels
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channels_tenant_isolation ON channels;
CREATE POLICY channels_tenant_isolation ON channels
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- folders
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS folders_tenant_isolation ON folders;
CREATE POLICY folders_tenant_isolation ON folders
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- documents
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_tenant_isolation ON documents;
CREATE POLICY documents_tenant_isolation ON documents
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- agents
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agents_tenant_isolation ON agents;
CREATE POLICY agents_tenant_isolation ON agents
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- workflows
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflows_tenant_isolation ON workflows;
CREATE POLICY workflows_tenant_isolation ON workflows
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- api_keys
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_keys_tenant_isolation ON api_keys;
CREATE POLICY api_keys_tenant_isolation ON api_keys
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- audit_logs (append-only via the migration 0010 guard triggers; RLS scopes
-- which Organization's records a session may read or insert)
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- invitations
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invitations_tenant_isolation ON invitations;
CREATE POLICY invitations_tenant_isolation ON invitations
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- usage_records (partitioned by range on created_at; a policy on the partitioned
-- parent applies to every partition for queries issued through the parent table,
-- which is the only path the application uses)
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_records_tenant_isolation ON usage_records;
CREATE POLICY usage_records_tenant_isolation ON usage_records
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- vector_records (the Vector_Store; embeddings carry organization_id directly)
ALTER TABLE vector_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE vector_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vector_records_tenant_isolation ON vector_records;
CREATE POLICY vector_records_tenant_isolation ON vector_records
  USING (organization_id = current_setting('app.current_organization_id', true))
  WITH CHECK (organization_id = current_setting('app.current_organization_id', true));

-- ============================================================================
-- Parent-scoped tables (no organization_id; scoped through an ancestor)
-- ============================================================================

-- messages → conversations.organization_id
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_tenant_isolation ON messages;
CREATE POLICY messages_tenant_isolation ON messages
  USING (
    conversation_id IN (
      SELECT id FROM conversations
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    conversation_id IN (
      SELECT id FROM conversations
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- prompt_versions → prompt_templates.organization_id
ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prompt_versions_tenant_isolation ON prompt_versions;
CREATE POLICY prompt_versions_tenant_isolation ON prompt_versions
  USING (
    template_id IN (
      SELECT id FROM prompt_templates
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    template_id IN (
      SELECT id FROM prompt_templates
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- artifacts → conversations.organization_id
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS artifacts_tenant_isolation ON artifacts;
CREATE POLICY artifacts_tenant_isolation ON artifacts
  USING (
    conversation_id IN (
      SELECT id FROM conversations
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    conversation_id IN (
      SELECT id FROM conversations
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- artifact_versions → artifacts → conversations.organization_id
ALTER TABLE artifact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS artifact_versions_tenant_isolation ON artifact_versions;
CREATE POLICY artifact_versions_tenant_isolation ON artifact_versions
  USING (
    artifact_id IN (
      SELECT a.id FROM artifacts a
      JOIN conversations c ON c.id = a.conversation_id
      WHERE c.organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    artifact_id IN (
      SELECT a.id FROM artifacts a
      JOIN conversations c ON c.id = a.conversation_id
      WHERE c.organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- knowledge_sources → knowledge_collections.organization_id
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_sources_tenant_isolation ON knowledge_sources;
CREATE POLICY knowledge_sources_tenant_isolation ON knowledge_sources
  USING (
    collection_id IN (
      SELECT id FROM knowledge_collections
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    collection_id IN (
      SELECT id FROM knowledge_collections
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- knowledge_documents → knowledge_sources → knowledge_collections.organization_id
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_documents_tenant_isolation ON knowledge_documents;
CREATE POLICY knowledge_documents_tenant_isolation ON knowledge_documents
  USING (
    source_id IN (
      SELECT s.id FROM knowledge_sources s
      JOIN knowledge_collections kc ON kc.id = s.collection_id
      WHERE kc.organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    source_id IN (
      SELECT s.id FROM knowledge_sources s
      JOIN knowledge_collections kc ON kc.id = s.collection_id
      WHERE kc.organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- knowledge_chunks → knowledge_documents → knowledge_sources → knowledge_collections
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_chunks_tenant_isolation ON knowledge_chunks;
CREATE POLICY knowledge_chunks_tenant_isolation ON knowledge_chunks
  USING (
    document_id IN (
      SELECT d.id FROM knowledge_documents d
      JOIN knowledge_sources s ON s.id = d.source_id
      JOIN knowledge_collections kc ON kc.id = s.collection_id
      WHERE kc.organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    document_id IN (
      SELECT d.id FROM knowledge_documents d
      JOIN knowledge_sources s ON s.id = d.source_id
      JOIN knowledge_collections kc ON kc.id = s.collection_id
      WHERE kc.organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- page_versions → knowledge_pages.organization_id
ALTER TABLE page_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_versions_tenant_isolation ON page_versions;
CREATE POLICY page_versions_tenant_isolation ON page_versions
  USING (
    page_id IN (
      SELECT id FROM knowledge_pages
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    page_id IN (
      SELECT id FROM knowledge_pages
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- page_comments → knowledge_pages.organization_id
ALTER TABLE page_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_comments_tenant_isolation ON page_comments;
CREATE POLICY page_comments_tenant_isolation ON page_comments
  USING (
    page_id IN (
      SELECT id FROM knowledge_pages
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    page_id IN (
      SELECT id FROM knowledge_pages
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- channel_messages → channels.organization_id for channel posts; for direct
-- messages (channel_id IS NULL) the message is scoped through its author's
-- Organization (every channel_message has a non-null author_id → users).
ALTER TABLE channel_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_messages_tenant_isolation ON channel_messages;
CREATE POLICY channel_messages_tenant_isolation ON channel_messages
  USING (
    (
      channel_id IS NOT NULL AND channel_id IN (
        SELECT id FROM channels
        WHERE organization_id = current_setting('app.current_organization_id', true)
      )
    )
    OR (
      channel_id IS NULL AND author_id IN (
        SELECT id FROM users
        WHERE organization_id = current_setting('app.current_organization_id', true)
      )
    )
  )
  WITH CHECK (
    (
      channel_id IS NOT NULL AND channel_id IN (
        SELECT id FROM channels
        WHERE organization_id = current_setting('app.current_organization_id', true)
      )
    )
    OR (
      channel_id IS NULL AND author_id IN (
        SELECT id FROM users
        WHERE organization_id = current_setting('app.current_organization_id', true)
      )
    )
  );

-- document_versions → documents.organization_id
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_versions_tenant_isolation ON document_versions;
CREATE POLICY document_versions_tenant_isolation ON document_versions
  USING (
    document_id IN (
      SELECT id FROM documents
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    document_id IN (
      SELECT id FROM documents
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- agent_runs → agents.organization_id
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_runs_tenant_isolation ON agent_runs;
CREATE POLICY agent_runs_tenant_isolation ON agent_runs
  USING (
    agent_id IN (
      SELECT id FROM agents
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    agent_id IN (
      SELECT id FROM agents
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- agent_steps → agent_runs → agents.organization_id
ALTER TABLE agent_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_steps_tenant_isolation ON agent_steps;
CREATE POLICY agent_steps_tenant_isolation ON agent_steps
  USING (
    run_id IN (
      SELECT r.id FROM agent_runs r
      JOIN agents a ON a.id = r.agent_id
      WHERE a.organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    run_id IN (
      SELECT r.id FROM agent_runs r
      JOIN agents a ON a.id = r.agent_id
      WHERE a.organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- notifications → users.organization_id
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_tenant_isolation ON notifications;
CREATE POLICY notifications_tenant_isolation ON notifications
  USING (
    user_id IN (
      SELECT id FROM users
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    user_id IN (
      SELECT id FROM users
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );

-- personas — system/default and predefined personas have a NULL owner and are
-- intentionally shared across every tenant (Req 9.1, 9.2); user-authored
-- personas are scoped through their owning user's Organization. The NULL-owner
-- branch keeps the shared catalogue visible to all tenants while isolating
-- user personas; platform seed jobs create the shared personas.
ALTER TABLE personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE personas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personas_tenant_isolation ON personas;
CREATE POLICY personas_tenant_isolation ON personas
  USING (
    owner_id IS NULL
    OR owner_id IN (
      SELECT id FROM users
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    owner_id IS NULL
    OR owner_id IN (
      SELECT id FROM users
      WHERE organization_id = current_setting('app.current_organization_id', true)
    )
  );
