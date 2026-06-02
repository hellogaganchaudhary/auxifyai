# Implementation Plan: Auxify AI Platform

## Overview

This plan converts the Auxify AI design into an incremental, code-only implementation sequence for a TypeScript/Node.js 22 monorepo (pnpm workspaces + Turborepo), Next.js web client, PostgreSQL 16 + pgvector, Redis, and an S3/Blob-compatible object store. Work begins with monorepo and data-layer foundations, then tenancy/RBAC and the fail-closed guards that every later service depends on, then the provider abstraction and router, chat/streaming, files/RAG, web intelligence, agents/sandbox, the four native modules, governance, security/compliance, observability, and finally the public API/WebSocket/SDK, web client, infrastructure-as-code, and end-to-end wiring.

Property-based tests use `fast-check` integrated with the project test runner (Vitest), one test per design property (Property 1–60), each running a minimum of 100 generated iterations and tagged `Feature: auxify-ai-platform, Property {number}: {property_text}`. Test sub-tasks are marked optional with `*` and may be skipped for a faster path, but every core implementation task is required.

## Tasks

- [x] 1. Establish monorepo and shared foundations
  - [x] 1.1 Initialize the monorepo, tooling, and local environment
    - Scaffold pnpm workspaces + Turborepo with `packages/` (shared types, sdk), `services/` (backend modules), and `apps/web` (Next.js)
    - Configure TypeScript project references, ESLint, Prettier, and the Vitest test runner with `fast-check` installed as the property-testing library
    - Add a Docker Compose stack for local parity: PostgreSQL 16 + pgvector, Redis, and a MinIO/S3-compatible object store
    - _Requirements: 42.1, 42.2, 46.8_
  - [x] 1.2 Define shared domain types and the typed error model
    - Implement the shared TypeScript package with core domain types (Principal, TenantContext, Role, ResourceRef, ModelInfo, ContentBlock, SourceAttribution, etc.) reused by backend, SDK, and web
    - Implement the serializable typed error/result shape used across REST_API, WebSocket_Gateway, and SDK (including `retriable` and retry-after hints)
    - _Requirements: 46.8_

- [x] 2. Build the data layer and persistence foundations
  - [x] 2.1 Implement replaceable storage interfaces with local backends
    - Implement `VectorStore` (pgvector + HNSW), `ObjectStore` (S3/MinIO), and `CacheStore` (Redis) behind stable interfaces enforcing 1536-dim embeddings
    - _Requirements: 44.2, 44.3, 44.4, 44.5_
  - [x] 2.2 Write property test for embedding dimensionality
    - **Property 56: Embeddings always have the fixed dimensionality**
    - Use `fast-check` to assert `VectorStore.upsert` accepts a record iff its embedding has exactly 1536 dimensions and rejects all other sizes
    - **Validates: Requirements 44.2**
  - [x] 2.3 Implement the PostgreSQL schema and migrations
    - Create tables for organizations, teams, projects, users, memberships, policies, conversations, messages, prompts, personas, artifacts, files, knowledge collections/sources/documents/chunks, knowledge pages, channels, channel messages, documents, agents/runs/steps, workflows, usage records, API keys, and audit logs
    - Define cascade-delete foreign keys per the data model and month-partition the usage records table
    - _Requirements: 44.1, 44.6, 44.7, 44.8_
  - [x] 2.4 Implement the repository layer with TenantContext injection
    - Implement repositories that require a `TenantContext` and automatically inject `organization_id` predicates into every query
    - _Requirements: 1.2, 44.1_
  - [x] 2.5 Write property test for message persistence round-trip
    - **Property 57: Message persistence round-trips**
    - **Validates: Requirements 44.6**
  - [x] 2.6 Write property test for cascading parent deletion
    - **Property 58: Parent deletion cascades with no orphans**
    - **Validates: Requirements 44.8**

- [x] 3. Implement tenancy, RBAC, policy engine, and audit
  - [x] 3.1 Implement the Tenancy_Service
    - Implement org/team/project/user/membership lifecycle, invitations, assignment, project move, role change application, user deactivation, and allowed-model lists
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6_
  - [x] 3.2 Implement Row-Level Security and tenant scoping
    - Bind PostgreSQL RLS policies to the session `organization_id` on every tenant-scoped table so no query crosses an Organization boundary
    - _Requirements: 1.2, 1.4_
  - [x] 3.3 Write property test for tenant isolation
    - **Property 1: Tenant isolation — no query crosses an Organization boundary**
    - **Validates: Requirements 1.4**
  - [x] 3.4 Implement the Policy_Engine
    - Resolve Organization > Team > User precedence and default-deny when no Allow_List grants or no policy resolves
    - _Requirements: 19.1, 19.2, 19.3, 19.8_
  - [x] 3.5 Write property test for hierarchical policy precedence
    - **Property 4: Hierarchical policy precedence**
    - **Validates: Requirements 19.3**
  - [x] 3.6 Write property test for role/policy change application
    - **Property 5: Role and policy changes apply to subsequent requests**
    - **Validates: Requirements 19.7**
  - [x] 3.7 Implement Access_Control authorization
    - Implement `authorize` enforcing Allow_List grants, membership of the owning Org/Team/Project, cross-tenant denial, Premium-model gating, and viewer restrictions
    - _Requirements: 1.3, 1.7, 19.4, 19.5, 19.6_
  - [x] 3.8 Write property test for fail-closed default-deny authorization
    - **Property 2: Fail-closed default-deny authorization**
    - **Validates: Requirements 1.3, 19.2, 19.4, 19.8, 34.2, 34.8, 45.2, 45.4**
  - [x] 3.9 Implement the Audit_Service
    - Implement immutable append-only audit records (actor, action, resource type/id, organization, timestamp, IP, user agent) across all tracked domains, with filtered query and 7-year retention
    - _Requirements: 37.1, 37.2, 37.3, 37.4, 37.5_
  - [x] 3.10 Write property test for denied-access auditing
    - **Property 3: Every denied access is audited**
    - **Validates: Requirements 1.7, 19.4, 26.9, 28.8, 33.12**
  - [x] 3.11 Write property test for audit record completeness
    - **Property 6: Audit record completeness**
    - **Validates: Requirements 37.1, 37.2**
  - [x] 3.12 Write property test for audit immutability
    - **Property 7: Audit immutability**
    - **Validates: Requirements 37.3**
  - [x] 3.13 Write property test for audit query soundness and completeness
    - **Property 8: Audit query soundness and completeness**
    - **Validates: Requirements 37.5**

- [x] 4. Checkpoint - foundations and fail-closed core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement the provider abstraction layer and model registry
  - [x] 5.1 Implement the AIProvider interface and config-driven Model_Registry
    - Implement the unified `AIProvider` interface (chat/embed/generateImage/realtime/listModels/healthCheck) and a `ModelRegistry` loaded from configuration exposing modality, tier, costs, and capability flags
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 2.7, 2.8, 2.9_
  - [x] 5.2 Write property test for config-driven onboarding and listing
    - **Property 9: Config-driven model onboarding and listing completeness**
    - **Validates: Requirements 2.2, 2.6, 2.7**
  - [x] 5.3 Implement the Bedrock and Azure provider adapters
    - Implement `BedrockProvider` (Claude via AWS Bedrock) and `AzureProvider` (GPT/reasoning/realtime/image via Azure AI Foundry) using configured identifiers/deployments
    - _Requirements: 2.4, 2.5_
  - [x] 5.4 Implement the provider health checker and availability gating
    - Implement periodic `healthCheck()` polling that marks affected models unavailable on failure and available again on a later success
    - _Requirements: 2.10_
  - [x] 5.5 Write property test for health-gated availability
    - **Property 10: Provider health gates model availability**
    - **Validates: Requirements 2.10**

- [x] 6. Implement the model router and hybrid routing layer
  - [x] 6.1 Implement model permission resolution
    - Compute each user's effective permitted model set with tier gating (Premium authorization), viewer restriction to Economy, and route explicit permitted models while rejecting non-permitted ones with a naming error
    - _Requirements: 3.1, 3.2, 19.5, 19.6, 20.6_
  - [x] 6.2 Write property test for tier-gated model access
    - **Property 11: Model access is permitted exactly within the user's tier-gated permitted set**
    - **Validates: Requirements 3.1, 3.2, 19.5, 19.6, 20.6**
  - [x] 6.3 Implement the Hybrid_Routing_Layer
    - Implement Auto Mode classification (rules + policies + heuristics + model-based classification) mapping simple→Economy, complex→Premium, code→Standard, and image input→vision-capable, restricted to permitted models
    - _Requirements: 3.3, 3.4, 3.5, 3.6_
  - [x] 6.4 Write property test for Auto Mode selection
    - **Property 12: Auto Mode selection respects classification, permissions, and modality**
    - **Validates: Requirements 3.4, 3.5, 3.6**
  - [x] 6.5 Implement fallback chain and outcome recording
    - Retry the next model on provider error/timeout, return an error listing every attempted model and reason on exhaustion, and record selected model, latency, token counts, and cost per request
    - _Requirements: 3.7, 3.8, 3.9_
  - [x] 6.6 Write property test for fallback chain ordering
    - **Property 13: Fallback chain is tried in order and exhaustion reports every attempt**
    - **Validates: Requirements 3.7, 3.8**
  - [x] 6.7 Write property test for request outcome recording
    - **Property 14: Request outcome is fully recorded**
    - **Validates: Requirements 3.9, 31.1, 44.6**

- [~] 7. Checkpoint - provider layer and routing
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement chat, streaming, and conversation management
  - [x] 8.1 Implement the Conversation_Manager
    - Implement create/list/rename/archive/delete, folder assignment, full-text search, share links, export, and pinning with audited mutations and recent-first date-grouped listing
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 6.6_
  - [x] 8.2 Write property test for conversation list ordering
    - **Property 17: Conversation list ordering**
    - **Validates: Requirements 5.2**
  - [x] 8.3 Implement the Chat_Service send path, model switch, and title generation
    - Orchestrate send through router and providers, apply mid-conversation model switches to subsequent messages only, and auto-generate titles after the first exchange
    - _Requirements: 3.10, 5.8_
  - [x] 8.4 Write property test for mid-conversation model switch
    - **Property 15: Mid-conversation model switch preserves history**
    - **Validates: Requirements 3.10**
  - [x] 8.5 Implement the Streaming_Engine
    - Stream tokens incrementally over SSE/WebSocket, emit a completion event (model, tokens, cost), and persist the received prefix on user cancel or client disconnect
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [x] 8.6 Write property test for streaming prefix preservation
    - **Property 16: Streaming cancellation and disconnection preserve the received prefix**
    - **Validates: Requirements 4.4, 4.5**
  - [x] 8.7 Implement message editing, branching, regeneration, comparison, and rating
    - Fork branches on edit, create child branches referencing the parent, regenerate while retaining prior responses, fan a prompt to multiple models, and persist ratings
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x] 8.8 Write property test for history-preserving edit/branch/regenerate
    - **Property 22: Editing, branching, and regeneration preserve prior history**
    - **Validates: Requirements 6.1, 6.2, 6.3**
  - [x] 8.9 Implement the Output_Renderer
    - Render GFM, syntax-highlighted code with copy, Mermaid, LaTeX, sortable/exportable tables, and artifacts, falling back to raw content for any failing block while rendering the rest
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_
  - [x] 8.10 Write property test for isolated block render failure
    - **Property 23: Block render failure is isolated**
    - **Validates: Requirements 8.7**
  - [x] 8.11 Implement the Input_Processor
    - Handle file attachments, voice transcription, pasted/dropped content, URL previews, and @-mention resolution, enforcing the 100 MB size and 10-attachment limits
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_
  - [x] 8.12 Write unit tests for input limits
    - Test rejection of files over 100 MB and messages over 10 attachments with the correct error types
    - _Requirements: 7.7, 7.8_

- [x] 9. Implement personas, prompt library, and artifacts
  - [x] 9.1 Implement the Persona_Manager
    - Provide the default persona, categorized predefined personas, conversation application, custom personas, and variable substitution
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_
  - [x] 9.2 Write property test for variable substitution
    - **Property 24: Variable substitution is complete**
    - **Validates: Requirements 9.5, 10.4**
  - [x] 9.3 Implement the Prompt_Library
    - Implement template create/edit/versioning, public/personal visibility, variable filling, usage counting, and analytics
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_
  - [x] 9.4 Write property test for prompt visibility scoping
    - **Property 26: Prompt template visibility scoping**
    - **Validates: Requirements 10.2, 10.3**
  - [x] 9.5 Implement the Artifact_Editor
    - Open editable artifacts, apply section edits, version every change with retained history, export with copy-to-clipboard, and share with team members
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_
  - [x] 9.6 Write property test for versioned edits
    - **Property 25: Versioned edits increment version and retain all prior versions**
    - **Validates: Requirements 10.5, 12.4, 26.3, 26.4, 28.1, 28.3**

- [~] 10. Checkpoint - chat experience
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement the file and document processing pipeline
  - [x] 11.1 Implement the File_Processor ingest path
    - Implement malware scan, type detection, OCR for images/scanned pages, chunking, embedding, vector indexing, and object-store persistence across all supported formats including ZIP expansion
    - _Requirements: 11.1, 11.3, 11.4, 11.5, 11.6, 11.7_
  - [x] 11.2 Implement malware rejection and storage quotas
    - Reject and audit malware-flagged files (no chunks/embeddings/object entries created) and enforce the 10 GB per-user and per-organization storage quotas
    - _Requirements: 11.2, 11.8, 11.9_
  - [x] 11.3 Write property test for malware rejection
    - **Property 27: Malware-flagged files are rejected, audited, and never indexed**
    - **Validates: Requirements 11.1, 11.2**

- [x] 12. Implement knowledge ingestion, RAG retrieval, and knowledge management
  - [x] 12.1 Implement the Knowledge_Ingestion_Service
    - Support native sources (upload, Knowledge Hub pages, DMS documents, messaging, GitHub, email, web URL) and optional connectors, with parse→chunk→embed→index, content-hash change detection, real-time/scheduled/manual sync, per-document failure resilience, and graceful degradation when optional sources are unavailable
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 23.9_
  - [x] 12.2 Write property test for write-then-retrievable indexing
    - **Property 28: Native content written becomes retrievable with one embedding per chunk**
    - **Validates: Requirements 11.4, 11.5, 23.3, 26.8, 27.9, 28.5**
  - [x] 12.3 Write property test for change-detection re-indexing
    - **Property 29: Change detection re-indexes only changed documents**
    - **Validates: Requirements 23.4**
  - [x] 12.4 Write property test for ingestion resilience
    - **Property 30: Ingestion is resilient to individual document failures**
    - **Validates: Requirements 23.8**
  - [x] 12.5 Implement the RAG_Retriever
    - Implement query embedding + hybrid (vector + keyword) retrieval, re-ranking with top-K limit, permission filtering, complete-attribution enforcement, and below-threshold "no relevant knowledge found" signaling
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.6, 24.7_
  - [x] 12.6 Write property test for authorized, ranked, bounded retrieval
    - **Property 18: Search and retrieval return only authorized items, ranked by relevance**
    - **Validates: Requirements 5.5, 24.1, 24.2, 24.3, 25.2, 27.6, 29.1, 29.2, 29.3**
  - [x] 12.7 Write property test for RAG attribution completeness
    - **Property 32: RAG attribution completeness**
    - **Validates: Requirements 24.4, 24.6**
  - [x] 12.8 Write property test for below-threshold retrieval signaling
    - **Property 33: RAG below-threshold queries return no context with an explicit signal**
    - **Validates: Requirements 24.7**
  - [x] 12.9 Implement the Knowledge_Manager
    - Implement collection creation with access lists, retrieval-restricting team/project access, source status reporting, duplicate flagging, and staleness marking
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5_

- [x] 13. Implement web search, scraping, and browser automation
  - [x] 13.1 Implement the Search_Provider_Adapter and Web_Search_Engine
    - Implement a config-selected adapter boundary with no hardcoded provider, supporting general/news/academic/code/image searches, time-range and include/exclude-domain filters, relevance ranking, and a provider-unavailable error
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.9_
  - [x] 13.2 Write property test for filtered results
    - **Property 19: Filtered results satisfy every active filter**
    - **Validates: Requirements 13.5, 13.6, 14.5, 29.4**
  - [x] 13.3 Write property test for provider-unavailable error
    - **Property 21: Unavailable adapter yields a provider-unavailable error**
    - **Validates: Requirements 13.9**
  - [x] 13.4 Implement the Cache_Manager for search/scrape deduplication
    - Serve identical search parameters within the deduplication window from cache (single provider invocation) and cache successful scrapes for the retention period
    - _Requirements: 13.8, 14.8_
  - [x] 13.5 Write property test for cached-search idempotence
    - **Property 20: Cached search is idempotent within the deduplication window**
    - **Validates: Requirements 13.8**
  - [x] 13.6 Implement the Web_Scraper and Browser_Automation
    - Implement boilerplate-stripped Markdown extraction, optional headless-browser JS rendering, extraction modes, screenshots, robots.txt evaluation with disallowed-path skipping, per-domain rate limiting, and ordered browser actions
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8_

- [~] 14. Checkpoint - files, knowledge, and web intelligence
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Implement the agent runtime, tools, scheduler, and code sandbox
  - [x] 15.1 Implement the Code_Sandbox and isolation backend
    - Implement isolated, non-root, no-network, no-persistence execution for Python 3.12/Node 22/shell/read-only SQL behind a replaceable `SandboxIsolationBackend`, with 30s timeout, 512 MB memory limit, Allow_List import enforcement, and complete result metadata
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8_
  - [x] 15.2 Write property test for sandbox import gating and result completeness
    - **Property 39: Sandbox rejects non-allow-listed imports and returns complete results**
    - **Validates: Requirements 18.6, 18.7**
  - [x] 15.3 Implement the Tool_Registry
    - Register tools across web/data/code/communication/document/integration categories with schema validation and Allow_List gating
    - _Requirements: 16.1, 16.2, 16.3_
  - [x] 15.4 Write property test for tool schema validation and Allow_List gating
    - **Property 36: Tool invocations are schema-validated and Allow_List-gated**
    - **Validates: Requirements 16.2, 16.3**
  - [x] 15.5 Implement the Agent_Runtime
    - Implement plan→act→observe→iterate execution, safety-limit termination (50 steps / 10 minutes / budget cap) with matching status, human approval for destructive actions, real-time step events, cancellation, complete per-step records, and reconciled run totals
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9_
  - [x] 15.6 Write property test for safety-limit termination
    - **Property 34: Agent runs terminate at the first safety limit reached, with matching status**
    - **Validates: Requirements 15.2, 15.3, 15.4**
  - [x] 15.7 Write property test for step record completeness and total reconciliation
    - **Property 35: Agent step records are complete and run totals reconcile**
    - **Validates: Requirements 15.6, 15.9**
  - [x] 15.8 Implement agent templates and creation-from-template
    - Provide the pre-built templates (Research, Competitive Intel, Code Review, Content Writer, Lead Research, Report Generator, Bug Triage) and copy system prompt, allowed tools, model, and safety limits on creation
    - _Requirements: 16.4, 16.5_
  - [x] 15.9 Write property test for template configuration copy
    - **Property 37: Creating an agent from a template copies its configuration**
    - **Validates: Requirements 16.5**
  - [x] 15.10 Implement the Scheduler and workflow execution
    - Trigger workflows at the defined cadence, execute steps in dependency order passing outputs to referencing steps, deliver delivery-action outputs, halt and record on step failure, and record outcome and resource usage in Analytics
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_
  - [x] 15.11 Write property test for ordered workflow execution and halt-on-failure
    - **Property 38: Workflows execute in dependency order and halt on failure**
    - **Validates: Requirements 17.2, 17.4**

- [~] 16. Checkpoint - agents and sandbox
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Implement the native enterprise modules
  - [x] 17.1 Implement the Knowledge_Hub_Service
    - Implement page create/edit with versioning and restore, parent-child hierarchy and navigation, anchored comments with subscriber notification, Access_Control-enforced permissions with audited denials, AI authoring via Chat_Service with accept/reject, and ingestion-on-write for RAG/Unified Search
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9_
  - [x] 17.2 Implement the Messaging_Service
    - Implement channels, direct messages, and threads with real-time WebSocket delivery, notifications for inactive recipients, file sharing via DMS, authorized ranked search, AI assistance via Chat_Service, private-channel restriction, and ingestion-on-write for Unified Search
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9_
  - [x] 17.3 Implement the Document_Management_Service
    - Implement object-store upload with metadata, folder hierarchy, version history, Access_Control-enforced permissions with audited denials, ingestion-on-write, retention action via Compliance_Manager, and recovery from Backup_Service within the recovery window
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8_
  - [x] 17.4 Write property test for document recovery window
    - **Property 60: Document recovery succeeds exactly within the recovery window**
    - **Validates: Requirements 28.7**
  - [x] 17.5 Implement the Unified_Search_Service
    - Search across all content types with authorization filtering, type grouping with in-group relevance ranking, content-type filters, source-module locations, combined keyword + vector ranking, and partial results indicating unsearched types on source unavailability
    - _Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.6, 29.7_
  - [x] 17.6 Write property test for graceful degradation of native operation
    - **Property 31: Native operation degrades gracefully when optional sources are unavailable**
    - **Validates: Requirements 23.9, 29.7, 30.3, 30.4**
  - [x] 17.7 Implement the Integration_Service
    - Implement GitHub/email/IdP supported integrations and optional Notion/Slack/Confluence/SharePoint/Drive connectors with status reporting, secret-store credential storage excluded from logs/UI, and native modules operating uninterrupted when connectors are unavailable
    - _Requirements: 30.1, 30.2, 30.3, 30.4, 30.5_

- [~] 18. Checkpoint - native modules
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 19. Implement governance: API keys, budgets, and billing guard
  - [x] 19.1 Implement the API_Key_Manager
    - Issue plaintext once and store only a hash, display masked prefixes, authenticate only active/unexpired/non-revoked keys with immediate revocation/expiration, rotate provider credentials at least every 90 days, and record usage with rate-limit enforcement
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 35.4_
  - [-] 19.2 Write property test for API key authentication validity
    - **Property 40: API key authentication is valid only while active, unexpired, and not revoked**
    - **Validates: Requirements 21.3, 21.4, 21.5**
  - [-] 19.3 Write property test for hashed storage and masked display
    - **Property 41: API keys are stored hashed and displayed masked**
    - **Validates: Requirements 21.1, 21.2, 35.4**
  - [x] 19.4 Implement the Budget_Manager
    - Attribute request cost to user/project/team/org, notify on alert thresholds, enforce per-scope caps (block user at user cap, restrict team to Economy at team cap, reject per-model daily limit), and retain usage records for 2 years
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6_
  - [-] 19.5 Write property test for cost attribution reconciliation
    - **Property 42: Cost attribution reconciles across the tenant hierarchy**
    - **Validates: Requirements 22.1**
  - [-] 19.6 Write property test for per-scope budget enforcement
    - **Property 43: Budget caps are enforced per scope**
    - **Validates: Requirements 22.3, 22.4, 22.5**
  - [x] 19.7 Implement the Billing_Guard
    - Verify each billable dependency is AWS/Azure credit-billable and verifiable, flag for owner approval when no credit-billable option exists, and block adoption until verified or owner-approved
    - _Requirements: 43.1, 43.2, 43.3, 43.4, 43.5_
  - [-] 19.8 Write property test for fail-closed billing governance
    - **Property 45: Credit-only billing governance is fail-closed**
    - **Validates: Requirements 43.1, 43.2, 43.3, 43.4, 43.5**

- [ ] 20. Implement security, authentication, and content safety
  - [-] 20.1 Implement the Auth_Service on BetterAuth
    - Implement password, OAuth/OIDC, and SAML 2.0 sign-in; MFA requirement resolution (per-user, privileged role, or org policy); short-lived access + refresh token issuance and refresh; and audited failed authentication
    - _Requirements: 33.1, 33.2, 33.3, 33.4, 33.5, 33.6, 33.7, 33.8, 33.9, 33.12_
  - [~] 20.2 Write property test for MFA requirement conditions
    - **Property 51: MFA is required whenever any MFA condition holds**
    - **Validates: Requirements 33.5, 33.6, 33.7**
  - [~] 20.3 Implement the Device_Manager and session invalidation
    - List active devices/sessions with last-active time, revoke a single device's tokens, invalidate tokens on sign-out, and invalidate all sessions plus block authentication on user deactivation
    - _Requirements: 20.5, 33.10, 33.11, 33.13_
  - [~] 20.4 Write property test for scoped immediate session invalidation
    - **Property 52: Session invalidation is immediate and scoped**
    - **Validates: Requirements 20.5, 33.11, 33.13**
  - [-] 20.5 Implement the Security_Gateway
    - Enforce TLS 1.3, authenticate before routing, per-user/key/IP rate limits, input validation/sanitization, XSS output encoding, CSRF tokens on state-changing requests, and default-deny on unauthenticated/unauthorized requests
    - _Requirements: 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.8_
  - [~] 20.6 Write property test for input sanitization idempotence
    - **Property 46: Input sanitization is idempotent and removes disallowed constructs**
    - **Validates: Requirements 34.4, 34.5**
  - [~] 20.7 Write property test for per-dimension rate limiting
    - **Property 44: Rate limits are never exceeded per dimension**
    - **Validates: Requirements 14.6, 34.3, 45.7**
  - [-] 20.8 Implement secret storage and field-level/at-rest encryption
    - Store secrets in AWS Secrets Manager / Azure Key Vault excluded from logs and UIs, encrypt at rest with AES-256 and in transit with TLS 1.3, apply field-level encryption to designated sensitive fields, and pin storage by configured residency region
    - _Requirements: 34.7, 35.1, 35.2, 35.3, 35.5_
  - [~] 20.9 Write property test for secret hygiene in logs and UI
    - **Property 49: Secrets never appear in logs or user interfaces**
    - **Validates: Requirements 30.5, 34.7**
  - [~] 20.10 Write property test for field-level encryption round-trip
    - **Property 50: Field-level encryption round-trips and never stores plaintext**
    - **Validates: Requirements 35.3**
  - [-] 20.11 Implement the Content_Safety_Filter
    - Screen model input for prompt injection with PII masking, block injection from overriding the system prompt with audit, scan output for PII before delivery, and queue user-reported and auto-flagged conversations for review
    - _Requirements: 36.1, 36.2, 36.3, 36.4, 36.5_
  - [~] 20.12 Write property test for PII masking on input and output
    - **Property 47: PII is masked on both input and output paths**
    - **Validates: Requirements 36.1, 36.3**
  - [~] 20.13 Write property test for prompt-injection system-prompt protection
    - **Property 48: Prompt-injection attempts cannot override the system prompt**
    - **Validates: Requirements 36.2**

- [ ] 21. Implement compliance and backup
  - [-] 21.1 Implement the Compliance_Manager
    - Enforce configured retention policies, support data subject deletion across all stores, block operations whose retention/privacy compliance cannot be verified, and record compliance actions
    - _Requirements: 38.1, 38.2, 38.3, 38.4, 38.5, 38.6_
  - [~] 21.2 Write property test for retention enforcement boundaries
    - **Property 53: Retention enforcement removes nothing early and nothing past-retention remains**
    - **Validates: Requirements 28.6, 38.2, 38.3**
  - [~] 21.3 Write property test for subject deletion completeness
    - **Property 54: Subject deletion removes all personal data**
    - **Validates: Requirements 38.4, 38.5**
  - [~] 21.4 Write property test for fail-closed compliance blocking
    - **Property 55: Fail-closed compliance blocks unverifiable operations**
    - **Validates: Requirements 38.6**
  - [x] 21.5 Implement the Backup_Service
    - Create scheduled backups of the database, vector store, and object store with integrity verification and recorded outcomes, restore to any retained recovery point, and retain backups per configuration
    - _Requirements: 39.1, 39.2, 39.3, 39.4_
  - [x] 21.6 Write property test for backup/restore round-trip
    - **Property 59: Backup and restore round-trip to a retained recovery point**
    - **Validates: Requirements 39.3, 39.4**

- [~] 22. Checkpoint - governance, security, and compliance
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 23. Implement analytics, reporting, and observability
  - [x] 23.1 Implement the Analytics_Service
    - Record per-request metrics (model, provider, tokens, cost, latency, request type, tool-call count), aggregate usage/cost/active-user and performance/agent/RAG metrics, restrict views to authorized scope, and retain granular data 90d / aggregated data 2y
    - _Requirements: 31.1, 31.2, 31.3, 31.4, 31.5, 31.6, 31.7, 31.8_
  - [~] 23.2 Implement the Report_Generator
    - Produce PDF/CSV reports across the required report types, scoped to the requesting administrator's authorized data
    - _Requirements: 32.1, 32.2, 32.3_
  - [x] 23.3 Implement the Monitoring_Service and health endpoints
    - Collect system/application/business/AI metrics, emit structured JSON logs with correlation IDs and distributed traces, dispatch alerts on threshold breach, and expose health-check/readiness endpoints per service
    - _Requirements: 39.8, 42.8, 42.9, 46.6, 46.7_

- [ ] 24. Implement the public API, WebSocket gateway, and SDK
  - [~] 24.1 Implement the versioned REST_API
    - Expose versioned endpoints for all listed resources, authenticate every request via JWT or API key before processing, deliver streaming chat over SSE, and reject rate-limit-exceeding requests with a rate-limit error
    - _Requirements: 45.1, 45.2, 45.3, 45.7_
  - [~] 24.2 Implement the WebSocket_Gateway
    - Authenticate connections via JWT before establishing a session and deliver chat token/completion/error, agent step/completion, message, notification, and budget-alert events
    - _Requirements: 45.4, 45.5_
  - [~] 24.3 Implement the Client_SDK
    - Provide TypeScript methods for chat, streaming chat, agent runs, web search, knowledge base search, and unified search using the shared types
    - _Requirements: 45.6, 46.8_
  - [~] 24.4 Write integration tests for the public API and SDK
    - Test JWT/API-key auth gating, SSE streaming, WebSocket event delivery, and rate-limit rejection end-to-end through the SDK
    - _Requirements: 45.2, 45.3, 45.5, 45.7_

- [ ] 25. Implement the web client
  - [~] 25.1 Implement the application shell and navigation
    - Build the sidebar / main work area / contextual side panel layout with theme switching (light/dark/system) and registered keyboard shortcuts
    - _Requirements: 40.1, 40.3, 40.4, 40.5, 40.6_
  - [~] 25.2 Implement the feature screens
    - Build screens for chat, Knowledge Hub, Team Communication, Document Management, prompt library, agent builder, agent monitor, knowledge base, analytics dashboard, admin panel, settings, and unified search, wired to the SDK
    - _Requirements: 40.2_
  - [~] 25.3 Implement responsive and accessible design
    - Provide mobile bottom navigation and tablet collapsible sidebar, full keyboard navigation, ARIA labels, and WCAG 2.1 AA contrast for all interactive controls
    - _Requirements: 41.1, 41.2, 41.3, 41.4, 41.5_

- [ ] 26. Implement infrastructure-as-code and CI/CD
  - [~] 26.1 Implement Terraform modules and environment configurations
    - Define reusable, multi-region-capable Terraform modules and per-environment configs provisioning HA services across availability zones with auto-scaling and health-check-based instance replacement, matching the local architecture
    - _Requirements: 39.5, 39.6, 39.7, 42.1, 42.2, 42.3_
  - [~] 26.2 Implement the CI/CD pipeline
    - Configure feature-branch lint/type-check/unit-test/security-scan, main-branch integration/e2e tests with staging deploy, production manual approval with blue-green deployment, and automatic rollback on failed production health check
    - _Requirements: 42.4, 42.5, 42.6, 42.7_

- [ ] 27. Final integration and end-to-end wiring
  - [~] 27.1 Wire the streaming-chat-with-RAG request flow end to end
    - Connect Security_Gateway → Chat_Service → Budget_Manager → Content_Safety_Filter → RAG_Retriever → Model_Router → Provider → Streaming_Engine → Analytics/Budget so a chat request flows through every guard and records cost and metrics
    - _Requirements: 4.1, 4.3, 22.1, 24.1, 31.1, 36.1, 36.3_
  - [~] 27.2 Wire native module ingestion and unified search across all sources
    - Connect Knowledge Hub, Messaging, and Document Management write paths to Knowledge_Ingestion and Unified_Search so authorized content created in any module is retrievable through RAG and unified search
    - _Requirements: 26.8, 27.9, 28.5, 29.1_
  - [~] 27.3 Write end-to-end integration tests for the wired flows
    - Test the full streaming-chat-with-RAG path and cross-module ingestion/unified-search path through the public API
    - _Requirements: 4.1, 24.1, 29.1_

- [~] 28. Final checkpoint - full platform
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks (property, unit, integration, and end-to-end tests) and can be skipped for a faster path; every unmarked task is required core implementation.
- Each of the design's 60 correctness properties (Property 1–60) is implemented by exactly one `fast-check` property-based test, placed close to the implementation it validates, running at least 100 iterations, and tagged `Feature: auxify-ai-platform, Property {number}: {property_text}`.
- Each task references the specific requirement sub-clauses and/or correctness properties it implements for traceability.
- Checkpoints provide incremental validation at major architectural boundaries.
- The fail-closed guards (tenancy/RLS, Policy_Engine, Access_Control, Audit_Service) are built early because nearly every later service depends on them.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4", "2.5", "2.6"] },
    { "id": 4, "tasks": ["3.1", "3.9"] },
    { "id": 5, "tasks": ["3.2", "3.4", "3.10", "3.11", "3.12", "3.13"] },
    { "id": 6, "tasks": ["3.3", "3.5", "3.6", "3.7"] },
    { "id": 7, "tasks": ["3.8", "5.1"] },
    { "id": 8, "tasks": ["5.2", "5.3"] },
    { "id": 9, "tasks": ["5.4", "5.5", "6.1"] },
    { "id": 10, "tasks": ["6.2", "6.3"] },
    { "id": 11, "tasks": ["6.4", "6.5"] },
    { "id": 12, "tasks": ["6.6", "6.7", "8.1", "8.5", "8.9", "8.11"] },
    { "id": 13, "tasks": ["8.2", "8.3", "8.6", "8.10", "8.12"] },
    { "id": 14, "tasks": ["8.4", "8.7", "9.1", "9.3", "9.5"] },
    { "id": 15, "tasks": ["8.8", "9.2", "9.4", "9.6", "11.1"] },
    { "id": 16, "tasks": ["11.2", "12.1"] },
    { "id": 17, "tasks": ["11.3", "12.2", "12.3", "12.4", "12.5"] },
    { "id": 18, "tasks": ["12.6", "12.7", "12.8", "12.9", "13.1", "13.4", "13.6"] },
    { "id": 19, "tasks": ["13.2", "13.3", "13.5", "15.1", "15.3"] },
    { "id": 20, "tasks": ["15.2", "15.4", "15.5", "15.8", "15.10"] },
    { "id": 21, "tasks": ["15.6", "15.7", "15.9", "15.11", "17.1", "17.2", "17.3", "17.5"] },
    { "id": 22, "tasks": ["17.4", "17.6", "17.7", "19.1", "19.4", "19.7"] },
    {
      "id": 23,
      "tasks": [
        "19.2",
        "19.3",
        "19.5",
        "19.6",
        "19.8",
        "20.1",
        "20.5",
        "20.8",
        "20.11",
        "21.1",
        "21.5"
      ]
    },
    {
      "id": 24,
      "tasks": [
        "20.2",
        "20.3",
        "20.6",
        "20.7",
        "20.9",
        "20.10",
        "20.12",
        "20.13",
        "21.2",
        "21.3",
        "21.4",
        "21.6",
        "23.1",
        "23.3"
      ]
    },
    { "id": 25, "tasks": ["20.4", "23.2", "24.1", "24.2"] },
    { "id": 26, "tasks": ["24.3", "25.1", "25.2", "26.1", "26.2"] },
    { "id": 27, "tasks": ["24.4", "25.3", "27.1", "27.2"] },
    { "id": 28, "tasks": ["27.3"] }
  ]
}
```
