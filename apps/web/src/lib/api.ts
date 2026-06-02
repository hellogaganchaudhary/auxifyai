/**
 * Thin client-access layer between the web screens and the Auxify SDK.
 *
 * The SDK (`@auxify/sdk`) is implemented concurrently and its concrete client
 * surface (`AuxifyClient` with `chat`/`streamChat`/`runAgent`/`webSearch`/
 * `knowledgeSearch`/`unifiedSearch`) is still in flux. To keep the web app
 * type-checking and building independently of the SDK's final method
 * signatures, screens depend on this facade rather than on the SDK directly.
 *
 * The facade is structurally typed against the shared `@auxify/types` domain
 * shapes (so the data the screens render matches the eventual wire contract,
 * Req 46.8) and returns deterministic placeholder data today. When the SDK
 * lands, the bodies here can delegate to a real `AuxifyClient` without changing
 * a single screen. We import the package marker `AUXIFY_SDK_PACKAGE` (which
 * exists today) so the SDK link is exercised at build time; we deliberately do
 * not import `@auxify/core`, which is a server-only package.
 */
import { AUXIFY_SDK_PACKAGE } from '@auxify/sdk';
import type {
  ChatMessage,
  ContentBlock,
  ModelInfo,
  ModelTier,
  Role,
  SourceAttribution,
} from '@auxify/types';

/**
 * Identifies which SDK package this facade is wired to. Surfaced in settings so
 * operators can confirm the client/SDK link, and it keeps a real import of the
 * SDK in the web app's build graph.
 */
export const CONNECTED_SDK = AUXIFY_SDK_PACKAGE;

/** A chat conversation summarized for list views. */
export interface ConversationSummary {
  /** Stable conversation id. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** ISO-8601 timestamp of the last activity. */
  updatedAt: string;
  /** A short preview of the latest message. */
  preview: string;
}

/** A single chat message enriched with display metadata for the chat screen. */
export interface ChatMessageView {
  /** Stable message id. */
  id: string;
  /** The underlying shared chat message (role + content), reused from `@auxify/types`. */
  message: ChatMessage;
  /** ISO-8601 timestamp the message was created. */
  createdAt: string;
  /** The model that produced the message, when authored by the assistant. */
  model?: string;
  /** Source attributions for retrieval-augmented answers (Req 24.4). */
  attribution?: SourceAttribution[];
}

/** A reusable prompt template shown in the prompt library. */
export interface PromptTemplateSummary {
  /** Stable template id. */
  id: string;
  /** Template title. */
  title: string;
  /** What the template is for. */
  description: string;
  /** The parameter names the template expects. */
  variables: string[];
  /** Tags used for filtering. */
  tags: string[];
}

/** A knowledge collection in the Knowledge Hub. */
export interface KnowledgeCollectionSummary {
  /** Stable collection id. */
  id: string;
  /** Collection name. */
  name: string;
  /** Short description. */
  description: string;
  /** Number of indexed documents. */
  documentCount: number;
  /** Number of connected sources. */
  sourceCount: number;
}

/** A document/file in Document Management. */
export interface DocumentSummary {
  /** Stable document id. */
  id: string;
  /** File name. */
  name: string;
  /** MIME type. */
  mimeType: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** ISO-8601 timestamp when uploaded. */
  uploadedAt: string;
  /** Indexing status for retrieval. */
  status: 'indexed' | 'processing' | 'failed';
}

/** An indexed knowledge-base document with chunk counts. */
export interface KnowledgeBaseEntry {
  /** Stable document id. */
  id: string;
  /** Document title. */
  title: string;
  /** Owning collection name. */
  collection: string;
  /** Number of indexed chunks. */
  chunkCount: number;
  /** ISO-8601 timestamp last indexed. */
  indexedAt: string;
}

/** A team communication channel. */
export interface ChannelSummary {
  /** Stable channel id. */
  id: string;
  /** Channel name (without leading `#`). */
  name: string;
  /** Topic/description. */
  topic: string;
  /** Count of unread messages for the current user. */
  unread: number;
  /** Number of members. */
  memberCount: number;
}

/** A single channel message. */
export interface ChannelMessageView {
  /** Stable message id. */
  id: string;
  /** Display name of the author. */
  author: string;
  /** Message body. */
  body: string;
  /** ISO-8601 timestamp sent. */
  sentAt: string;
}

/** An agent definition surfaced in the agent builder. */
export interface AgentSummary {
  /** Stable agent id. */
  id: string;
  /** Agent name. */
  name: string;
  /** What the agent does. */
  description: string;
  /** Tool names the agent can call. */
  tools: string[];
  /** The default model id the agent runs on. */
  modelId: string;
  /** Whether the agent is currently enabled. */
  enabled: boolean;
}

/** The lifecycle state of an agent run. */
export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** A single agent run shown in the agent monitor. */
export interface AgentRunView {
  /** Stable run id. */
  id: string;
  /** The agent that produced the run. */
  agentName: string;
  /** Current lifecycle state. */
  status: AgentRunStatus;
  /** ISO-8601 timestamp the run started. */
  startedAt: string;
  /** Wall-clock duration in milliseconds, when finished. */
  durationMs?: number;
  /** Number of steps executed so far. */
  steps: number;
}

/** A single metric card on the analytics dashboard. */
export interface MetricCard {
  /** Stable metric id. */
  id: string;
  /** Metric label. */
  label: string;
  /** Pre-formatted display value (e.g. `$1,240`, `98.2%`). */
  value: string;
  /** Period-over-period change, formatted (e.g. `+12%`). */
  delta: string;
  /** Direction of the change, for accessible coloring/iconography. */
  trend: 'up' | 'down' | 'flat';
}

/** A platform member shown in the admin panel. */
export interface MemberSummary {
  /** Stable user id. */
  id: string;
  /** Display name. */
  name: string;
  /** Email address. */
  email: string;
  /** The member's primary role (reused from `@auxify/types`). */
  role: Role;
  /** Whether the member is active. */
  active: boolean;
}

/** A single result returned by unified search. */
export interface SearchResult {
  /** Stable result id. */
  id: string;
  /** Result title. */
  title: string;
  /** A short snippet/excerpt. */
  snippet: string;
  /** Which surface the result came from. */
  source: 'conversation' | 'knowledge' | 'document' | 'web';
  /** A resolvable link to the result. */
  link: string;
  /** Source attribution, present for knowledge/web results (Req 40.5). */
  attribution?: SourceAttribution;
}

/** A web search result, used by the contextual side panel (Req 40.5). */
export interface WebResult {
  /** Stable result id. */
  id: string;
  /** Result title. */
  title: string;
  /** Result URL. */
  url: string;
  /** A short snippet. */
  snippet: string;
}

/** An artifact preview shown in the contextual side panel (Req 40.5). */
export interface ArtifactPreview {
  /** Stable artifact id. */
  id: string;
  /** Artifact title. */
  title: string;
  /** The renderable content block describing the artifact (reused from `@auxify/types`). */
  block: ContentBlock;
}

// --- Placeholder data ------------------------------------------------------
//
// Deterministic sample data so screens render meaningfully before the SDK is
// wired. Every shape above is reused by the real client, so swapping these
// constants for live `AuxifyClient` calls is a body-only change.

const MODELS: readonly ModelInfo[] = (
  [
    ['gpt-4o', 'azure', 'premium', 'chat', 128000],
    ['claude-3-5-sonnet', 'bedrock', 'standard', 'chat', 200000],
    ['llama-3-8b', 'bedrock', 'economy', 'chat', 8192],
  ] as [string, string, ModelTier, ModelInfo['modality'], number][]
).map(([id, provider, tier, modality, maxTokens]) => ({
  id,
  provider,
  providerModelId: id,
  displayName: id,
  modality,
  tier,
  maxTokens,
  supportsVision: tier !== 'economy',
  supportsTools: true,
  supportsReasoning: tier === 'premium',
  cost: { per1kInputTokens: 0.005, per1kOutputTokens: 0.015 },
  available: true,
}));

function iso(daysAgo: number): string {
  const base = Date.UTC(2025, 0, 15, 9, 0, 0);
  return new Date(base - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The web client facade. A single object of async, typed methods the screens
 * call. Async today (even though data is local) so the call sites already model
 * the eventual network round-trips and need no change when the SDK lands.
 */
export const api = {
  /** The SDK package this facade is connected to. */
  connectedSdk: CONNECTED_SDK,

  /** List the AI models available to the current principal. */
  async listModels(): Promise<ModelInfo[]> {
    return [...MODELS];
  },

  /** List recent chat conversations. */
  async listConversations(): Promise<ConversationSummary[]> {
    return [
      { id: 'c1', title: 'Q3 board deck outline', updatedAt: iso(0), preview: 'Draft the narrative arc for the growth section…' },
      { id: 'c2', title: 'Refactor auth middleware', updatedAt: iso(1), preview: 'Walk through the token refresh edge cases…' },
      { id: 'c3', title: 'Customer churn analysis', updatedAt: iso(3), preview: 'Summarize the top three churn drivers…' },
    ];
  },

  /** Load the messages for a conversation (defaults to a sample thread). */
  async getMessages(_conversationId?: string): Promise<ChatMessageView[]> {
    return [
      {
        id: 'm1',
        createdAt: iso(0),
        message: { role: 'user', content: 'Summarize our Q3 revenue drivers in three bullets.' },
      },
      {
        id: 'm2',
        createdAt: iso(0),
        model: 'gpt-4o',
        message: {
          role: 'assistant',
          content: 'Enterprise expansion, improved net retention, and the new usage-based tier each contributed to Q3 growth.',
        },
        attribution: [
          { sourceId: 's1', sourceTitle: 'Q3 Financials.pdf', location: 'p. 4', link: '/documents/q3-financials' },
        ],
      },
    ];
  },

  /** List reusable prompt templates. */
  async listPrompts(): Promise<PromptTemplateSummary[]> {
    return [
      { id: 'p1', title: 'Meeting summary', description: 'Summarize a transcript into decisions and action items.', variables: ['transcript'], tags: ['productivity'] },
      { id: 'p2', title: 'Code review', description: 'Review a diff for correctness, security, and style.', variables: ['diff', 'language'], tags: ['engineering'] },
      { id: 'p3', title: 'Sales email', description: 'Draft a personalized outreach email.', variables: ['prospect', 'product'], tags: ['sales'] },
    ];
  },

  /** List Knowledge Hub collections. */
  async listKnowledgeCollections(): Promise<KnowledgeCollectionSummary[]> {
    return [
      { id: 'k1', name: 'Engineering Wiki', description: 'Architecture, runbooks, and onboarding.', documentCount: 184, sourceCount: 3 },
      { id: 'k2', name: 'Sales Playbook', description: 'Pitches, objection handling, pricing.', documentCount: 62, sourceCount: 2 },
    ];
  },

  /** List indexed knowledge-base entries. */
  async listKnowledgeBase(): Promise<KnowledgeBaseEntry[]> {
    return [
      { id: 'kb1', title: 'Incident response runbook', collection: 'Engineering Wiki', chunkCount: 42, indexedAt: iso(2) },
      { id: 'kb2', title: 'Enterprise pricing guide', collection: 'Sales Playbook', chunkCount: 18, indexedAt: iso(5) },
    ];
  },

  /** List managed documents/files. */
  async listDocuments(): Promise<DocumentSummary[]> {
    return [
      { id: 'd1', name: 'Q3 Financials.pdf', mimeType: 'application/pdf', sizeBytes: 482_113, uploadedAt: iso(2), status: 'indexed' },
      { id: 'd2', name: 'Onboarding.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 91_204, uploadedAt: iso(4), status: 'processing' },
      { id: 'd3', name: 'architecture.drawio', mimeType: 'application/xml', sizeBytes: 12_880, uploadedAt: iso(9), status: 'failed' },
    ];
  },

  /** List team communication channels. */
  async listChannels(): Promise<ChannelSummary[]> {
    return [
      { id: 'ch1', name: 'general', topic: 'Company-wide announcements', unread: 0, memberCount: 128 },
      { id: 'ch2', name: 'engineering', topic: 'Build status and design chats', unread: 4, memberCount: 36 },
      { id: 'ch3', name: 'support', topic: 'Customer escalations', unread: 12, memberCount: 14 },
    ];
  },

  /** Load messages for a channel (defaults to a sample). */
  async getChannelMessages(_channelId?: string): Promise<ChannelMessageView[]> {
    return [
      { id: 'cm1', author: 'Ada Lovelace', body: 'Deploy to staging is green. ✅', sentAt: iso(0) },
      { id: 'cm2', author: 'Alan Turing', body: 'Reviewing the retrieval latency numbers now.', sentAt: iso(0) },
    ];
  },

  /** List agent definitions. */
  async listAgents(): Promise<AgentSummary[]> {
    return [
      { id: 'a1', name: 'Research Assistant', description: 'Gathers and synthesizes web + knowledge sources.', tools: ['web_search', 'knowledge_search'], modelId: 'gpt-4o', enabled: true },
      { id: 'a2', name: 'Release Notes Bot', description: 'Drafts release notes from merged PRs.', tools: ['github', 'summarize'], modelId: 'claude-3-5-sonnet', enabled: false },
    ];
  },

  /** List recent agent runs. */
  async listAgentRuns(): Promise<AgentRunView[]> {
    return [
      { id: 'r1', agentName: 'Research Assistant', status: 'running', startedAt: iso(0), steps: 3 },
      { id: 'r2', agentName: 'Release Notes Bot', status: 'succeeded', startedAt: iso(1), durationMs: 42_000, steps: 7 },
      { id: 'r3', agentName: 'Research Assistant', status: 'failed', startedAt: iso(1), durationMs: 8_200, steps: 2 },
    ];
  },

  /** Load analytics metric cards. */
  async getMetrics(): Promise<MetricCard[]> {
    return [
      { id: 'mc1', label: 'Active users (30d)', value: '1,284', delta: '+8%', trend: 'up' },
      { id: 'mc2', label: 'Messages sent', value: '92,418', delta: '+14%', trend: 'up' },
      { id: 'mc3', label: 'Avg. cost / day', value: '$312', delta: '-3%', trend: 'down' },
      { id: 'mc4', label: 'P95 latency', value: '1.8s', delta: '0%', trend: 'flat' },
    ];
  },

  /** List platform members for the admin panel. */
  async listMembers(): Promise<MemberSummary[]> {
    return [
      { id: 'u1', name: 'Grace Hopper', email: 'grace@auxify.example', role: 'admin', active: true },
      { id: 'u2', name: 'Katherine Johnson', email: 'katherine@auxify.example', role: 'power_user', active: true },
      { id: 'u3', name: 'Edsger Dijkstra', email: 'edsger@auxify.example', role: 'viewer', active: false },
    ];
  },

  /** Run a unified search across surfaces. */
  async unifiedSearch(query: string): Promise<SearchResult[]> {
    const q = query.trim();
    const base: SearchResult[] = [
      { id: 'sr1', title: 'Q3 revenue drivers', snippet: 'Three drivers contributed to Q3 growth…', source: 'conversation', link: '/chat?c=c1' },
      { id: 'sr2', title: 'Incident response runbook', snippet: 'Page the on-call engineer within 5 minutes…', source: 'knowledge', link: '/knowledge-base#kb1', attribution: { sourceId: 'kb1', sourceTitle: 'Incident response runbook', location: '§2', link: '/knowledge-base#kb1' } },
      { id: 'sr3', title: 'Q3 Financials.pdf', snippet: 'Net retention improved to 118%…', source: 'document', link: '/documents/q3-financials' },
      { id: 'sr4', title: 'Usage-based pricing trends 2025', snippet: 'Vendors increasingly adopt hybrid pricing…', source: 'web', link: 'https://example.com/pricing', attribution: { sourceId: 'web1', sourceTitle: 'example.com', location: 'web', link: 'https://example.com/pricing' } },
    ];
    if (q.length === 0) return base;
    return base.filter((r) => `${r.title} ${r.snippet}`.toLowerCase().includes(q.toLowerCase()));
  },

  /** Fetch web results for the contextual side panel (Req 40.5). */
  async getWebResults(): Promise<WebResult[]> {
    return [
      { id: 'w1', title: 'Usage-based pricing trends 2025', url: 'https://example.com/pricing', snippet: 'Vendors increasingly adopt hybrid pricing models…' },
      { id: 'w2', title: 'Net revenue retention benchmarks', url: 'https://example.com/nrr', snippet: 'Top-quartile SaaS companies sustain 120%+ NRR…' },
    ];
  },

  /** Fetch a sample artifact preview for the contextual side panel (Req 40.5). */
  async getArtifactPreview(): Promise<ArtifactPreview> {
    return {
      id: 'art1',
      title: 'Q3 growth summary',
      block: {
        type: 'markdown',
        data: '# Q3 growth summary\n\n- Enterprise expansion\n- Net retention up to 118%\n- New usage-based tier',
      },
    };
  },

  /** Source attributions backing the current context (Req 40.5). */
  async getSourceAttributions(): Promise<SourceAttribution[]> {
    return [
      { sourceId: 's1', sourceTitle: 'Q3 Financials.pdf', location: 'p. 4', link: '/documents/q3-financials' },
      { sourceId: 's2', sourceTitle: 'Board narrative draft', location: '§ Growth', link: '/chat?c=c1' },
    ];
  },
};

/** The type of the web client facade, for typing props that receive it. */
export type Api = typeof api;
