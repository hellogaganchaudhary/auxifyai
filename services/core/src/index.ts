/**
 * @auxify/core — shared scaffolding for the modular backend services
 * (Node.js 22 + TypeScript). Individual domain services (Tenancy_Service,
 * Access_Control, Policy_Engine, Model_Router, etc.) are added under
 * `services/` in later tasks and reuse `@auxify/types`.
 */
import { AUXIFY_TYPES_PACKAGE } from '@auxify/types';

/** Package marker used to verify the core service package wiring. */
export const AUXIFY_CORE_PACKAGE = '@auxify/core' as const;

export const SHARED_TYPES_PACKAGE = AUXIFY_TYPES_PACKAGE;

/**
 * Replaceable storage layer (Data Layer, Req 44): VectorStore (pgvector+HNSW),
 * ObjectStore (S3/MinIO), and CacheStore (Redis) behind stable interfaces.
 */
export * from './storage/index.js';

/**
 * Primary_Database schema, migration runner, and usage-record partition helpers
 * (Req 44.1, 44.6, 44.7, 44.8).
 */
export * from './db/index.js';

/**
 * Tenant-scoped repository layer (application-layer tenant scoping, Req 1.2, 44.1):
 * every repository requires a TenantContext and injects an `organization_id`
 * predicate into every query, complementing the database Row-Level Security.
 */
export * from './repositories/index.js';

/**
 * Audit_Service (Req 37): the immutable, append-only audit trail across every
 * tracked domain, plus the narrow {@link AuditRecorder} port other services
 * (Tenancy_Service, Access_Control, Auth_Service, …) depend on to record
 * tracked actions and denied attempts.
 */
export * from './audit/index.js';

/**
 * Tenancy_Service (Req 1, 20): the Organization → Team → Project hierarchy,
 * users, memberships, invitations, assignment, project move, role-change
 * application, user deactivation, and per-user allowed-model lists.
 */
export * from './tenancy/index.js';

/**
 * Policy_Engine (Req 19.1, 19.2, 19.3, 19.8): the first guard of the fail-closed
 * decision pipeline. Resolves hierarchical Allow_List policies with
 * Organization > Team > User precedence and defaults to deny when no policy
 * grants the permission. Access_Control (task 3.7) composes it.
 */
export * from './policy/index.js';

/**
 * Access_Control (Req 1.3, 1.7, 19.4, 19.5, 19.6): the request-path
 * authorization gate. Composes the membership/cross-tenant check, the
 * Policy_Engine Allow_List resolution, the viewer resource restriction, and the
 * model-tier gates (Premium + per-user allowed models) into a single
 * fail-closed verdict, recording every denial through the AuditRecorder port.
 */
export * from './access/index.js';

/**
 * Provider_Abstraction_Layer (Req 2): the single, configuration-driven boundary
 * for all AI model traffic. Exposes the unified {@link AIProvider} interface
 * (chat/embed/generateImage/realtime/listModels/healthCheck, Req 2.1) and the
 * config-driven {@link ConfigModelRegistry} that lists each model's modality,
 * tier, costs, and capability flags (Req 2.2, 2.6, 2.7) with availability
 * gating for health checks (Req 2.10). Includes the launch catalog
 * ({@link defaultRegistryConfig}: GPT chat, OpenAI reasoning, realtime, image,
 * and Claude families — Req 2.3) and the vision/image-generation capability
 * gates (Req 2.8, 2.9). Concrete Bedrock/Azure adapters are task 5.3.
 */
export * from './providers/index.js';

/**
 * Model_Router (Req 3): decides which model serves each request. Begins (task
 * 6.1) with model permission resolution — computing a principal's effective
 * permitted/routable model set under tier (Req 19.5), viewer (Req 19.6), and
 * per-user allowed-model (Req 20.6) gating, and routing an explicitly-requested
 * model: permitted → a {@link RouteDecision} (Req 3.1); not permitted → a
 * {@link ModelNotAuthorizedError} naming the disallowed model (Req 3.2). Reuses
 * the shared {@link checkModelAccess} gate from Access_Control. The
 * Hybrid_Routing_Layer (task 6.3) and Fallback Chain (task 6.5) build on this.
 */
export * from './router/index.js';

/**
 * Streaming_Engine (Req 4): the transport-agnostic relay that delivers a model
 * response to a client token-by-token over SSE or WebSocket (Req 4.1, 4.2),
 * emits a completion event carrying the model, total token counts, and total
 * cost (Req 4.3), and — on a user cancel (Req 4.4) or a client disconnect
 * (Req 4.5) — stops and persists the received prefix through the injectable
 * {@link PartialResponsePersister}. The transport ({@link EventSink}) and
 * persistence are ports, so an SSE/WebSocket adapter (task 24.x) plugs in
 * without the engine knowing the wire format.
 */
export * from './streaming/index.js';

/**
 * Input_Processor (Req 7): turns the rich ways a user supplies context into
 * attachments and message context. Accepts image/PDF/CSV/spreadsheet/code file
 * attachments (Req 7.1), transcribes voice via an injectable {@link SpeechToText}
 * port (Req 7.2), attaches pasted images (Req 7.3) and dropped files/URLs
 * (Req 7.4), previews + summarizes pasted URLs via injectable {@link UrlFetcher}
 * and {@link Summarizer} ports (Req 7.5), and resolves `@`-mentions to a member,
 * document, knowledge page, or project via an injectable {@link MentionResolver}
 * port (Req 7.6). Enforces the 100 MB per-file limit ({@link FileSizeLimitError},
 * Req 7.7) and the 10-attachment per-message limit ({@link AttachmentCountError},
 * Req 7.8) with typed errors.
 */
export * from './input/index.js';
/**
 * Output_Renderer (Req 8): renders each model-emitted
 * {@link import('@auxify/types').ContentBlock} into a structured,
 * transport-stable, browser-free {@link RenderedBlock} the web client consumes —
 * sanitized GFM HTML (Req 8.1), code with a detected language and copy
 * affordance (Req 8.2), validated Mermaid (Req 8.3) and LaTeX (Req 8.4) sources
 * for client-side rendering, a sortable + CSV-exportable table model (Req 8.5),
 * an Artifact_Editor side-panel descriptor (Req 8.6), and normalized search
 * results. {@link OutputRenderer.render} never throws — any failing block
 * degrades to a `raw` fallback — and {@link OutputRenderer.renderAll} isolates
 * per-block failures so siblings still render (Req 8.7, Property 23).
 */
export * from './rendering/index.js';

/**
 * Conversation_Manager (Req 5, 6.6): the conversation lifecycle within a
 * Project — create with owner/Project/timestamp/editable title (Req 5.1),
 * recent-first date-grouped listing (Req 5.2 / Property 17), audited rename /
 * archive / delete (Req 5.3), folder assignment reflected in the listing
 * (Req 5.4), basic owner-scoped full-text search across titles + message
 * content (Req 5.5), unique share links with an enforced read/collab access
 * mode (Req 5.6), export to Markdown/PDF/JSON/HTML (Req 5.7), and message
 * pinning with retrievable pinned messages (Req 6.6). It composes the
 * tenant-scoped conversation/message repositories and records every mutation
 * through the {@link AuditRecorder} port.
 */
export * from './conversations/index.js';

/**
 * Chat_Service (Req 3.10, 5.8, and the chat send path of Req 4): the
 * orchestrator that turns a user message into a fully persisted exchange. It
 * persists the user message, routes the conversation so far through the
 * Model_Router (selecting/falling back/recording the outcome — Req 3), persists
 * the assistant response with the served model, token counts, and cost
 * (Req 3.9, 44.6), applies a mid-conversation model switch that affects only
 * subsequent messages while preserving prior history (Req 3.10), and
 * auto-generates a title after the first exchange of a still-untitled
 * conversation without ever overwriting a user-assigned one (Req 5.8). The
 * incremental token relay is deliberately the {@link StreamingEngine}'s job —
 * {@link ChatService.send} returns the routed result's collected chunks so a
 * transport adapter can relay them. Every effect is an injectable port
 * ({@link RoutingPort}, {@link ChatConversationStore}, {@link ChatMessageStore},
 * {@link TitleGenerator}) so the service is unit-testable with fakes.
 */
export * from './chat/index.js';

/**
 * Prompt_Library (Req 10): a library of shared and personal prompt templates.
 * Create templates with title/content/category/tags/ownership (Req 10.1); mark
 * them public (available to all users in the owning Organization, Req 10.2) or
 * personal (restricted to the owning user, Req 10.3) with the visibility scope
 * enforced in listing/get (Property 26); fill `{{ variable }}` placeholders
 * completely before use (Req 10.4 / Property 24, sharing the Persona_Manager's
 * substitution syntax); edit content with monotonic version increments that
 * retain every prior version (Req 10.5 / Property 25); count usage (Req 10.6);
 * and report most-used / highest-rated / most-shared analytics (Req 10.7). It
 * composes the tenant-scoped {@link PromptTemplateRepository} /
 * {@link PromptVersionRepository} and records every mutation through the
 * {@link AuditRecorder} port, so it is unit-testable with fakes.
 */
export * from './prompts/index.js';

/**
 * Persona_Manager (Req 9.1-9.5): the system-prompt personas a user can apply to
 * a conversation so the model answers in a task-appropriate style. Provides a
 * built-in default persona applied when none is selected (Req 9.1) and a
 * categorized predefined catalog covering at minimum engineering, sales,
 * product, and marketing (Req 9.2); {@link PersonaManager.apply} records a
 * persona on a conversation so the Chat_Service applies its system prompt to
 * subsequent model requests (Req 9.3); {@link PersonaManager.createCustom}
 * persists a per-user custom persona via the owner-scoped
 * {@link PersonaRepository} (Req 9.4); and {@link substituteVariables} replaces
 * `{{name}}` placeholders before a prompt is sent to the model (Req 9.5) via a
 * shared core also used by the Prompt_Library (Property 24, task 9.2). Every
 * effect is an injectable port ({@link PersonaStore},
 * {@link ConversationPersonaStore}) so the manager is unit-testable with fakes.
 */
export * from './personas/index.js';

/**
 * Artifact_Editor (Req 12): the backend lifecycle service for the "Canvas and
 * Artifacts" feature. Opens AI-generated long-form content as an editable
 * artifact in the side panel across all supported types — code, Markdown,
 * Mermaid, React, SVG, CSV, HTML (Req 12.1, 12.2); applies a modification to a
 * specific section via an injectable {@link SectionEditor} port (the model-free
 * {@link DeterministicSectionEditor} by default, Req 12.3); versions *every*
 * change while retaining the full prior history (Req 12.4 / Property 25,
 * task 9.6); exports an artifact as a downloadable {@link DownloadRef} plus a
 * copy-to-clipboard string (Req 12.5); and shares it with designated team
 * members (Req 12.6). It composes the tenant-scoped {@link ArtifactRepository}
 * (artifacts are scoped through their parent conversation, Req 1.2, 1.4) and
 * records every mutation through the {@link AuditRecorder} port, so it is
 * unit-testable with fakes.
 */
export * from './artifacts/index.js';

/**
 * File_Processor ingest path (Req 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7,
 * 11.8, 11.9): turns an uploaded file into retrievable knowledge.
 * {@link FileProcessor.ingest} detects the file type and rejects an unsupported
 * direct upload with an {@link UnsupportedFileFormatError} (Req 11.1, 11.6);
 * scans for malware via the injectable {@link MalwareScanner} and
 * short-circuits a flagged file to a {@link RejectedFile} outcome — recorded in
 * the Audit_Service through the injectable {@link AuditRecorder} port — before
 * any storage, chunking, embedding, or indexing occurs (Req 11.1, 11.2,
 * Property 27); expands a ZIP archive via the injectable {@link ArchiveExpander}
 * and processes each supported member recursively, skipping unsupported or
 * too-deeply-nested members (Req 11.7); enforces the fixed 10 GB per-user
 * ({@link StorageQuotaExceededError}, Req 11.8) and the configured
 * per-Organization ({@link OrganizationStorageQuotaExceededError}, Req 11.9)
 * storage quotas through the injectable {@link StorageUsageStore} before
 * persisting bytes; and otherwise extracts text via the injectable
 * {@link TextExtractor} — running {@link OcrEngine} OCR for images and scanned
 * pages (Req 11.3) — splits it into chunks ({@link chunkText}) and embeds each
 * chunk via the injectable {@link Embedder} with exactly one embedding per chunk
 * guarded by {@link EmbeddingCountError} (Req 11.4, Property 28), then persists
 * the original bytes through the shared {@link ObjectStore}, indexes the chunk
 * embeddings through the shared {@link VectorStore} as `file_chunk` records, and
 * accrues the stored bytes against both storage scopes (Req 11.5, 11.8, 11.9).
 * Every external capability is a narrow injectable port, so the processor is
 * fully unit-testable with fakes.
 */
export * from './file-processor/index.js';

/**
 * Knowledge_Ingestion_Service (Req 23.1-23.9): the pipeline that turns a
 * connected knowledge source into retrievable, attributed knowledge.
 * {@link KnowledgeIngestionService.connectSource} registers a primary native
 * source — direct file upload, Knowledge_Hub_Service pages,
 * Document_Management_Service documents, Messaging_Service content, GitHub,
 * email, or web URL (Req 23.1) — or an optional interoperability connector
 * (Notion/Confluence/Drive/SharePoint) that is never required for platform
 * operation (Req 23.2). {@link KnowledgeIngestionService.ingest} fetches the
 * source's documents through the injectable {@link SourceFetcher} and runs
 * parse → chunk → embed → index for each new or changed document (Req 23.3),
 * reusing the File_Processor's {@link chunkText}/{@link Embedder} and indexing
 * each chunk as a `knowledge_chunk` {@link VectorStore} record with a complete
 * {@link import('@auxify/types').SourceAttribution} (Req 24.4). Content-hash
 * change detection via the injectable {@link ContentHasher} re-indexes only
 * changed documents (Req 23.4, exposed without mutation as
 * {@link KnowledgeIngestionService.detectChanges});
 * {@link KnowledgeIngestionService.onChangeNotification} ingests on a real-time
 * source's notification (Req 23.5) and {@link KnowledgeIngestionService.reindex}
 * re-processes every document for a scheduled (Req 23.6) or manual (Req 23.7)
 * re-index. Per-document failures are recorded as {@link FailedDocument}
 * outcomes while the rest continue (Req 23.8), and an unavailable optional
 * connector short-circuits to a `connector_unavailable`
 * {@link KnowledgeIngestReport} so native sources keep serving uninterrupted
 * (Req 23.9, via {@link ConnectorUnavailableError}). Every external capability
 * is a narrow injectable port, so the service is fully unit-testable with fakes.
 */
export * from './knowledge/index.js';

/**
 * Web_Search_Engine and Search_Provider_Adapter (Req 13.1-13.6, 13.9): the
 * web-intelligence search boundary. The {@link WebSearchEngine} performs every
 * web search through a configuration-selected {@link SearchProviderAdapter} —
 * resolved on every search via an injectable {@link ProviderSelector} so there
 * is no hardcoded provider (Req 13.1) and an administrator can reroute to a
 * newly configured provider without any source change (Req 13.2). It gates on
 * the adapter's availability and reports an unavailable provider via
 * {@link ProviderUnavailableError} (Req 13.9), dispatches the search with the
 * request's type (Req 13.4), time range (Req 13.5), and include/exclude-domain
 * filters (Req 13.6), enforces those filters defensively on the returned set
 * ({@link applyFilters}, Property 19), and ranks survivors by non-increasing
 * relevance ({@link rankResults}, Req 13.3). Each adapter normalizes its
 * vendor's payload into the common {@link WebSearchResult} shape. The
 * deduplication cache (Req 13.8) is the Cache_Manager's concern (task 13.4) and
 * rendering results with their source links (Req 13.7) is the Output_Renderer's
 * (task 8.9); both compose this engine. The engine's request/result types are
 * named distinctly from the Output_Renderer's `SearchResultItem` to avoid a
 * barrel collision.
 */
export * from './web-search/index.js';

/**
 * Cache_Manager (Req 13.8, 14.8): search/scrape deduplication and caching over
 * the shared {@link CacheStore}. The {@link WebCacheManager} (the design's
 * `CacheManager`) serves identical search parameters within the deduplication
 * window from cache with a single provider invocation (Req 13.8) and caches a
 * successful scrape for the retention period (Req 14.8), keyed by a
 * deterministic, normalized cache key ({@link deriveSearchCacheKey} /
 * {@link deriveScrapeCacheKey}). `dedupeSearch`/`dedupeScrape` add single-flight
 * deduplication so concurrent identical requests collapse into one computation.
 * It adds no new cache backend — only the shared {@link CacheStore} (Req 44.4)
 * plus an injectable clock — and is generic over the provider value type, so it
 * stays decoupled from the Web_Search_Engine (task 13.1) and Web_Scraper
 * (task 13.6) that compose it. The injectable clock is surfaced as
 * {@link CacheClock}/{@link systemCacheClock} to avoid colliding with the
 * Model_Router's clock in this barrel.
 */
export * from './web-cache/index.js';

/**
 * Web_Scraper and Browser_Automation (Req 14.1-14.7): the per-page
 * web-intelligence boundary. {@link WebScraper.scrape} fetches a single URL,
 * strips navigation/advertisement boilerplate, and returns the main content as
 * structured Markdown (Req 14.1) under a selectable {@link ExtractionMode}
 * (`full_text`/`main_content`/`tables`/`links`/`metadata`, Req 14.3); renders
 * JavaScript pages with a headless browser when requested or when a plain fetch
 * comes back thin (Req 14.2, via the pure {@link decideRenderMode}); captures a
 * screenshot on request (Req 14.4); evaluates the domain's `robots.txt` and
 * skips disallowed paths ({@link RobotsDisallowedError}, Req 14.5, via the pure
 * {@link parseRobots}/{@link isPathAllowed}); and enforces the configured
 * per-domain rate limit before any request ({@link IntervalRateLimiter},
 * Req 14.6). {@link BrowserAutomation.run} executes an ordered
 * click/type/scroll/screenshot/extract {@link BrowseAction} list against a page
 * (Req 14.7). Every external capability — fetching ({@link PageFetcher}),
 * headless rendering/driving ({@link BrowserEngine}), reading `robots.txt`
 * ({@link RobotsFetcher}), and the rate-limit clock/waiter — is a narrow
 * injectable port, so the components are fully unit-testable with the fakes in
 * `./web-scraper/fakes.js` and never touch a real network or browser; fetched
 * HTML is treated as untrusted data and never executed. Caching a successful
 * scrape for the retention period (Req 14.8) is the Cache_Manager's concern
 * (task 13.4) and composes the {@link ScrapedContent} result. Re-exported by
 * name so the scraper's `Clock`/`systemClock` (shared shape with the
 * Model_Router's) and its `normalizeWhitespace` helper (shared name with the
 * Chat_Service's title normalizer) do not collide at the package barrel; both
 * remain available from `./web-scraper/index.js`.
 */
export {
  WebScraper,
  BrowserAutomation,
  decideRenderMode,
  DEFAULT_SCRAPER_USER_AGENT,
  THIN_CONTENT_THRESHOLD,
  IntervalRateLimiter,
  NoopRateLimiter,
  parseRobots,
  isPathAllowed,
  matchingRule,
  parseScrapeUrl,
  resolveUrl,
  decodeEntities,
  extractLinks,
  extractMetadata,
  extractTables,
  htmlToMarkdown,
  htmlToText,
  linksToMarkdown,
  metadataToMarkdown,
  selectMainContent,
  stripNonContent,
  tablesToMarkdown,
  ScrapeFetchError,
  RobotsDisallowedError,
  BrowserAutomationError,
  InvalidUrlError,
  SCRAPE_FETCH_FAILED_CODE,
  ROBOTS_DISALLOWED_CODE,
  BROWSER_AUTOMATION_FAILED_CODE,
  INVALID_URL_CODE,
  EXTRACTION_MODES,
  DEFAULT_EXTRACTION_MODE,
  BROWSE_ACTION_TYPES,
  type WebScraperOptions,
  type RenderMode,
  type RenderDecisionInput,
  type BrowserAutomationOptions,
  type IntervalRateLimiterOptions,
  type RobotsRules,
  type ParsedUrl,
  type ExtractionMode,
  type ScrapeRequest,
  type ScrapedContent,
  type PageMetadata,
  type ExtractedTable,
  type ExtractedLink,
  type ScreenshotImage,
  type FetchedHtml,
  type FetchOptions,
  type PageFetcher,
  type BrowseActionType,
  type BrowseAction,
  type BrowseActionResult,
  type BrowseResult,
  type BrowserRenderOptions,
  type BrowserRenderResult,
  type BrowserEngine,
  type RobotsFetcher,
  type RateLimiter,
} from './web-scraper/index.js';

/**
 * Tool_Registry (Req 16.1, 16.2, 16.3): the catalog the Agent_Runtime reads to
 * discover, gate, and dispatch the tools an agent may call. {@link ToolRegistry}
 * registers {@link ToolDefinition}s across the web/data/code/communication/
 * document/integration categories (Req 16.1), lists/discovers them as
 * handler-free {@link ToolDescriptor}s — optionally filtered by category and/or
 * an Allow_List so an agent sees only the tools it may invoke (Req 16.3) —
 * resolves a tool by id ({@link UnknownToolError} when absent), validates an
 * invocation's arguments against the tool's parameter {@link JsonSchema} before
 * dispatch ({@link validateAgainstSchema}, Req 16.2), gates on the agent's
 * Allow_List ({@link ToolRegistry.isAllowed}, Req 16.3), and dispatches a
 * validated, allow-listed call through {@link ToolRegistry.invoke} —
 * fail-closed: the Allow_List denial ({@link ToolNotAllowedError}) precedes the
 * schema check ({@link ToolInputValidationError}), which precedes the handler.
 * The schema subset is self-contained (no external JSON-schema dependency), so
 * the registry has no runtime coupling beyond `@auxify/types`. The Agent_Runtime
 * (task 15.5) composes this registry to deny — and record in the run steps — a
 * tool not on the agent's Allow_List (Req 16.3).
 */
export * from './tools/index.js';

/**
 * Code_Sandbox (Req 18.1-18.8): isolated execution of untrusted, agent- or
 * user-submitted code behind a replaceable isolation backend.
 * {@link CodeSandbox.execute} accepts a {@link SandboxExecRequest} (language,
 * source, stdin, optional Allow_List, optional lowered limits) and returns a
 * structured {@link SandboxResult} (stdout, stderr, exit code, `timedOut` /
 * `memoryExceeded` flags, generated files, and metadata carrying elapsed time
 * and memory used, Req 18.7), supporting Python 3.12, Node.js 22, shell, and
 * read-only SQL (Req 18.2) and rejecting any other runtime with an
 * {@link UnsupportedLanguageError}. The isolation boundary is modelled
 * explicitly as the narrow injectable {@link SandboxIsolationBackend} port
 * (Req 18.8): the sandbox fixes the isolation policy in code — no network egress
 * (Req 18.1), non-root execution and an ephemeral filesystem (Req 18.5), and the
 * clamped 30 s / 512 MB ceilings (Req 18.3, 18.4) — into a fully-resolved
 * {@link ContainerSpec} the backend alone runs under hard isolation, so the
 * production backend (a gVisor-hardened container, a microVM, …) can be swapped
 * for a stronger one without changing the submission contract. Before any code
 * runs, the Allow_List import preflight ({@link extractImports}) rejects a
 * program importing a non-allow-listed package with an
 * {@link UnauthorizedPackageError} (Req 18.6, Property 39); a wall-clock watchdog
 * guards a backend that overruns its own deadline (Req 18.3); resource-limit
 * breaches are ordinary typed outcomes, never thrown errors. The only impure
 * dependency is the isolation port, so the orchestration is fully unit-testable
 * with the deterministic fake backend that never evaluates the submitted code.
 */
export * from './code-sandbox/index.js';

/**
 * Agent templates and creation-from-template (Req 16.4, 16.5): the pre-built
 * agent-template catalog a power user starts from instead of hand-authoring an
 * agent. {@link PREDEFINED_AGENT_TEMPLATES} ships the seven required templates —
 * Research, Competitive Intel, Code Review, Content Writer, Lead Research,
 * Report Generator, and Bug Triage (Req 16.4) — across the research/engineering/
 * content categories ({@link REQUIRED_AGENT_TEMPLATE_CATEGORIES}); {@link listTemplates}/
 * {@link findTemplate}/{@link getTemplate} discover them (the last fails closed
 * with {@link UnknownAgentTemplateError}); and {@link createFromTemplate}
 * instantiates a concrete {@link AgentDefinition} by copying the template's
 * system prompt, allowed tools, model, and safety limits (Req 16.5, Property 37),
 * applying optional, validated {@link AgentTemplateOverrides} (an invalid
 * override fails closed with {@link InvalidTemplateOverrideError}). The domain
 * types ({@link AgentTemplate}, {@link AgentDefinition}, {@link SafetyLimits}) are
 * defined in this module and match the design's `Agent`/`SafetyLimits`
 * structurally, so the module has no dependency on the concurrently-built
 * Agent_Runtime (task 15.5). The tool ids in each template's Allow_List are the
 * Tool_Registry's stable ids gated at run time by the agent's Allow_List (Req 16.3).
 */
export * from './agent-templates/index.js';

/**
 * Scheduler and workflow execution (Req 17.1-17.5): the components behind
 * "Scheduled Agent Workflows". The {@link Scheduler} (design `Scheduler`)
 * registers a {@link Workflow}'s {@link Cadence} (cron / interval / one-shot),
 * computes the next due time from an injectable {@link SchedulerClock} via the
 * pure {@link compileCadence} core, and fires a run through an injectable
 * {@link RunTrigger} when — and only when — a schedule is due ({@link Scheduler.tick}
 * is pull-based and timer-free, so production drives it from a thin timer loop
 * while tests advance a hand-controlled clock, Req 17.1). The
 * {@link WorkflowExecutor} runs a workflow's steps in their defined dependency
 * order ({@link validateWorkflowGraph}), passing each step's output to the steps
 * that reference it (Req 17.2), delivering a delivery-action step's output
 * through the configured channel (Req 17.3), halting and recording the failed
 * step plus its projected {@link import('@auxify/types').PlatformError} on a
 * failure (Req 17.4, Property 38), and recording the run's outcome and
 * aggregated resource usage through an injectable {@link WorkflowAnalyticsRecorder}
 * on completion (Req 17.5). Each step runs through the injectable
 * {@link WorkflowStepExecutor} port. Neither component depends on the
 * Agent_Runtime's in-flux concrete types (task 15.5): the Agent_Runtime, the
 * delivery channels, and the Analytics_Service are reached only through those
 * narrow injectable ports, which production wiring satisfies. The injectable
 * clock is surfaced as {@link SchedulerClock}/{@link systemSchedulerClock} to
 * avoid colliding with the Model_Router's clock in this barrel (the same
 * disambiguation the Cache_Manager made with `CacheClock`).
 */
export * from './scheduler/index.js';

/**
 * Agent_Runtime (Req 15.1-15.9, 16.2, 16.3): the engine that executes an agent
 * autonomously over a task, looping **plan → act → observe → iterate**
 * (Req 15.1). {@link AgentRuntime.run} calls the model through the narrow
 * injectable {@link AgentModelPort} to decide each next action, dispatches a
 * requested tool through the {@link AgentToolDispatcher} (the Tool_Registry) —
 * denying a tool not on the agent's Allow_List (Req 16.3) and rejecting input
 * that fails the tool's schema (Req 16.2) — records a complete
 * {@link AgentStepRecord} for every attempt (step number, tool, input, output,
 * duration — Req 15.6) emitted in real time through the optional
 * {@link AgentEventSink} (Req 15.7), feeds the {@link AgentObservation} back to
 * the model, and repeats until the model returns a final answer or the *first*
 * safety boundary is reached — 50 steps (Req 15.2), 10 minutes (Req 15.3), the
 * budget cap (Req 15.4), or a cancellation (Req 15.8) — with a status that names
 * it (Property 34). Destructive actions pause for human approval through the
 * optional {@link AgentApprovalPort} (Req 15.5, fail-closed), and on finish the
 * run's totals reconcile as the aggregation over its recorded steps (Req 15.9,
 * Property 35). It composes the {@link ToolRegistry} (structurally the
 * {@link AgentToolDispatcher}) and is fully unit-testable with the fakes in
 * `./agent/fakes.js` — no real model, tools, clock, or transport.
 *
 * Re-exported by name (not `export *`) so the runtime's configuration shapes do
 * not collide with the Agent-templates module's identically-named exports at the
 * package barrel: the runtime's full agent configuration is surfaced as
 * {@link RuntimeAgentDefinition} (the design's `Agent`, carrying `id` and
 * `destructiveTools`) and its limits as {@link AgentSafetyLimits} (structurally
 * the design's `SafetyLimits`); the Agent-templates module keeps the plain
 * `AgentDefinition`/`SafetyLimits` names. Both remain available unaliased from
 * `./agent/index.js`. The runtime's ports are `Agent`-prefixed
 * ({@link AgentClock}, {@link AgentIdGenerator}) so they never collide with the
 * Model_Router's `Clock`/`systemClock`.
 */
export {
  AgentRuntime,
  systemAgentClock,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_DURATION_MS,
  InvalidAgentRunError,
  INVALID_AGENT_RUN_CODE,
  type AgentRuntimeOptions,
  type AgentRunOptions,
  type AgentDefinition as RuntimeAgentDefinition,
  type SafetyLimits as AgentSafetyLimits,
  type AgentRunInput,
  type AgentToolCall,
  type AgentFinalAnswer,
  type AgentModelResponse,
  type AgentModelRequest,
  type AgentModelPort,
  type AgentToolDispatcher,
  type AgentClock,
  type AgentIdGenerator,
  type AgentRunStatus,
  type AgentStepOutcome,
  type AgentStepRecord,
  type AgentObservation,
  type AgentRunResult,
  type AgentRunEvent,
  type AgentEventSink,
  type AgentCancellation,
  type AgentApprovalRequest,
  type AgentApprovalPort,
} from './agent/index.js';

/**
 * Unified_Search_Service (Req 29.1-29.7): the single search across every native
 * content type a user is authorized to access. {@link UnifiedSearchService.search}
 * fans a query out to one injectable {@link ContentTypeSearcher} per content
 * type — conversations, chat messages, knowledge pages, documents, and knowledge
 * chunks (Req 29.1) — concurrently, so it never imports the concurrently-built
 * Knowledge_Hub_Service, Messaging_Service, Document_Management_Service, or
 * Conversation_Manager and stays fully unit-testable with the fakes in
 * `./unified-search/fakes.js`. It returns only results the requesting principal
 * may access via the injectable {@link UnifiedSearchAuthorizer} (Req 29.2),
 * after dropping any candidate outside the principal's Organization (Req 1.2);
 * groups the survivors by content type and ranks each group by non-increasing
 * relevance, ties broken on id (Req 29.3), bounding each group to a configurable
 * per-group top-K; honors a content-type filter (Req 29.4, rejecting a filter
 * naming an unsearchable type with {@link UnknownContentTypeFilterError});
 * carries the {@link ContentLocation} needed to open each result in its source
 * module (Req 29.5); fuses keyword and vector relevance into one hybrid score
 * (Req 29.6); and degrades gracefully when a content source is unavailable —
 * that searcher's type is reported in {@link UnifiedSearchResult.unavailableTypes}
 * while the available types still return results (Req 29.7, Property 31).
 *
 * Re-exported by name (not `export *`) so the unified-search module's generic
 * ranking helpers — which share the names `hybridScore`, `DEFAULT_VECTOR_WEIGHT`,
 * and `DEFAULT_KEYWORD_WEIGHT` with the Knowledge module's RAG ranking exports —
 * do not collide at this package barrel; those three remain available unaliased
 * from `./unified-search/index.js`. The result/type names are otherwise
 * intentionally distinct (`UnifiedSearch*`, `UnifiedSearchType`) so they never
 * collide with the Web_Search_Engine's `WebSearchResult`/`SearchType` or the
 * Output_Renderer's `SearchResultItem`.
 */
export {
  UnifiedSearchService,
  UNIFIED_SEARCH_TYPES,
  DEFAULT_GROUP_LIMIT,
  clamp01 as clampUnifiedSearchScore,
  compareByScoreThenId as compareUnifiedSearchResults,
  DuplicateSearcherError,
  UnknownContentTypeFilterError,
  DUPLICATE_SEARCHER_CODE,
  UNKNOWN_CONTENT_TYPE_FILTER_CODE,
  type UnifiedSearchServiceOptions,
  type UnifiedSearchType,
  type ContentLocation,
  type UnifiedSearchCandidate,
  type UnifiedSearchResultItem,
  type UnifiedSearchGroup,
  type UnifiedSearchResult,
  type UnifiedSearchOptions,
  type ContentTypeSearcher,
  type UnifiedSearchAuthorizer,
  type Rankable as UnifiedSearchRankable,
} from './unified-search/index.js';

/**
 * Messaging_Service (Req 27.1-27.9): the native team-communication service —
 * channels, direct messages (modelled as private channels), threaded replies,
 * real-time delivery, notifications for inactive recipients, file sharing via
 * the Document_Management_Service, authorized ranked search, AI assistance via
 * the Chat_Service, private-channel access restriction, and ingestion-on-write.
 * {@link MessagingService.createChannel} persists a channel with a name, owning
 * Team or Project, visibility, and membership list (Req 27.1);
 * {@link MessagingService.post} persists a message, delivers it to the channel's
 * authorized recipients in real time over the WebSocket_Gateway (Req 27.2), and
 * emits its content through the {@link MessageIngestionEmitter} so it is
 * retrievable through Unified Search (Req 27.9);
 * {@link MessagingService.reply} associates a reply with its parent and
 * maintains thread order (Req 27.3); recipients not actively viewing a channel
 * are notified (Req 27.4); {@link MessagingService.shareFile} stores a file via
 * the Document_Management_Service and attaches the reference (Req 27.5);
 * {@link MessagingService.search} returns relevance-ranked messages the user is
 * authorized to access (Req 27.6, via the pure {@link searchMessages});
 * {@link MessagingService.aiAssist} invokes the Chat_Service and posts the AI
 * response (Req 27.7); and a private channel restricts access to its members
 * with every denied attempt recorded in the Audit_Service (Req 27.8, via the
 * pure {@link canAccess}). It composes the tenant-scoped {@link ChannelStore} /
 * {@link ChannelMessageStore} (Req 1.2, 1.4), the {@link AuditRecorder} port
 * (every mutation and denial audited, Req 37.1, 37.2), and the
 * {@link MessageIngestionEmitter} seam (Req 27.9), with real-time delivery,
 * presence, notification, file storage, and chat assistance as further optional
 * injectable ports — so it is fully unit-testable with the fakes in
 * `./messaging/fakes.js`. Exposes `Channel`-/`Messaging`-prefixed names plus
 * {@link MessageSearchHit} so it never collides with the Conversation_Manager's
 * `Message`/`MessageStore`/`MessageNotFoundError`/`SearchHit` barrel exports.
 */
export * from './messaging/index.js';

/**
 * Knowledge_Hub_Service (Req 26.1-26.9): the native enterprise wiki. The
 * {@link KnowledgeHubService} manages Project-scoped spaces of richly authored
 * pages — persisting a page with title, rich content, author, owning Project,
 * and creation timestamp (Req 26.1); maintaining a parent-child hierarchy and
 * presenting pages within a navigation tree (Req 26.2, via the pure
 * {@link buildNavigationTree}); versioning a page on every edit while retaining
 * all prior versions (Req 26.3) and restoring a prior version as a new version
 * entry (Req 26.4); recording anchored comments and notifying subscribers
 * (Req 26.5); enforcing a page's configured view/edit permissions through an
 * Access_Control seam ({@link PageAuthorizer}, default
 * {@link PermissionsPageAuthorizer}) on every operation (Req 26.6) and recording
 * every denied modification in the Audit_Service (Req 26.9); generating AI
 * authoring drafts through a Chat_Service seam ({@link PageAuthoringModel},
 * default {@link DeterministicPageAuthoringModel}) for the user to accept or
 * reject before saving (Req 26.7); and emitting each page's content for ingestion
 * on every write through the injectable {@link PageIngestionEmitter} — a narrow
 * seam, never the concrete Knowledge_Ingestion_Service — so the page is
 * retrievable through RAG and Unified Search (Req 26.8). It composes the
 * tenant-scoped {@link PageStore} (Req 1.2, 1.4), the {@link AuditRecorder} port,
 * the ingestion/notifier/authorizer/authoring seams, so it is fully
 * unit-testable with the fakes in `./knowledge-hub/fakes.js`. Exposes
 * `Page`-/`KnowledgePage`-prefixed names plus {@link RichContent} so it never
 * collides with sibling modules' barrel exports.
 */
export * from './knowledge-hub/index.js';

/**
 * Billing_Guard (Req 43.1, 43.2, 43.3, 43.4, 43.5): the credit-only billing
 * governance gate consulted before the platform adopts any billable dependency
 * — an AI model billed via Bedrock/Azure AI Foundry (Req 43.1), a web-search
 * provider adapter (Req 43.2), or any hosting/storage/database/cache/networking
 * service (Req 43.3). {@link BillingGuard.verify} reads the dependency's
 * {@link BillingComplianceStatus} from the narrow injectable
 * {@link BillingStatusProvider} port (explicitly NOT the concurrently-built
 * Budget_Manager) and applies the fail-closed decision model
 * ({@link decideBilling}): a status that cannot be obtained blocks with
 * `verification_unavailable`; an explicit owner approval allows; a missing
 * AWS/Azure credit-billable option blocks and flags the dependency for owner
 * approval (Req 43.4); an unverifiable credit-billable option blocks until
 * verified or approved (Req 43.5); and a verified credit-billable dependency is
 * allowed (Req 43.1-43.3; Property 45). Every block is recorded through the
 * {@link AuditRecorder} port scoped to the adopting Organization (Req 37.1), and
 * {@link BillingGuard.verifyOrThrow} raises a typed {@link BillingBlockedError}
 * that projects into a serializable `billing_blocked`
 * {@link import('@auxify/types').PlatformError} (Req 46.8). Fully unit-testable
 * with the fakes in `./billing-guard/fakes.js` — no external service.
 */
export * from './billing-guard/index.js';

/**
 * API_Key_Manager (Req 21.1-21.7, 35.4): the governance service that issues,
 * lists, verifies, rotates, and revokes the API keys granting programmatic
 * platform access, scoped to a tenant/principal. {@link ApiKeyManager.create}
 * mints a high-entropy key from an injectable cryptographically-secure
 * {@link KeyRandomSource} and returns the raw secret EXACTLY ONCE, persisting
 * only its one-way SHA-256 hash (via the injectable {@link KeyHasher}) plus a
 * non-secret display prefix and metadata (Req 21.1, 35.4);
 * {@link ApiKeyManager.list}/`get` return masked, prefix-only metadata that
 * never exposes the secret or its hash (Req 21.2, via the pure
 * {@link toMaskedKey}); {@link ApiKeyManager.authenticate} (alias `verify`)
 * resolves a presented key by hash and accepts it only while active, unexpired,
 * and not revoked, comparing hashes with {@link constantTimeEqual} and never
 * leaking whether a similar key exists (Req 21.3, 21.4, 21.5);
 * {@link ApiKeyManager.revoke} immediately rejects subsequent authentication
 * (Req 21.5); {@link ApiKeyManager.rotate} mints a replacement and invalidates
 * the old key, and {@link ApiKeyManager.rotateProviderCredentials} rotates an
 * Organization's provider credentials through the injectable
 * {@link ProviderCredentialRotator} (Req 21.6); and
 * {@link ApiKeyManager.recordUse} records the usage timestamp and enforces the
 * key's configured {@link RateLimit}, rejecting an over-limit use with a
 * {@link KeyRateLimitExceededError} (Req 21.7). Every mutation is recorded
 * through the {@link AuditRecorder} port (Req 37.1). It composes the
 * tenant-scoped {@link ApiKeyStore} (Req 1.2, 1.4) and is fully unit-testable
 * with the fakes in `./api-keys/fakes.js`.
 *
 * SECURITY: a raw key is never persisted, logged, or echoed — only its hash and
 * non-secret prefix are stored, and the raw value is returned to the caller
 * exactly once at creation/rotation.
 */
export * from './api-keys/index.js';

/**
 * Document_Management_Service (Req 28.1-28.8): the native enterprise document
 * store. The {@link DocumentManagementService} stores a document's original
 * bytes in the shared {@link ObjectStore} with its metadata — name, owning
 * Project, owner, size, content type, version (Req 28.1); organizes documents
 * into a folder hierarchy presented within their folders (Req 28.2, via
 * {@link DocumentManagementService.createFolder} / {@link DocumentManagementService.organize}
 * / {@link DocumentManagementService.listFolder}); versions a document on every
 * new upload while retaining the full version history (Req 28.3, via
 * {@link DocumentManagementService.addVersion}); enforces each document's
 * configured permissions through an Access_Control seam ({@link DocAuthorizer},
 * default {@link PermissionsDocAuthorizer}) on every operation (Req 28.4) and
 * records every denied access in the Audit_Service (Req 28.8); emits each
 * document's content for ingestion on every write through the injectable
 * {@link DocumentIngestionEmitter} — a narrow seam, never the concrete
 * Knowledge_Ingestion_Service — so it is retrievable through RAG and Unified
 * Search (Req 28.5); applies a configured retention action through the
 * {@link DocumentComplianceManager} (Compliance_Manager) seam when retention
 * elapses (Req 28.6); and protects deletions with a recovery window — soft-delete
 * to "trash" ({@link DocumentManagementService.softDelete}), restore through the
 * {@link DocumentBackupStore} (Backup_Service) seam while the window is open
 * ({@link DocumentManagementService.recover}), and permanent purge once the
 * window has elapsed ({@link DocumentManagementService.purgeExpired}), with the
 * boundary arithmetic in the pure {@link isWithinRecoveryWindow} /
 * {@link recoveryDeadlineMs} core and {@link DEFAULT_RECOVERY_WINDOW_MS}
 * (Req 28.7, Property 60). It composes the tenant-scoped {@link DocumentStore}
 * (Req 1.2, 1.4), the shared {@link ObjectStore} and {@link AuditRecorder}, and
 * the ingestion/backup/compliance/authorizer seams plus an injectable clock, so
 * it is fully unit-testable with the fakes in `./document-management/fakes.js`.
 * The injectable clock is surfaced as {@link DocumentClock}/{@link systemDocumentClock}
 * to avoid colliding with the Model_Router's, Scheduler's, or Cache_Manager's
 * clocks in this barrel; the exported names are otherwise `Document`-/`Doc`-/
 * `Folder`-/`Retention`-prefixed so they never collide with sibling modules.
 */
export * from './document-management/index.js';

/**
 * Budget_Manager (Req 22.1-22.6): the spend-tracking and budget-enforcement
 * service across every level of the tenant hierarchy — Organization, Team,
 * Project, and user. {@link BudgetManager.recordUsage} attributes one completed
 * billable request's cost to its originating user, Project, Team, and
 * Organization at once (Req 22.1) and notifies + audits the responsible
 * administrator when the resulting spend crosses a configured alert threshold or
 * cap (Req 22.2); {@link BudgetManager.setBudget}/`getBudget` set and read a
 * scope's validated {@link BudgetConfig} (rejecting an invalid configuration
 * with {@link InvalidBudgetConfigError} and auditing the mutation, Req 22.2-22.5);
 * {@link BudgetManager.consumed} totals a scope's spend in its active period and
 * {@link BudgetManager.evaluate} returns the non-mutating {@link BudgetEvaluation}
 * status (under / threshold-warning / at-or-over-cap) with consumed and
 * remaining amounts; and {@link BudgetManager.enforce} renders the fail-closed
 * {@link BudgetDecision} — block a user at the user cap (Req 22.3), restrict a
 * team at the team cap to Economy models (Req 22.4), and reject a model over its
 * per-model daily message limit for the day (Req 22.5). Every consumed figure is
 * measured over the budget's current period window ({@link periodWindow} /
 * {@link dayWindow}), which simply advances each period so a budget resets
 * without ever deleting the 2-year-retained usage history (Req 22.6). It
 * composes five injectable ports — {@link BudgetStore}, {@link UsageStore}, the
 * shared {@link AuditRecorder}, {@link BudgetClock}, and an optional
 * {@link BudgetAlertNotifier} — so it is fully unit-testable with the fakes in
 * `./budget/fakes.js`.
 *
 * The injectable clock is surfaced as {@link BudgetClock}/{@link systemBudgetClock}
 * and the configuration as {@link BudgetConfig} (not `Budget`) so they never
 * collide with the Model_Router's `Clock`/`systemClock` or the Tenancy_Service's
 * opaque `Budget` type in this barrel.
 */
export * from './budget/index.js';

/**
 * Integration_Service (Req 30.1-30.5): the service that manages an
 * Organization's OPTIONAL external interoperability. It offers the supported
 * first-class integrations GitHub, email, and enterprise identity providers
 * (Req 30.1) and lets an Organization enable the optional interoperability
 * connectors Notion, Slack, Confluence, SharePoint, and Google Drive (Req 30.2)
 * — none of which is ever required for the platform's native operation: chat,
 * knowledge, messaging, documents, and search are delivered through native
 * modules with no required external connector (Req 30.3), and when a connector
 * is unavailable native modules keep operating uninterrupted while the
 * connector's status is reported (Req 30.4). {@link IntegrationService.enableConnector}
 * registers/turns on a connector with non-secret config and an optional
 * credential reference; {@link IntegrationService.disableConnector} turns one off
 * without affecting native operation; {@link IntegrationService.storeCredentials}
 * writes raw connector credentials to the platform {@link SecretStore} under a
 * generated {@link CredentialReference} and stores ONLY that reference on the
 * connector record, excluding the secret from every persisted record, audit
 * event, log, and status projection (Req 30.5); {@link IntegrationService.listStatus}
 * reports each connector's enable/availability/health status (Req 30.4); and the
 * never-throwing {@link IntegrationService.isAvailable} answers "is connector X
 * available for this Organization?" by degrading gracefully — an unknown,
 * unregistered, disabled, or unhealthy connector resolves to `available: false`
 * rather than throwing (Req 30.3, 30.4). It composes the tenant-scoped
 * {@link ConnectorStore} (Req 1.2, 1.4), the shared {@link AuditRecorder}, the
 * platform {@link SecretStore}, and an injectable {@link ConnectorHealthProber}
 * (always called defensively), so it is fully unit-testable with the fakes in
 * `./integrations/fakes.js`.
 *
 * SECURITY: connector credentials are stored BY REFERENCE only — the raw secret
 * lives in the secret store under a non-secret handle and is never persisted on
 * the connector record, recorded in an audit event, or surfaced in a status.
 *
 * The injectable clock is surfaced as {@link IntegrationClock}/{@link systemIntegrationClock}
 * and the domain names are `Integration`-/`Connector`-prefixed (e.g.
 * {@link IntegrationConnector}, {@link ConnectorStatus}) so they never collide
 * with sibling modules' clocks or types in this barrel.
 */
export * from './integrations/index.js';

/**
 * Content_Safety_Filter (Req 36.1, 36.2, 36.3, 36.4, 36.5): the component that
 * screens AI inputs and outputs so the platform resists prompt injection and
 * prevents data leakage. {@link ContentSafetyFilter.screenInput} classifies an
 * inbound prompt through the narrow injectable {@link SafetyClassifier} port
 * (explicitly NOT an embedded moderation model), maps it to an allow/flag/block
 * {@link ContentSafetyDecision} under the configurable {@link SafetyPolicy}
 * ({@link decideSafety}), masks detected PII (Req 36.1), and returns the
 * configured system prompt UNCHANGED so a detected prompt-injection attempt can
 * never override it (Req 36.2 / Property 48); {@link ContentSafetyFilter.scanOutput}
 * masks detected PII in an outbound response before delivery (Req 36.3). Every
 * block is recorded through the shared {@link AuditRecorder} port scoped to the
 * originating Organization (Req 36.2, 37.1), and any flagged or blocked
 * conversation — plus a user-reported one via
 * {@link ContentSafetyFilter.queueForReview} — is queued through the injectable
 * {@link ReviewQueue} port for human review (Req 36.4, 36.5). The policy is the
 * single configurability knob (per-{@link SafetyCategory} {@link SafetyAction}
 * mappings, a confidence threshold, a PII-masking toggle, and an `open`/`closed`
 * fail mode chosen when the classifier cannot be consulted — default
 * fail-closed); {@link ContentSafetyFilter.screenInputOrThrow} /
 * {@link ContentSafetyFilter.scanOutputOrThrow} raise a typed
 * {@link ContentBlockedError} projecting into a serializable `validation`
 * {@link import('@auxify/types').PlatformError} (Req 46.8) that carries only the
 * surface, triggering category labels, and injection flag — never the offending
 * content. Fully unit-testable with the fakes in `./content-safety/fakes.js` —
 * no real moderation model, database, or work queue. The exported names are
 * `ContentSafety`-/`Safety`-/`Pii`-/`Review`-prefixed and otherwise distinct so
 * they never collide with sibling modules' barrel exports.
 */
export * from './content-safety/index.js';

/**
 * Backup_Service (Req 39.1-39.4): the platform's point-in-time backup,
 * integrity verification, restore, and retention service. The
 * {@link BackupService} captures scheduled point-in-time backups of the durable
 * data stores — the Primary_Database, the Vector_Store, and the Object_Store
 * (Req 39.1) — through a per-{@link BackupTargetKind} {@link BackupSource}
 * registry, persisting each snapshot's bytes by reference in the shared
 * {@link ObjectStore} (Req 44.5), then verifies the snapshot's integrity by
 * reading it back and comparing the {@link checksumOf} digest and records the
 * verified/failed outcome on the catalog entry (Req 39.2,
 * {@link BackupService.backup} / {@link BackupService.backupAll}); lists a
 * target's retained backups most-recent recovery point first
 * ({@link BackupService.listBackups}, Req 39.4); restores a target to a selected
 * recovery point — an explicit id, the latest at-or-before a cutoff, or simply
 * the latest — re-verifying integrity before touching the live store so a
 * corrupted snapshot fails closed ({@link BackupService.restore}, Req 39.2,
 * 39.3, 39.4); and discards a single backup ({@link BackupService.discard}) or
 * ages out exactly the backups whose retention window has elapsed
 * ({@link BackupService.purgeExpired}) via the pure {@link isWithinRetention} /
 * {@link isRetentionExpired} / {@link retentionDeadlineMs} core and
 * {@link DEFAULT_BACKUP_RETENTION_MS} (Req 39.4). It is the platform seam the
 * Document_Management_Service's recovery window
 * ({@link DocumentBackupStore}) is the narrow, per-document projection of. Every
 * external capability is a narrow injectable port — the {@link BackupSource}
 * registry, the shared {@link ObjectStore}, a tenant-scoped
 * {@link BackupRecordStore} catalog, the shared {@link AuditRecorder} (every
 * action is recorded, Req 39.2), and a {@link BackupClock} — so it is pure
 * orchestration and fully unit-testable with the fakes in `./backup/fakes.js`.
 *
 * Tenancy: snapshot bytes are keyed under the owning Organization and the
 * catalog is Organization-scoped, so a backup never crosses a tenant boundary
 * (Req 1.4). Typed errors ({@link UnsupportedBackupTargetError},
 * {@link BackupNotFoundError}, {@link BackupIntegrityError}) project into the
 * serializable {@link import('@auxify/types').PlatformError} (Req 46.8). The
 * injectable clock is surfaced as {@link BackupClock}/{@link systemBackupClock}
 * and the domain names are `Backup`-prefixed so they never collide with the
 * Model_Router's, Scheduler's, Cache_Manager's, Budget_Manager's, or
 * Document_Management_Service's identically-purposed clocks/types in this barrel.
 */
export * from './backup/index.js';

/**
 * Compliance_Manager (Req 38.1-38.6, 28.6): the platform's data-governance gate.
 * It enforces the Organization's configured data-retention policy across
 * conversations, files, and documents (Req 38.1-38.3, 28.6); honours legal
 * holds — a held resource is exempt from retention deletion; supports
 * data-subject deletion / right-to-erasure on offboarding within 30 days
 * (Req 38.4) and on a GDPR request within 72 hours (Req 38.5); and — fail-closed
 * — blocks any operation whose retention/privacy compliance cannot be verified
 * (Req 38.6). Every governance action is recorded in the Audit_Service (Req 38.2,
 * 38.5, 38.6, 28.6). {@link ComplianceManager.setRetentionPolicy}/`getRetentionPolicy`/
 * `resolveRetentionDays` set, read, and resolve a scope's validated policy with
 * Project > Team > Organization precedence; {@link ComplianceManager.placeLegalHold}/
 * `releaseLegalHold`/`isOnLegalHold` manage holds; {@link ComplianceManager.evaluateRetention}/
 * `enforceRetention` select and act on exactly the due-and-unheld resources
 * (Property 53); {@link ComplianceManager.eraseSubject} erases subject data within
 * the regulatory deadline; and {@link ComplianceManager.verifyCompliance}/`verifyOrThrow`
 * are the fail-closed gate (Req 38.6). It composes injectable ports — a
 * tenant-scoped {@link RetentionPolicyStore} and {@link LegalHoldStore}, the
 * shared {@link AuditRecorder}, a {@link ComplianceClock}, and the optional
 * {@link RetentionEnforcer}/{@link SubjectDataEraser} seams — so it is fully
 * unit-testable with the fakes in `./compliance/fakes.js`.
 *
 * The injectable clock is surfaced as {@link ComplianceClock}/{@link systemComplianceClock}
 * and the disposition as {@link RetentionDisposition} (not the
 * Document_Management_Service's `RetentionAction`) so the names never collide
 * with sibling modules' clocks or types in this barrel.
 */
export * from './compliance/index.js';

/**
 * Auth_Service (Req 33.1-33.9, 33.12, 33.13): the authentication service that
 * authenticates users, establishes and validates sessions, issues and refreshes
 * tokens, associates external identities, and enforces multi-factor
 * authentication. Per Req 33.1 it is built "on BetterAuth" — modelled behind the
 * narrow injectable {@link AuthProvider} seam (BetterAuth is NOT a compile-time
 * dependency of this package; the concrete BetterAuth adapter that owns password
 * hashing and the OAuth/OIDC, SAML 2.0, and MFA-secret flows is wired in the
 * application layer). {@link AuthService} signs a user in with email/password
 * (Req 33.2), OAuth/OIDC (Req 33.3), or enterprise SSO via SAML 2.0 (Req 33.4),
 * gates session establishment on the resolved MFA requirement — per-user,
 * privileged role, or org policy (Req 33.5-33.7, the pure
 * {@link resolveMfaRequirement} core validated by Property 51) — and on success
 * issues a short-lived access token plus a refresh token (Req 33.8);
 * {@link AuthService.validate} accepts a live session and rejects an expired or
 * revoked one (Req 33.8, 33.13); {@link AuthService.refresh} reissues an access
 * token from a valid refresh token (Req 33.9); {@link AuthService.signOut}
 * revokes a session so its tokens are rejected thereafter (Req 33.13);
 * `associateIdentity`/`listIdentities` manage SSO associations (Req 33.3, 33.4);
 * and `beginMfaEnrollment`/`verifyMfaEnrollment` enroll and activate second
 * factors (Req 33.5). Every FAILED authentication is recorded in the
 * Audit_Service (Req 33.12) and sign-in/sign-out are audited (Req 37.1).
 *
 * SECURITY: the service never persists, logs, or echoes a raw password, MFA
 * secret, or session token — credential and second-factor verification are
 * delegated entirely to the {@link AuthProvider}; only one-way token hashes are
 * stored on a session record (Req 35.4), and raw tokens are returned to the
 * caller exactly once at issuance.
 *
 * The injectable clock is surfaced as {@link AuthClock} (not `Clock`) and the
 * token/session domain names are auth-specific (e.g. {@link Session},
 * {@link IssuedTokens}, {@link VerifiedIdentity}) so they never collide with
 * sibling modules' clocks or types in this barrel. The crypto `constantTimeEqual`
 * helper is kept module-private so it does not collide with the API_Key_Manager's
 * same-named export; both remain available from their own modules. The in-memory
 * test fakes live in `./auth/fakes.js` and are imported directly by the tests.
 */
export * from './auth/index.js';

/**
 * Device_Manager (Req 33.10, 33.11, 33.13, 20.5): the service that lets a user
 * or an administrator see and control the sessions that authenticate as a user.
 * {@link DeviceManager} lists a user's ACTIVE devices and sessions with their
 * last-active time (Req 33.10), revokes a single device's session tokens while
 * leaving the user's other devices signed in (Req 33.11), revokes one session
 * on sign-out (Req 33.13), and — on administrative user deactivation —
 * invalidates EVERY active session AND records the account as deactivated so the
 * user can no longer authenticate (Req 20.5). It COMPOSES the Auth_Service's
 * session model: the SAME {@link SessionStore} the {@link AuthService} writes is
 * injected, so a revocation here is immediately visible to `validate` /
 * `refresh` (a revoked session retains its one-way token hashes — exactly as
 * `AuthService.signOut` does — so a later validate/refresh rejects with the
 * precise {@link InvalidSessionError} reason `'revoked'`). {@link toDeviceSession}
 * is the pure record→masked projection that drops every token hash so it never
 * crosses the service boundary; the "prevent the user from authenticating" half
 * of Req 20.5 is the narrow injectable {@link DeactivationStore} the sign-in
 * path consults.
 *
 * The injectable clock is surfaced as {@link DeviceClock} / {@link systemDeviceClock}
 * (not `Clock` / `systemClock`) and the domain names are `Device`-prefixed so
 * they never collide with the Auth_Service's, Model_Router's, Scheduler's, or
 * Backup_Service's identically-purposed clocks/types in this barrel. The auth
 * {@link SessionStore} / {@link SessionRecord} are consumed as TYPES only and
 * are NOT re-exported here (the auth barrel already exports them). The in-memory
 * test fakes live in `./device/fakes.js` and are imported directly by the tests.
 */
export * from './device/index.js';

/**
 * Security_Gateway (Req 34.1, 34.2, 34.3, 34.4, 34.5, 34.6, 34.8): the
 * request-edge guard every client request passes through before it reaches a
 * backend service. {@link SecurityGateway.evaluate} composes the platform's
 * network and application defenses into a single fail-closed verdict, applying
 * its stages in order — TLS 1.3 enforcement (Req 34.1), IP / abuse gating,
 * per-user / per-key / per-IP rate limiting through the injectable
 * {@link RateLimiter} (Req 34.3), input validation + sanitization with XSS-safe
 * output encoding (Req 34.4, 34.5), a CSRF token on state-changing requests
 * (Req 34.6), authentication before routing through the injectable
 * {@link Authenticator} (Req 34.2), and authorization through the optional
 * {@link Authorizer} (Req 34.8). It denies by default — any failing stage, or
 * any guard that errors, refuses the request (`fail_closed`) — recording every
 * denial through the shared {@link AuditRecorder} port (Req 37.1) and, on an
 * allow, handing the backend the authenticated {@link Principal} plus the
 * sanitized request body. `evaluateOrThrow` throws a {@link RequestDeniedError}
 * that projects to a category-correct {@link PlatformError} (Req 46.8). It ships
 * default guards — {@link InMemoryRateLimiter}/{@link NoopRateLimiter},
 * {@link StaticIpReputation}/{@link AllowAllIpReputation},
 * {@link DefaultRequestValidator}, {@link DoubleSubmitCsrfVerifier} — plus the
 * pure {@link sanitizeText}/{@link sanitizeDeep}/{@link encodeForOutput}/
 * {@link containsDisallowedConstructs} helpers, so it is fully unit-testable with
 * the fakes in `./security-gateway/fakes.js`.
 *
 * The injectable clock is surfaced as {@link SecurityGatewayClock}/
 * {@link systemSecurityGatewayClock} so it never collides with the
 * Model_Router's, Scheduler's, Cache_Manager's, Budget_Manager's, or
 * Document_Management's clocks in this barrel. Re-exported by name (not
 * `export *`) so the four identifiers it shares with sibling modules are aliased
 * at this barrel and never collide: the rate-limit port and value type are
 * surfaced as {@link GatewayRateLimiter} / {@link GatewayRateLimit} (the
 * Web_Scraper keeps the unqualified `RateLimiter`/`NoopRateLimiter`, the
 * API_Key_Manager keeps `RateLimit`), the default rate limiter as
 * {@link NoopGatewayRateLimiter}, and the CSRF comparator as
 * {@link csrfConstantTimeEqual} (the API_Key_Manager keeps `constantTimeEqual`).
 * Every name remains available unaliased from `./security-gateway/index.js`. The
 * rest of the rate-limit model ({@link RateLimitConfig}, {@link RateLimitKey},
 * {@link RateLimitDecision}, {@link RateLimitDimension}) is exported as-is.
 */
export {
  SecurityGateway,
  DEFAULT_RATE_LIMIT_CONFIG,
  InMemoryRateLimiter,
  NoopRateLimiter as NoopGatewayRateLimiter,
  StaticIpReputation,
  AllowAllIpReputation,
  DefaultRequestValidator,
  sanitizeText,
  sanitizeDeep,
  encodeForOutput,
  containsDisallowedConstructs,
  MAX_PATH_LENGTH,
  DoubleSubmitCsrfVerifier,
  constantTimeEqual as csrfConstantTimeEqual,
  RequestDeniedError,
  REQUEST_DENIED_CODE,
  REQUIRED_TLS_VERSION,
  HTTP_METHODS,
  STATE_CHANGING_METHODS,
  RATE_LIMIT_DIMENSIONS,
  systemSecurityGatewayClock,
  type SecurityGatewayOptions,
  type DefaultRequestValidatorOptions,
  type HttpMethod,
  type TransportInfo,
  type GatewayRequest,
  type GatewayVerdict,
  type GatewayDenialCode,
  type RateLimit as GatewayRateLimit,
  type RateLimitConfig,
  type RateLimitKey,
  type RateLimitDecision,
  type RateLimitDimension,
  type RateLimiter as GatewayRateLimiter,
  type IpReputation,
  type IpReputationVerdict,
  type Authenticator,
  type AuthOutcome,
  type RequestValidator,
  type ValidationResult,
  type CsrfVerifier,
  type Authorizer,
  type AuthzOutcome,
  type SecurityGatewayClock,
} from './security-gateway/index.js';

/**
 * Encryption + secret storage (Req 34.7, 35.1, 35.2, 35.3, 35.5): the platform's
 * field-level / at-rest encryption primitive and its by-reference secret store.
 * The pure {@link encrypt} / {@link decrypt} / {@link decryptToString} core turns
 * a value plus a {@link DataKey} into a self-describing, authenticated
 * AES-256-GCM {@link EncryptionEnvelope} and back — built entirely on Node's
 * built-in `node:crypto`, generating a fresh random IV per encryption and
 * FAILING CLOSED on any tampering (a wrong key, an altered ciphertext / IV / tag,
 * or missing / mismatched additional authenticated data raises a
 * {@link DecryptionError}) (Req 35.1, 35.3); {@link serializeEnvelope} /
 * {@link deserializeEnvelope} render an envelope to a JSON- and column-safe
 * string. On top of it the {@link EncryptedSecretStore} persists secrets BY
 * REFERENCE in encrypted form (Req 34.7): {@link EncryptedSecretStore.putSecret}
 * encrypts under the {@link KeyProvider}'s active key, binds the ciphertext to
 * its `(organizationId, reference)` via additional authenticated data so it can
 * never be replayed under another tenant or reference (Req 1.4, 35.3), pins
 * storage to the configured residency region when a {@link ResidencyResolver} is
 * present (Req 35.5), and hands the {@link SecretBackend} only ciphertext;
 * {@link EncryptedSecretStore.getSecret} resolves the SPECIFIC key the envelope
 * names so a secret written before a key rotation still decrypts (Req 35.1);
 * {@link EncryptedSecretStore.getMetadata} reports non-secret
 * {@link SecretMetadata} without decrypting; and
 * {@link EncryptedSecretStore.encryptField} / {@link EncryptedSecretStore.decryptField}
 * expose the same envelope core as a serialized-string pair for
 * designated-sensitive-field encryption (Req 35.3). The plaintext, key material,
 * and raw ciphertext are never returned, logged, or surfaced (Req 34.7); at-rest
 * encryption is AES-256-GCM (Req 35.2) and TLS 1.3 in transit (Req 35.2) is
 * enforced by the transport layer (the Security_Gateway). In production the
 * {@link KeyProvider} is AWS KMS / Azure Key Vault and the {@link SecretBackend}
 * is AWS Secrets Manager / Azure Key Vault; the service is pure orchestration
 * over these injectable ports, so it is fully unit-testable with the in-memory
 * fakes in `./encryption/fakes.js`, which — following the established
 * convention — are NOT re-exported here and are imported directly by the tests.
 *
 * The persistence seam is named {@link SecretBackend} and the service
 * {@link EncryptedSecretStore} so they never collide with the
 * Integration_Service's narrow `SecretStore` port in this barrel, and the
 * injectable clock is surfaced as {@link EncryptionClock} /
 * {@link systemEncryptionClock} so it never collides with sibling modules'
 * identically-purposed clocks; a plain re-export is therefore collision-free.
 */
export * from './encryption/index.js';

/**
 * Monitoring_Service (Req 42.8, 42.9, 46.6, 46.7, 39.8): the platform's
 * observability service. The {@link MonitoringService} collects the four metric
 * categories — system, application, business, and AI (Req 42.8,
 * {@link MonitoringService.recordMetric} / {@link MonitoringService.recordMetrics});
 * on each collected {@link MetricPoint} it evaluates every configured
 * {@link AlertThreshold} for that metric (via the pure {@link thresholdBreached})
 * and dispatches an {@link Alert} through the threshold's channel when it is
 * crossed (Req 42.9); it emits structured, JSON-serializable, secret-free
 * {@link StructuredLogEntry} logs carrying a correlation identifier that traces
 * a request across services ({@link MonitoringService.log} /
 * {@link MonitoringService.logger}, Req 46.7); it records distributed-tracing
 * {@link TraceSpan}s tied to that same trace/correlation id
 * ({@link MonitoringService.startSpan} / {@link MonitoringService.endSpan},
 * Req 42.8); and it produces the per-service {@link HealthReport} and
 * {@link ReadinessReport} the REST_API exposes as health-check and readiness
 * endpoints — liveness is the worst-status-wins aggregate of the registered
 * checks and readiness gates on every readiness check being healthy
 * ({@link MonitoringService.health} / {@link MonitoringService.readiness} over
 * the pure {@link aggregateStatus} / {@link aggregateOutcomes} / {@link isReady}
 * core, Req 46.6, 39.8). The HTTP wiring of those endpoints is the REST_API's
 * job; this module exposes the report-producing methods.
 *
 * Every external capability is a narrow injectable port — a {@link LogSink}, an
 * optional {@link Tracer}, an {@link AlertDispatcher}, an optional
 * {@link MetricStore}, a {@link HealthCheck} registry, and a
 * {@link MonitoringClock} — so the service is pure orchestration and fully
 * unit-testable with the in-memory fakes in `./monitoring/fakes.js` (NOT
 * re-exported here, per the established convention). It is fail-soft: a throwing
 * sink/tracer/dispatcher is swallowed and a throwing health probe resolves to
 * `unhealthy`, so losing observability never breaks the observed work.
 *
 * SECURITY: logs and traces are secret-free (Req 34.7 discipline) — a token,
 * password, or secret-store value is never placed in a log message/field or a
 * span attribute; secrets are referenced by name only. A
 * {@link import('@auxify/types').PlatformError}'s `correlationId` (Req 46.7) is
 * the same id a {@link StructuredLogEntry} and a {@link TraceSpan} carry, so an
 * error, its logs, and its trace share one identifier end to end.
 *
 * The injectable clock is surfaced as {@link MonitoringClock} /
 * {@link systemMonitoringClock} (not `Clock` / `systemClock`) so it never
 * collides with sibling modules' identically-purposed clocks in this barrel;
 * the {@link HealthStatus} / {@link HealthCheck} / {@link Alert} domain names are
 * unique across the barrel, so a plain re-export is collision-free (the
 * provider-layer's `HealthStatus` in `@auxify/types` is a distinct, un-exported
 * shape).
 */
export * from './monitoring/index.js';

/**
 * Analytics_Service (Req 31.1-31.8): the platform's usage, cost, performance,
 * agent, and RAG analytics aggregation and query layer over the request
 * outcomes the Model_Router already records (Req 3.9) — it aggregates and
 * queries, it never re-routes or re-prices. The {@link AnalyticsService} records
 * a granular per-request {@link RequestMetric} when a billable or trackable
 * request completes (the model, provider, input/output tokens, cost, latency,
 * request type, and tool-call count, Req 31.1) plus granular
 * {@link AgentRunMetric} (Req 31.5) and {@link RagMetric} (Req 31.6) records, and
 * reports the dashboard's aggregations over an authorized, time-bounded
 * {@link AnalyticsPeriod}: usage — total requests, tokens, cost, active users
 * ({@link AnalyticsService.usageSummary}, Req 31.2); cost grouped by model,
 * Team, Project, and user ({@link AnalyticsService.costBreakdown}, Req 31.3);
 * performance — p50/p95/p99 latency, time-to-first-token, error rate
 * ({@link AnalyticsService.performance}, Req 31.4); agent run count, steps per
 * run, success rate, cost per run ({@link AnalyticsService.agentMetrics},
 * Req 31.5); and RAG relevance + source-attribution rate
 * ({@link AnalyticsService.ragMetrics}, Req 31.6). Every query is restricted to
 * the Organization, Teams, and Projects the administrator is authorized to view
 * through the injectable {@link ScopeAuthorizer} — an out-of-scope narrowing
 * fails closed with an {@link UnauthorizedAnalyticsScopeError}, so a query never
 * returns data outside the viewer's authorized scope (Req 31.7) — and granular
 * data is purged once its 90-day window elapses
 * ({@link AnalyticsService.purgeExpired}) while aggregated data is retained for
 * 2 years ({@link GRANULAR_RETENTION_DAYS} / {@link AGGREGATED_RETENTION_DAYS},
 * Req 31.8). The aggregation arithmetic is the pure, separately-tested core
 * ({@link percentile}, {@link errorRate}, {@link activeUserCount},
 * {@link groupCostBy}, and the `summarize*` helpers). Every external capability
 * is a narrow injectable port — the {@link MetricStore} (append, period-filtered
 * reads, and the retention seam), the {@link ScopeAuthorizer}, the shared
 * {@link AuditRecorder} (denied queries and purges are recorded, Req 37.1), and
 * an {@link AnalyticsClock} — so it is pure orchestration and fully
 * unit-testable with the in-memory fakes in `./analytics/fakes.js`, which —
 * following the established convention — are NOT re-exported here and are
 * imported directly by the tests.
 *
 * The injectable clock is surfaced as {@link AnalyticsClock} /
 * {@link systemAnalyticsClock} and the window type as {@link AnalyticsPeriod}
 * (not a bare `Clock` / `Period`) so they never collide with sibling modules'
 * identically-purposed clocks or types in this barrel; the analytics names are
 * otherwise `Analytics`-/`Request`-/`Rag`-prefixed or distinct.
 *
 * Re-exported by name (not `export *`) so the one identifier it shares with the
 * Monitoring_Service — the metric-store port `MetricStore` — is aliased at this
 * barrel and never collides: the analytics store port is surfaced as
 * {@link AnalyticsMetricStore} (the Monitoring_Service keeps the unqualified
 * `MetricStore`); it remains available unaliased from `./analytics/index.js`.
 * The module's internal `MS_PER_DAY` day-conversion constant is likewise NOT
 * re-exported here because the Compliance_Manager already exports that name in
 * this barrel; it remains available from `./analytics/types.js`.
 */
export {
  AnalyticsService,
  percentile,
  errorRate,
  activeUserCount,
  groupCostBy,
  summarizeUsage,
  summarizeCost,
  summarizePerformance,
  summarizeAgentRuns,
  summarizeRag,
  UNATTRIBUTED_GROUP_KEY,
  UnauthorizedAnalyticsScopeError,
  UNAUTHORIZED_ANALYTICS_SCOPE_CODE,
  systemAnalyticsClock,
  REQUEST_TYPES,
  isRequestType,
  GRANULAR_RETENTION_DAYS,
  AGGREGATED_RETENTION_DAYS,
  type AnalyticsServiceOptions,
  type AnalyticsIdGenerator,
  type RecordRequestInput,
  type RecordAgentRunInput,
  type RecordRagInput,
  type PurgeReport,
  type AnalyticsScopeDimension,
  type RequestType,
  type RequestMetric,
  type AgentRunMetric,
  type RagMetric,
  type AnalyticsPeriod,
  type AnalyticsScope,
  type AnalyticsViewer,
  type ScopeAuthorizer,
  type ScopeNarrowing,
  type AnalyticsQueryOptions,
  type MetricStore as AnalyticsMetricStore,
  type MetricQuery,
  type AnalyticsClock,
  type UsageSummary,
  type CostGroup,
  type CostBreakdown,
  type PerformanceSummary,
  type AgentSummary,
  type RagSummary,
} from './analytics/index.js';

/**
 * Report_Generator (Req 32.1-32.3): the platform's downloadable-report
 * production service, sitting ALONGSIDE the Analytics_Service. The
 * {@link ReportGenerator} produces a report in PDF or CSV (Req 32.1,
 * {@link ReportGenerator.generate}) across the seven required report types
 * (Req 32.2) — `executive_summary`, `cost_report`, `team_usage`,
 * `project_usage`, `model_performance`, `security_audit`, and
 * `knowledge_base_health` ({@link REPORT_TYPES}) — resolving the requesting
 * administrator's authorized scope through the shared
 * {@link import('./analytics/index.js').ScopeAuthorizer}, assembling each
 * report's format-agnostic {@link ReportDocument} ({@link ReportSection} tables)
 * from its scope-restricted sources, and serializing it to a downloadable
 * {@link GeneratedReport} (the rendered `bytes`, the matching `application/pdf` /
 * `text/csv` `contentType`, and a `filename`). An unsupported type or format
 * fails closed with the typed {@link UnsupportedReportError}; a report whose
 * required data source is not configured fails closed with a
 * {@link ReportSourceUnavailableError}.
 *
 * It REUSES the Analytics_Service's authorized-scope model to satisfy Req 32.3
 * (the same scoping the Analytics_Service enforces under Req 31.7): every data
 * fetch passes the requesting viewer plus the request's optional scope narrowing
 * to a scope-restricted source, and a narrowing to an unauthorized Team /
 * Project fails closed with an {@link UnauthorizedReportScopeError}, so a report
 * can never include data outside the viewer's authorized Organization, Teams,
 * and Projects. The cost / usage / performance / agent reports draw from the
 * {@link AnalyticsDataSource} — a port mirroring the Analytics_Service's read
 * surface, so the real {@link AnalyticsService} satisfies it directly — while the
 * security_audit and knowledge_base_health reports draw from the narrow
 * {@link SecurityAuditSource} and {@link KnowledgeHealthSource}.
 *
 * The format rendering is split by responsibility: CSV is produced PURELY
 * IN-MODULE by {@link reportToCsv} (RFC-4180 quoting, CRLF endings), while PDF is
 * delegated to the injectable {@link ReportRenderer} port — NO PDF dependency is
 * bundled in `@auxify/core`; production wires a real PDF engine and tests
 * substitute a deterministic text-bytes renderer.
 *
 * Every external capability is a narrow injectable port — the
 * {@link AnalyticsDataSource}, the optional {@link SecurityAuditSource}, the
 * optional {@link KnowledgeHealthSource}, the {@link ReportRenderer}, the
 * optional {@link import('./analytics/index.js').ScopeAuthorizer}, and a
 * {@link ReportClock} — so the generator is pure orchestration and fully
 * unit-testable with the in-memory fakes in `./reporting/fakes.js`, which —
 * following the established convention — are NOT re-exported here and are
 * imported directly by the tests.
 *
 * Re-exported by name (not `export *`) so the one identifier it shares with the
 * Output_Renderer — the CSV serializer `toCsv` — is aliased at this barrel and
 * never collides: the report CSV serializer is surfaced as {@link reportToCsv}
 * (the Output_Renderer keeps the unqualified `toCsv`); it remains available
 * unaliased from `./reporting/index.js`. The injectable clock is surfaced as
 * {@link ReportClock} / {@link systemReportClock} and the domain names are
 * `Report`-prefixed so they never collide with sibling modules' clocks. The
 * shared analytics scope vocabulary ({@link AnalyticsViewer},
 * {@link AnalyticsScope}, {@link ScopeAuthorizer}, {@link ScopeNarrowing},
 * {@link AnalyticsPeriod}, {@link AnalyticsQueryOptions}) is NOT re-exported here
 * because the Analytics_Service block above already exports it; it remains
 * available unaliased from `./reporting/index.js`.
 */
export {
  ReportGenerator,
  toCsv as reportToCsv,
  toCsvBytes,
  escapeCsvField,
  UnsupportedReportError,
  UnauthorizedReportScopeError,
  ReportSourceUnavailableError,
  UNSUPPORTED_REPORT_CODE,
  UNAUTHORIZED_REPORT_SCOPE_CODE,
  REPORT_SOURCE_UNAVAILABLE_CODE,
  systemReportClock,
  REPORT_FORMATS,
  REPORT_TYPES,
  isReportFormat,
  isReportType,
  type ReportGeneratorOptions,
  type UnsupportedReportDimension,
  type ReportFormat,
  type ReportType,
  type ReportRequest,
  type ReportSection,
  type ReportDocument,
  type GeneratedReport,
  type AnalyticsDataSource,
  type SecurityAuditSource,
  type SecurityAuditRow,
  type KnowledgeHealthSource,
  type KnowledgeHealthStats,
  type ReportRenderer,
  type RenderedReportFile,
  type ReportClock,
} from './reporting/index.js';

/**
 * Chat_Pipeline (Req 4.1, 4.3, 22.1, 24.1, 31.1, 36.1, 36.3): the end-to-end
 * COMPOSITION of the streaming-chat-with-RAG request flow. The
 * {@link ChatPipeline} owns no domain logic of its own — it wires the platform's
 * already-built request-path services through their existing public surfaces
 * into the single ordered flow the design specifies: Security_Gateway →
 * Chat_Service → Budget_Manager → Content_Safety_Filter → RAG_Retriever →
 * Model_Router → Provider → Streaming_Engine → Content_Safety_Filter (output) →
 * Analytics_Service + Budget_Manager. {@link ChatPipeline.run} runs one chat
 * send through every guard in order — evaluating the request-edge
 * {@link SecurityGateway} when wired (Req 34.x), enforcing the
 * {@link BudgetManager} caps before any model call (Req 22.x), screening +
 * PII-masking the input through the {@link ContentSafetyFilter} while preserving
 * the system prompt (Req 36.1), attaching the {@link RagRetriever}'s attributed
 * top-K chunks (or the "none found" signal) when knowledge is enabled (Req 24.1),
 * routing + generating through the {@link ChatService} (Model_Router → provider,
 * Req 3), relaying the collected chunks token-by-token through the
 * {@link StreamingEngine} and emitting a completion event with model + tokens +
 * cost (Req 4.1, 4.3), scanning the delivered output for PII (Req 36.3), and
 * recording exactly one analytics metric (Req 31.1) while attributing the cost
 * up the user → Project → Team → Organization hierarchy (Req 22.1). It is
 * FAIL-CLOSED: any guard denial short-circuits with a {@link ChatPipelineResult}
 * (`ok: false`) carrying the blocking {@link ChatPipelineStage} and the
 * component service's projected {@link import('@auxify/types').PlatformError} —
 * before the model is called and before any spend or metric is recorded — and
 * {@link ChatPipeline.runOrThrow} raises a typed {@link ChatPipelineBlockedError}
 * carrying the same. The Security_Gateway and RAG_Retriever are optional so the
 * pipeline is testable in slices; the remaining collaborators are required. A
 * plain re-export is collision-free: every exported name is `ChatPipeline`-/
 * `CHAT_PIPELINE`-prefixed and unique at this barrel, and the pipeline composes
 * the component services' public types directly rather than re-exporting them.
 * The composition test helpers live in `./chat-pipeline/fakes.js` and — per the
 * established convention — are NOT re-exported here; the tests import them (and
 * each component module's own fakes) directly.
 */
export * from './chat-pipeline/index.js';

/**
 * Native-module ingestion + unified-search wiring (Req 26.8, 27.9, 28.5, 29.1):
 * the COMPOSITION that connects the native content modules' write paths to the
 * Knowledge_Ingestion_Service and the Unified_Search_Service so authorized
 * content created in any module is retrievable through RAG and unified search. It
 * owns no new persistence, embedding, or vector capability — only the adapters
 * and factories that wire the existing services together. {@link NativeIngestionBridge}
 * provides the concrete Knowledge_Hub / Messaging / Document_Management
 * ingestion-on-write emitter adapters: each write stages the content's
 * {@link FetchedDocument} projection in a shared {@link NativeIngestionStagingStore}
 * and drives a Knowledge_Ingestion_Service ingest, so the content is
 * parsed → chunked → embedded → indexed as a retrievable `knowledge_chunk` record
 * with complete {@link import('@auxify/types').SourceAttribution} (Req 26.8, 27.9,
 * 28.5) — fire-and-forget, so a failure is recorded through an
 * {@link IngestionFailureRecorder} and never thrown back to the originating write
 * (Req 23.8). {@link createNativeIngestionBridge} builds the staging store, the
 * {@link StagingSourceFetcher}, the Knowledge_Ingestion_Service, and the bridge as
 * one consistent unit. {@link createUnifiedSearchService} builds a
 * {@link UnifiedSearchService} with one {@link KnowledgeBaseContentSearcher} per
 * content type over the SAME shared `knowledge_chunk` index, so Knowledge_Hub
 * pages, messaging content, documents, AND the non-native knowledge base are all
 * retrievable, grouped by content type and gated per principal (Req 29.1, 29.2);
 * the {@link defaultNativeModuleClassifier} routes each indexed chunk back to its
 * content type by attribution-link scheme. Every exported name is
 * `NativeIngestion`-/`createNativeIngestionBridge`-/`createUnifiedSearchService`-/
 * `KnowledgeBaseContentSearcher`-distinct and unique at this barrel, and the
 * module deliberately re-exports no type already exported by the component
 * modules it composes (the emitter ports, `FetchedDocument`, `UnifiedSearchType`,
 * …); it consumes those by import. The in-memory test fakes live in
 * `./native-ingestion/fakes.js` and — per the established convention — are NOT
 * re-exported here; the tests import them (and each component module's own fakes)
 * directly.
 */
export * from './native-ingestion/index.js';
