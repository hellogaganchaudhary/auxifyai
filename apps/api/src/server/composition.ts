/**
 * The API composition root.
 *
 * This is the single place that instantiates the platform's real services and
 * wires them into the framework-agnostic {@link RestApi} dispatcher. It turns
 * the tested library code into a running backend:
 *
 *   - a {@link ConfigModelRegistry} loaded from the default launch catalog;
 *   - real AI provider adapters (AWS Bedrock + Azure) when their credentials
 *     are configured, plus an always-available {@link StubProvider} echo model
 *     so the product works with ZERO credentials;
 *   - a provider router that picks the right adapter per model id;
 *   - the {@link StreamingEngine} relaying provider chunks to SSE;
 *   - the web-search {@link ProviderRotationService} (active only for the search
 *     provider keys the operator supplies);
 *   - dev authentication (a single API key + bearer token) so the bundled web
 *     app can call the API locally;
 *   - resource controllers for the routes the chat product actually uses
 *     (models, web-search, conversations list).
 *
 * NOTE: the dev authenticator is a LOCAL-DEVELOPMENT shim, not the production
 * Auth_Service / API_Key_Manager. It accepts one configured key/token so the
 * local web client is authenticated. Production wiring would inject the real
 * AuthService.validate / ApiKeyManager.authenticate here instead.
 */

import {
  ConfigModelRegistry,
  StreamingEngine,
  StubProvider,
  defaultRegistryConfig,
  BedrockProvider,
  AzureProvider,
  ConversationRepository,
  MessageRepository,
  PgVectorStore,
  InMemoryRateLimiter,
  csrfConstantTimeEqual,
  type AIProvider,
  type KeyAuthResult,
  type MaskedKey,
  type ModelConfig,
  type PartialResponse,
  type SessionIdentity,
} from '@auxify/core';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ModelInfo,
  ModelModality,
  ModelTier,
  Result,
  TenantContext,
} from '@auxify/types';
import { createPlatformError } from '@auxify/types';
import {
  RestApi,
  RestAuthenticator,
  createRouter,
  type AgentRunPort,
  type ChatStreamPort,
  type ChatStreamRequest,
  type ChatStreamSource,
  type ResourceController,
  type RestServices,
  type RouteHandlerContext,
  type SseEvent,
} from '../rest/index';
import { ProviderRotationService } from '../modules/search/provider-rotation.service';

import { extractText, type UploadInput } from './file-extract';
import { generateFile, renderDesignedDocument, type DesignedFormat, type FileFormat, type GeneratedFile } from './file-generate';
import { runDeepResearch, type ResearchEvent } from './deep-research';
import { runDocumentGeneration, type DocumentEvent } from './document-engine';
import { type ThemeId } from './document-design';
import { specFromMarkdown } from './markdown-spec';
import { createEmbedder, type EmbedTexts } from './embeddings-client';
import {
  buildKnowledgeControllers,
  buildKnowledgeRetriever,
  type KnowledgeRetriever,
} from './knowledge';
import { generateImages } from './image-client';
import { createVideoJob, getVideoJob, getVideoContent, type VideoJob } from './video-client';
import { createRealtimeSession, type RealtimeSessionInfo } from './realtime-client';

import { HttpBedrockClient } from './bedrock-client';
import { HttpAzureClient } from './azure-client';
import { HttpFoundryClient } from './foundry-client';
import type { ServerConfig } from './env';
import type { Database } from './database';

/** A model paired with the provider adapter that serves it. */
interface ResolvedProviders {
  /** Provider adapters keyed by their `providerId` (e.g. `bedrock`, `azure`, `stub`). */
  byId: Map<string, AIProvider>;
  /** The model ids that are actually serveable (have a live provider). */
  serveableModelIds: Set<string>;
}

/** A runnable agent definition exposed by `/v1/agents`. */
interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  modelId?: string;
}

/** A generated image returned to the client. */
export interface GeneratedImagePayload {
  /** MIME type. */
  mimeType: string;
  /** Base64 bytes, when inline. */
  base64?: string;
  /** URL, when by reference. */
  url?: string;
}

/** The assembled, runnable API plus the facts the entry point logs. */
export interface Composition {
  /** The wired REST dispatcher to bind to the HTTP server. */
  restApi: RestApi;
  /** The model ids served live (for startup logging and `/v1/models`). */
  serveableModelIds: string[];
  /** Names of active web-search providers (those with a configured key). */
  activeSearchProviders: string[];
  /** Which AI provider adapters are live. */
  activeAiProviders: string[];
  /** Whether image generation is configured. */
  imageEnabled: boolean;
  /** Whether Sora video generation is configured. */
  videoEnabled: boolean;
  /** Whether realtime audio is configured. */
  realtimeEnabled: boolean;
  /** Whether the knowledge / RAG layer (DB + pgvector + embeddings) is live. */
  knowledgeEnabled: boolean;
  /**
   * Generate image(s) from a prompt, or throw when image gen is not configured.
   * Bound to the http-server's `/v1/images/generate` route.
   */
  generateImage: (prompt: string, count?: number, size?: string, quality?: string) => Promise<GeneratedImagePayload[]>;
  /**
   * Extract model-ready text from uploaded files. Bound to the http-server's
   * `/v1/files/extract` route.
   */
  extractFiles: (uploads: UploadInput[], deep?: boolean) => Promise<{ name: string; text: string; failed?: boolean }[]>;
  /** Create a Sora video job. */
  createVideo: (prompt: string, seconds?: number, size?: string) => Promise<VideoJob>;
  /** Poll a Sora video job's status. */
  getVideo: (id: string) => Promise<VideoJob>;
  /** Download a completed Sora video (base64). */
  getVideoContent: (id: string) => Promise<{ mimeType: string; base64: string }>;
  /** Mint an ephemeral realtime audio session for the browser. */
  createRealtimeSession: (voice?: string, instructions?: string) => Promise<RealtimeSessionInfo>;
  /**
   * Generate a downloadable document (PDF/DOCX/PPTX/XLSX/MD/HTML/TXT/CSV) from
   * Markdown. Bound to the http-server's `/v1/files/generate` route.
   */
  generateFile: (format: string, markdown: string, title?: string) => Promise<GeneratedFile>;
  /**
   * Run a streamed deep-research session, yielding SSE frames for the live
   * plan, each source, the streamed report, and a final completion. Bound to
   * the http-server's `/v1/research` route.
   */
  deepResearch: (query: string, modelId?: string, maxSources?: number, maxTokens?: number, depth?: 'standard' | 'exhaustive') => AsyncIterable<ResearchEvent>;
  /**
   * Run a streamed Gamma-like document-design session: prompt → designed
   * {@link DocumentSpec} → rendered file. Yields SSE frames for each phase and
   * a final completion carrying the base64 file. Bound to the http-server's
   * `/v1/documents/generate` route.
   */
  generateDocument: (input: {
    prompt: string;
    modelId?: string;
    format?: DesignedFormat;
    themeId?: string;
    templateId?: string;
    brand?: { organization?: string; primaryColor?: string; accentColor?: string; footer?: string; watermark?: string };
    maxTokens?: number;
  }) => AsyncIterable<DocumentEvent>;
  /**
   * Deterministically render existing Markdown (e.g. a chat answer) as a
   * designed, themed document — no model call. Returns the rendered file plus
   * a PDF preview when the requested format is not already PDF. Bound to the
   * http-server's `/v1/documents/render` route.
   */
  renderDocument: (input: {
    markdown: string;
    title?: string;
    format?: DesignedFormat;
    themeId?: string;
    brand?: { organization?: string; primaryColor?: string; accentColor?: string; footer?: string; watermark?: string };
  }) => Promise<{
    file: GeneratedFile;
    preview?: GeneratedFile;
    sectionCount: number;
    themeId: string;
    docType: string;
  }>;
}

/** An in-memory no-op persister for streamed partials (dev: nothing to persist to). */
const noopPersister = {
  persist(_partial: PartialResponse): void {
    /* dev composition keeps no conversation store */
  },
};

/**
 * The always-on echo model so the chat product works with no credentials. It
 * is registered in the model registry and served by a {@link StubProvider}.
 */
const ECHO_MODEL: ModelInfo = {
  id: 'auxify-echo',
  provider: 'stub',
  providerModelId: 'auxify-echo',
  displayName: 'Auxify Echo (no credentials needed)',
  modality: 'chat',
  tier: 'economy',
  maxTokens: 8192,
  supportsVision: false,
  supportsTools: false,
  supportsReasoning: false,
  cost: { per1kInputTokens: 0, per1kOutputTokens: 0 },
  available: true,
};

/** Built-in agents that run on top of the live provider layer. */
const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'general',
    name: 'General Assistant',
    description: 'General-purpose model-backed agent for normal work.',
    instructions: 'You are Auxify AI. Complete the user task directly, ask only when required, and keep outputs practical.',
  },
  {
    id: 'research',
    name: 'Research Agent',
    description: 'Investigates a topic and returns a concise, structured answer.',
    instructions: 'You are a research agent. Break down the question, identify the useful facts, and return a concise answer with clear caveats.',
  },
  {
    id: 'code',
    name: 'Code Agent',
    description: 'Helps with implementation, debugging, and technical review.',
    instructions: 'You are a senior coding agent. Reason from the code or prompt, produce concrete implementation guidance, and call out risks or validation steps.',
  },
  {
    id: 'ops',
    name: 'Operations Agent',
    description: 'Plans operational, deployment, and incident-response work.',
    instructions: 'You are an operations agent. Provide precise steps, checks, rollback points, and configuration notes for production systems.',
  },
  {
    id: 'presentation',
    name: 'Presentation & Document Agent',
    description: 'Creates consulting-grade presentations, investor decks, case studies, research reports, and executive documents.',
    instructions: [
      'You are an elite presentation and document generation engine combining the expertise of senior McKinsey, Bain, and BCG consultants, a TED presentation coach, a Fortune 500 executive communications director, and a professional presentation designer.',
      '',
      'When creating presentations (PPTX), follow this architecture:',
      '- First H1 (#) = Cover slide title, followed by one short subtitle paragraph.',
      '- Subsequent H1s (#) = Section divider slides separating major themes.',
      '- H2 (##) = Individual content slides (one clear idea per slide).',
      '- Use 4-6 concise, action-oriented bullet points per slide.',
      '- Include Markdown tables for data-heavy slides.',
      '- Use blockquotes (>) for expert insights or key quotes.',
      '- Code blocks become speaker notes.',
      '- End with "Key Takeaways" (summary slide) and "Thank You" (closing slide).',
      '',
      'For all documents:',
      '- Act as a senior research analyst, product strategist, and investment analyst simultaneously.',
      '- Use specific data, metrics, frameworks, and real-world examples.',
      '- Structure content for maximum clarity and executive-level readability.',
      '- Never use filler content or generic statements.',
      '- Every section must communicate actionable insights.',
      '- Quality should rival top consulting firms and match Apple Keynotes, TED talks, and Fortune 500 executive presentations.',
    ].join('\n'),
  },
];

/** A compact spec for an Azure deployment we register from the env file. */
interface AzureModelSpec {
  /** Platform-stable id (and the picker label source). */
  id: string;
  /** Env var holding the Azure deployment name. */
  envVar: string;
  /** Display name. */
  displayName: string;
  /** `chat` (classic params) or `reasoning` (max_completion_tokens, newer api). */
  modality: ModelModality;
  tier: ModelTier;
  maxTokens: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  cost: { per1kInputTokens: number; per1kOutputTokens: number };
}

/**
 * The Azure deployments to register, driven by the deployment names in
 * `infra/azure/azure-credentials.env`. GPT-5-family + o-series are `reasoning`
 * modality so the AzureProvider sends `max_completion_tokens` and omits
 * `temperature`. Costs are placeholders (overridable by config, Req 2.2).
 */
const AZURE_MODEL_SPECS: AzureModelSpec[] = [
  { id: 'gpt-5.5', envVar: 'AZURE_OPENAI_DEPLOYMENT_GPT55', displayName: 'GPT-5.5', modality: 'reasoning', tier: 'premium', maxTokens: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.01, per1kOutputTokens: 0.03 } },
  { id: 'gpt-5.4', envVar: 'AZURE_OPENAI_DEPLOYMENT_GPT54', displayName: 'GPT-5.4', modality: 'reasoning', tier: 'premium', maxTokens: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.008, per1kOutputTokens: 0.024 } },
  { id: 'gpt-5-pro', envVar: 'AZURE_OPENAI_DEPLOYMENT_GPT5_PRO', displayName: 'GPT-5 Pro', modality: 'reasoning', tier: 'premium', maxTokens: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.015, per1kOutputTokens: 0.06 } },
  { id: 'gpt-5', envVar: 'AZURE_OPENAI_DEPLOYMENT_GPT5', displayName: 'GPT-5', modality: 'reasoning', tier: 'premium', maxTokens: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.006, per1kOutputTokens: 0.018 } },
  { id: 'o3', envVar: 'AZURE_OPENAI_DEPLOYMENT_O3', displayName: 'OpenAI o3', modality: 'reasoning', tier: 'premium', maxTokens: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.01, per1kOutputTokens: 0.04 } },
  { id: 'o4-mini', envVar: 'AZURE_OPENAI_DEPLOYMENT_O4_MINI', displayName: 'OpenAI o4-mini', modality: 'reasoning', tier: 'standard', maxTokens: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.0011, per1kOutputTokens: 0.0044 } },
  { id: 'gpt-4o', envVar: 'AZURE_OPENAI_DEPLOYMENT_GPT4O', displayName: 'GPT-4o', modality: 'chat', tier: 'standard', maxTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: false, cost: { per1kInputTokens: 0.005, per1kOutputTokens: 0.015 } },
  { id: 'gpt-4o-mini', envVar: 'AZURE_OPENAI_DEPLOYMENT_GPT4O_MINI', displayName: 'GPT-4o mini', modality: 'chat', tier: 'economy', maxTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: false, cost: { per1kInputTokens: 0.00015, per1kOutputTokens: 0.0006 } },
  { id: 'text-embedding-3-large', envVar: 'AZURE_OPENAI_DEPLOYMENT_EMBEDDING', displayName: 'Text Embedding 3 Large', modality: 'embedding', tier: 'standard', maxTokens: 8191, supportsVision: false, supportsTools: false, supportsReasoning: false, cost: { per1kInputTokens: 0.00013, per1kOutputTokens: 0 } },
];

/** Partner / MaaS chat deployments served by Azure AI Foundry model inference. */
const FOUNDRY_MODEL_SPECS: AzureModelSpec[] = [
  { id: 'grok-4.3', envVar: 'AZURE_FOUNDRY_DEPLOYMENT_GROK', displayName: 'Grok 4.3', modality: 'chat', tier: 'premium', maxTokens: 256_000, supportsVision: false, supportsTools: true, supportsReasoning: false, cost: { per1kInputTokens: 0.003, per1kOutputTokens: 0.015 } },
  { id: 'grok-4-20-reasoning', envVar: 'AZURE_FOUNDRY_DEPLOYMENT_GROK_REASONING', displayName: 'Grok 4 Reasoning', modality: 'reasoning', tier: 'premium', maxTokens: 256_000, supportsVision: false, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.005, per1kOutputTokens: 0.025 } },
  { id: 'deepseek-v3.1', envVar: 'AZURE_FOUNDRY_DEPLOYMENT_DEEPSEEK', displayName: 'DeepSeek V3.1', modality: 'chat', tier: 'standard', maxTokens: 128_000, supportsVision: false, supportsTools: true, supportsReasoning: false, cost: { per1kInputTokens: 0.0003, per1kOutputTokens: 0.0012 } },
  { id: 'deepseek-r1-0528', envVar: 'AZURE_FOUNDRY_DEPLOYMENT_DEEPSEEK_R1', displayName: 'DeepSeek R1 0528', modality: 'reasoning', tier: 'standard', maxTokens: 128_000, supportsVision: false, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.00055, per1kOutputTokens: 0.0022 } },
  { id: 'kimi-k2.6', envVar: 'AZURE_FOUNDRY_DEPLOYMENT_KIMI', displayName: 'Kimi K2.6', modality: 'chat', tier: 'standard', maxTokens: 128_000, supportsVision: false, supportsTools: true, supportsReasoning: false, cost: { per1kInputTokens: 0.0006, per1kOutputTokens: 0.0025 } },
];

/** Project configured deployment env vars into model catalog entries. */
function envModels(provider: string, specs: AzureModelSpec[]): ModelConfig[] {
  const models: ModelConfig[] = [];
  for (const spec of specs) {
    const deployment = process.env[spec.envVar];
    if (deployment === undefined || deployment.length === 0) {
      continue;
    }
    models.push({
      id: spec.id,
      provider,
      providerModelId: deployment,
      displayName: spec.displayName,
      modality: spec.modality,
      tier: spec.tier,
      maxTokens: spec.maxTokens,
      supportsVision: spec.supportsVision,
      supportsTools: spec.supportsTools,
      supportsReasoning: spec.supportsReasoning,
      cost: spec.cost,
    });
  }
  return models;
}

/** A Bedrock model that can be overridden by env without source changes. */
interface BedrockModelSpec extends Omit<ModelConfig, 'provider' | 'providerModelId'> {
  envVar: string;
  defaultProviderModelId: string;
}

/** The Claude deployments documented as enabled in `infra/aws/AWS_SETUP.md`. */
const BEDROCK_MODEL_SPECS: BedrockModelSpec[] = [
  { id: 'claude-opus-4-6', envVar: 'BEDROCK_MODEL_OPUS_46', defaultProviderModelId: 'global.anthropic.claude-opus-4-6-v1', displayName: 'Claude Opus 4.6', modality: 'chat', tier: 'premium', maxTokens: 1_000_000, supportsVision: true, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.015, per1kOutputTokens: 0.075 } },
  { id: 'claude-opus-4-5', envVar: 'BEDROCK_MODEL_OPUS', defaultProviderModelId: 'global.anthropic.claude-opus-4-5-20251101-v1:0', displayName: 'Claude Opus 4.5', modality: 'chat', tier: 'premium', maxTokens: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.015, per1kOutputTokens: 0.075 } },
  { id: 'claude-sonnet-4-5', envVar: 'BEDROCK_MODEL_SONNET', defaultProviderModelId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', displayName: 'Claude Sonnet 4.5', modality: 'chat', tier: 'standard', maxTokens: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true, cost: { per1kInputTokens: 0.003, per1kOutputTokens: 0.015 } },
  { id: 'claude-haiku-4-5', envVar: 'BEDROCK_MODEL_HAIKU', defaultProviderModelId: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', displayName: 'Claude Haiku 4.5', modality: 'chat', tier: 'economy', maxTokens: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: false, cost: { per1kInputTokens: 0.001, per1kOutputTokens: 0.005 } },
];

/** Project configured Bedrock model ids into model catalog entries. */
function bedrockModels(): ModelConfig[] {
  return BEDROCK_MODEL_SPECS.map((spec) => ({
    id: spec.id,
    provider: 'bedrock',
    providerModelId: process.env[spec.envVar] ?? spec.defaultProviderModelId,
    displayName: spec.displayName,
    modality: spec.modality,
    tier: spec.tier,
    maxTokens: spec.maxTokens,
    supportsVision: spec.supportsVision,
    supportsTools: spec.supportsTools,
    supportsReasoning: spec.supportsReasoning,
    cost: spec.cost,
  }));
}

/** Build the model registry: Bedrock (Claude) + the real Azure deployments + echo. */
function buildRegistry(config: ServerConfig): ConfigModelRegistry {
  const registry = new ConfigModelRegistry();
  // Only register Bedrock models when a Bedrock credential is configured.
  const bedrock = config.bedrock !== null ? bedrockModels() : [];

  // Use the operator's REAL Azure deployments (gpt-5.5, gpt-5.4, …) when Azure
  // is configured; otherwise fall back to the default Azure catalog so the
  // picker still lists models (marked unavailable).
  const azure = config.azure !== null
    ? envModels('azure', AZURE_MODEL_SPECS)
    : defaultRegistryConfig.models.filter((m) => m.provider === 'azure');
  const foundry = config.foundry !== null
    ? envModels('foundry', FOUNDRY_MODEL_SPECS)
    : [];

  registry.load({
    providers: [
      ...(defaultRegistryConfig.providers ?? []),
      { id: 'foundry', displayName: 'Azure AI Foundry (partner models)', kind: 'azure-foundry' },
      { id: 'stub', displayName: 'Auxify (built-in)', kind: 'stub' },
    ],
    models: [...bedrock, ...azure, ...foundry, ECHO_MODEL],
  });
  return registry;
}

/** Instantiate the provider adapters that have credentials, plus the stub. */
function buildProviders(config: ServerConfig, registry: ConfigModelRegistry): ResolvedProviders {
  const byId = new Map<string, AIProvider>();

  // The echo provider is always available.
  byId.set('stub', new StubProvider({ providerId: 'stub', models: [ECHO_MODEL] }));

  if (config.bedrock !== null) {
    const client = new HttpBedrockClient({ token: config.bedrock.token });
    byId.set(
      'bedrock',
      new BedrockProvider(
        { id: 'bedrock', region: config.bedrock.region },
        registry,
        client,
      ),
    );
  }

  if (config.azure !== null) {
    const client = new HttpAzureClient({
      endpoint: config.azure.endpoint,
      apiKey: config.azure.apiKey,
    });
    byId.set(
      'azure',
      new AzureProvider(
        { id: 'azure', apiVersion: config.azure.apiVersion },
        registry,
        client,
        {
          // GPT-5-family + o-series reasoning deployments require a newer
          // api-version than classic chat; override per modality.
          apiVersionOverrides: { reasoning: config.azure.reasoningApiVersion },
        },
      ),
    );
  }

  if (config.foundry !== null) {
    const client = new HttpFoundryClient({
      endpoint: config.foundry.endpoint,
      apiKey: config.foundry.apiKey,
    });
    byId.set(
      'foundry',
      new AzureProvider(
        { id: 'foundry', apiVersion: config.foundry.apiVersion },
        registry,
        client,
      ),
    );
  }

  // A model is serveable when its provider adapter is live.
  const serveableModelIds = new Set<string>();
  for (const model of registry.list()) {
    if (byId.has(model.provider)) {
      serveableModelIds.add(model.id);
    }
  }
  return { byId, serveableModelIds };
}

/** Normalize the loose SDK/web chat body into a typed {@link ChatRequest}. */
function toChatRequest(body: unknown, fallbackModelId: string): ChatRequest {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  const messages: ChatMessage[] = rawMessages
    .map((m): ChatMessage | null => {
      const mr = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>;
      const role = mr.role;
      const content = mr.content;
      if (
        (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') &&
        (typeof content === 'string' || Array.isArray(content))
      ) {
        return { role, content: content as ChatMessage['content'] };
      }
      return null;
    })
    .filter((m): m is ChatMessage => m !== null);

  const modelId = typeof record.modelId === 'string' && record.modelId.length > 0
    ? record.modelId
    : fallbackModelId;

  const req: ChatRequest = { modelId, messages };
  if (typeof record.systemPrompt === 'string') {
    req.systemPrompt = record.systemPrompt;
  }
  if (typeof record.temperature === 'number') {
    req.temperature = record.temperature;
  }
  if (typeof record.maxTokens === 'number') {
    req.maxTokens = record.maxTokens;
  }
  return req;
}

/** Extract the latest user message's text (joining multimodal text parts). */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) {
      return m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join(' ')
        .trim();
    }
  }
  return '';
}

/**
 * The chat stream port: resolves the target model's provider adapter and yields
 * its provider chunks for the Streaming_Engine to relay over SSE. When a
 * knowledge retriever is supplied, it grounds the reply in the organization's
 * own knowledge (RAG) by retrieving relevant chunks and prepending them as
 * context before the model is called.
 */
function buildChatStreamPort(
  registry: ConfigModelRegistry,
  providers: ResolvedProviders,
  retriever: KnowledgeRetriever | null = null,
): ChatStreamPort {
  return {
    async open(req: ChatStreamRequest): Promise<ChatStreamSource> {
      const chatRequest = toChatRequest(req.request.body, ECHO_MODEL.id);

      // RAG grounding: retrieve org knowledge relevant to the latest user turn.
      if (retriever !== null) {
        const organizationId = req.auth?.tenant.organizationId ?? 'dev-org';
        const queryText = lastUserText(chatRequest.messages);
        if (queryText.length > 0) {
          try {
            const hits = await retriever.retrieve(organizationId, queryText, 5);
            if (hits.length > 0) {
              const grounding =
                'Relevant company knowledge (cite by [n] when used):\n\n' +
                hits
                  .map((h, i) => `[${i + 1}] ${h.title}\n${h.text}`)
                  .join('\n\n');
              chatRequest.systemPrompt =
                chatRequest.systemPrompt !== undefined && chatRequest.systemPrompt.length > 0
                  ? `${chatRequest.systemPrompt}\n\n${grounding}`
                  : grounding;
            }
          } catch (error) {
            process.stderr.write(
              `[chat] knowledge retrieval failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        }
      }

      const model = registry.get(chatRequest.modelId);
      const provider = providers.byId.get(model.provider);
      if (provider === undefined) {
        throw new Error(`no live provider for model "${chatRequest.modelId}"`);
      }
      // Wrap the provider stream so the REAL error (e.g. a Bedrock 4xx body) is
      // logged server-side; the Streaming_Engine otherwise reports only a
      // generic "stream ended unexpectedly" to the client.
      const rawSource = provider.chat(chatRequest);
      const source: AsyncIterable<ChatChunk> = {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of rawSource) {
              yield chunk;
            }
          } catch (error) {
            process.stderr.write(
              `[chat] model "${chatRequest.modelId}" (${model.provider}) failed: ` +
                `${error instanceof Error ? error.message : String(error)}\n`,
            );
            throw error;
          }
        },
      };
      return {
        source,
        context: {
          target: { conversationId: req.conversationId, messageId: `msg-${Date.now()}` },
          cost: model.cost,
          modelId: model.id,
        },
      };
    },
  };
}

/** Build the streaming agent-run port backed by the live provider layer. */
function buildAgentRunPort(
  registry: ConfigModelRegistry,
  providers: ResolvedProviders,
  agents: Map<string, AgentDefinition>,
): AgentRunPort {
  return {
    async open(req) {
      const body = (typeof req.request.body === 'object' && req.request.body !== null
        ? req.request.body
        : {}) as Record<string, unknown>;
      const input = typeof body.input === 'string' ? body.input : '';
      const metadata = (typeof body.metadata === 'object' && body.metadata !== null
        ? body.metadata
        : {}) as Record<string, unknown>;

      if (input.trim().length === 0) {
        return singleSseError('validation', 'AGENT_INPUT_REQUIRED', 'agent input is required', req.correlationId);
      }

      const agent = agents.get(req.agentId);
      if (agent === undefined) {
        return singleSseError('not_found', 'AGENT_NOT_FOUND', `agent "${req.agentId}" was not found`, req.correlationId);
      }

      const modelId = selectAgentModel(registry, providers, agent, body, metadata);
      const model = registry.get(modelId);
      const provider = providers.byId.get(model.provider);
      if (provider === undefined) {
        return singleSseError('provider_unavailable', 'AGENT_MODEL_UNAVAILABLE', `model "${modelId}" is not available`, req.correlationId);
      }

      const maxTokens = readFiniteNumber(metadata.maxTokens) ?? readFiniteNumber(body.maxTokens) ?? 2048;
      const temperature = readFiniteNumber(metadata.temperature) ?? readFiniteNumber(body.temperature);
      const chatRequest: ChatRequest = {
        modelId,
        systemPrompt: agent.instructions,
        messages: [{ role: 'user', content: input }],
        maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
      };

      return streamAgentProvider(req.agentId, agent, model, provider, chatRequest, req.correlationId);
    },
  };
}

/** Select a live chat/reasoning model for an agent run. */
function selectAgentModel(
  registry: ConfigModelRegistry,
  providers: ResolvedProviders,
  agent: AgentDefinition,
  body: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string {
  const requested = typeof metadata.modelId === 'string'
    ? metadata.modelId
    : typeof body.modelId === 'string'
      ? body.modelId
      : agent.modelId;
  if (requested !== undefined && isLiveChatModel(registry, providers, requested)) {
    return requested;
  }

  const preferred = [
    'gpt-5.5',
    'gpt-5',
    'claude-sonnet-4-6',
    'gpt-4o',
    'grok-4.3',
    ECHO_MODEL.id,
  ];
  for (const modelId of preferred) {
    if (isLiveChatModel(registry, providers, modelId)) {
      return modelId;
    }
  }
  const fallback = registry
    .list()
    .find((m) => providers.serveableModelIds.has(m.id) && (m.modality === 'chat' || m.modality === 'reasoning'));
  if (fallback === undefined) {
    throw new Error('no live chat or reasoning model is available for agents');
  }
  return fallback.id;
}

/** Whether a model id resolves to a live chat/reasoning model. */
function isLiveChatModel(
  registry: ConfigModelRegistry,
  providers: ResolvedProviders,
  modelId: string,
): boolean {
  try {
    const model = registry.get(modelId);
    return providers.serveableModelIds.has(model.id) && (model.modality === 'chat' || model.modality === 'reasoning');
  } catch {
    return false;
  }
}

/** Stream one provider-backed agent run as SDK-compatible SSE events. */
async function* streamAgentProvider(
  agentId: string,
  agent: AgentDefinition,
  model: ModelInfo,
  provider: AIProvider,
  request: ChatRequest,
  correlationId: string,
): AsyncIterable<SseEvent> {
  let output = '';
  let usage: ChatChunk['usage'];
  yield sse('step', {
    id: `${agentId}-start`,
    kind: 'thought',
    name: 'model_selected',
    content: `${agent.name} is running on ${model.displayName}.`,
  });
  try {
    for await (const chunk of provider.chat(request)) {
      if (chunk.usage !== undefined) {
        usage = chunk.usage;
      }
      if (chunk.delta.length > 0) {
        output += chunk.delta;
        yield sse('step', {
          kind: 'observation',
          name: 'assistant_delta',
          content: chunk.delta,
        });
      }
    }
    yield sse('completion', {
      output: { text: output, agentId, modelId: model.id },
      ...(usage !== undefined ? { usage } : {}),
    });
  } catch (error) {
    yield sse('error', createPlatformError({
      category: 'provider_unavailable',
      code: 'AGENT_PROVIDER_FAILED',
      message: error instanceof Error ? error.message : 'agent provider failed',
      correlationId,
    }));
  }
}

/** Create a one-frame SSE error stream. */
async function* singleSseError(
  category: Parameters<typeof createPlatformError>[0]['category'],
  code: string,
  message: string,
  correlationId: string,
): AsyncIterable<SseEvent> {
  yield sse('error', createPlatformError({ category, code, message, correlationId }));
}

/** Encode one object as an SSE frame. */
function sse(event: string, data: unknown): SseEvent {
  return { event, data: JSON.stringify(data) };
}

/** Read a finite number from loose request metadata. */
function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Public agent payload. */
function agentPayload(agent: AgentDefinition): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    ...(agent.modelId !== undefined ? { modelId: agent.modelId } : {}),
  };
}

/** A success result for a resource handler. */
function ok(body: unknown, status = 200): Result<{ body: unknown; status?: number }> {
  return { ok: true, value: { body, status } };
}

/**
 * Build the resource controllers for the routes the chat product uses today:
 * model listing, web search, web scrape, and — when a database is configured —
 * persistent conversations + messages backed by the tenant-scoped repositories.
 * Unwired operations fall through to the router's `not_found`.
 */
function buildControllers(
  registry: ConfigModelRegistry,
  providers: ResolvedProviders,
  search: ProviderRotationService,
  database: Database | null,
  agents: Map<string, AgentDefinition>,
): Partial<Record<string, ResourceController>> {
  const models: ResourceController = {
    list: async () => {
      const list = registry
        .list()
        .map((m) => ({ ...m, available: providers.serveableModelIds.has(m.id) }));
      return ok({ models: list });
    },
    get: async (ctx: RouteHandlerContext) => {
      const id = ctx.params.modelId ?? '';
      const model = registry.list().find((m) => m.id === id);
      if (model === undefined) {
        return ok({ error: 'model not found' }, 404);
      }
      return ok({ ...model, available: providers.serveableModelIds.has(model.id) });
    },
  };

  const webSearch: ResourceController = {
    search: async (ctx: RouteHandlerContext) => {
      const body = (ctx.request.body ?? {}) as Record<string, unknown>;
      const query = typeof body.query === 'string' ? body.query : '';
      if (query.trim().length === 0) {
        return ok({ error: 'query is required' }, 400);
      }
      if (!search.hasAny()) {
        return ok(
          {
            error:
              'No web search providers configured. Set a provider API key ' +
              '(e.g. SERPER_API_KEY, BRAVE_SEARCH_API_KEY, TAVILY_API_KEY).',
            results: [],
          },
          200,
        );
      }
      const limit = typeof body.limit === 'number' ? body.limit : 10;
      const response = await search.search({ query, maxResults: limit });
      const results = response.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        score: r.score,
      }));
      return ok(results);
    },
  };

  const webScrape: ResourceController = {
    scrape: async (ctx: RouteHandlerContext) => {
      const body = (ctx.request.body ?? {}) as Record<string, unknown>;
      const url = typeof body.url === 'string' ? body.url : '';
      if (url.trim().length === 0) {
        return ok({ error: 'url is required' }, 400);
      }
      if (!search.hasAny()) {
        return ok({ error: 'no scrape providers configured', content: '' }, 200);
      }
      const response = await search.scrape({ url });
      return ok(response);
    },
  };

  const agentsController: ResourceController = {
    list: async () => ok({ agents: [...agents.values()].map(agentPayload) }),
    create: async (ctx) => {
      const body = (ctx.request.body ?? {}) as Record<string, unknown>;
      const id = typeof body.id === 'string' && body.id.length > 0
        ? body.id
        : `agent_${Date.now().toString(36)}`;
      const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : id;
      const instructions = typeof body.instructions === 'string' && body.instructions.length > 0
        ? body.instructions
        : 'Complete the user task directly and keep outputs practical.';
      const modelId = typeof body.modelId === 'string' && isLiveChatModel(registry, providers, body.modelId)
        ? body.modelId
        : undefined;
      const agent: AgentDefinition = {
        id,
        name,
        description: typeof body.description === 'string' ? body.description : 'Custom model-backed agent.',
        instructions,
        ...(modelId !== undefined ? { modelId } : {}),
      };
      agents.set(id, agent);
      return ok(agentPayload(agent), 201);
    },
    get: async (ctx) => {
      const id = ctx.params.agentId ?? '';
      const agent = agents.get(id);
      if (agent === undefined) return ok({ error: 'agent not found' }, 404);
      return ok(agentPayload(agent));
    },
  };

  const conversations: ResourceController = {
    list: async () => ok({ conversations: [] }),
  };

  // Without a database, only the placeholder conversations list is available.
  if (database === null) {
    return {
      models,
      'web-search': webSearch,
      'web-scrape': webScrape,
      agents: agentsController,
      conversations,
    };
  }

  // --- Persistence-backed conversations + messages (server-side history). ---
  const conversationRepo = new ConversationRepository(database.sql);
  const messageRepo = new MessageRepository(database.sql);

  /** The tenant context derived from the authenticated principal. */
  const tenantOf = (ctx: RouteHandlerContext): TenantContext =>
    ctx.auth?.tenant ?? { organizationId: 'dev-org', userId: 'dev-user' };
  /** The owner (user) id from the authenticated principal. */
  const ownerOf = (ctx: RouteHandlerContext): string =>
    ctx.auth?.principal.userId ?? 'dev-user';

  const newId = (prefix: string): string =>
    `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const persistentConversations: ResourceController = {
    list: async (ctx) => {
      const rows = await conversationRepo.listByOwner(tenantOf(ctx), ownerOf(ctx), { limit: 200 });
      return ok({ conversations: rows });
    },
    create: async (ctx) => {
      const body = (ctx.request.body ?? {}) as Record<string, unknown>;
      const record = await conversationRepo.create(tenantOf(ctx), {
        id: typeof body.id === 'string' && body.id.length > 0 ? body.id : newId('conv'),
        projectId: typeof body.projectId === 'string' ? body.projectId : 'default',
        ownerId: ownerOf(ctx),
        title: typeof body.title === 'string' ? body.title : '',
        activeModelId: typeof body.modelId === 'string' ? body.modelId : null,
      });
      return ok(record, 201);
    },
    get: async (ctx) => {
      const id = ctx.params.conversationId ?? '';
      const record = await conversationRepo.findById(tenantOf(ctx), id);
      if (record === null) return ok({ error: 'conversation not found' }, 404);
      return ok(record);
    },
    update: async (ctx) => {
      const id = ctx.params.conversationId ?? '';
      const body = (ctx.request.body ?? {}) as Record<string, unknown>;
      const record = await conversationRepo.update(tenantOf(ctx), id, {
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.archived === 'boolean' ? { archived: body.archived } : {}),
        ...(typeof body.modelId === 'string' ? { activeModelId: body.modelId } : {}),
      });
      if (record === null) return ok({ error: 'conversation not found' }, 404);
      return ok(record);
    },
    delete: async (ctx) => {
      const id = ctx.params.conversationId ?? '';
      const deleted = await conversationRepo.delete(tenantOf(ctx), id);
      return ok({ deleted }, deleted ? 200 : 404);
    },
  };

  const messagesController: ResourceController = {
    list: async (ctx) => {
      const conversationId = ctx.params.conversationId ?? '';
      const rows = await messageRepo.listByConversation(tenantOf(ctx), conversationId, {
        limit: 1000,
      });
      return ok({ messages: rows });
    },
    create: async (ctx) => {
      const conversationId = ctx.params.conversationId ?? '';
      const body = (ctx.request.body ?? {}) as Record<string, unknown>;
      const role = body.role === 'assistant' || body.role === 'system' ? body.role : 'user';
      const content = Array.isArray(body.content)
        ? (body.content as { type: string }[])
        : [{ type: 'text', text: typeof body.content === 'string' ? body.content : '' }];
      const record = await messageRepo.create(tenantOf(ctx), {
        id: typeof body.id === 'string' && body.id.length > 0 ? body.id : newId('msg'),
        conversationId,
        role,
        content: content as never,
        model: typeof body.model === 'string' ? body.model : null,
      });
      // Touch the parent so history ordering reflects the new message.
      await conversationRepo.update(tenantOf(ctx), conversationId, {});
      return ok(record, 201);
    },
    get: async (ctx) => {
      const id = ctx.params.messageId ?? '';
      const record = await messageRepo.findById(tenantOf(ctx), id);
      if (record === null) return ok({ error: 'message not found' }, 404);
      return ok(record);
    },
  };

  return {
    models,
    'web-search': webSearch,
    'web-scrape': webScrape,
    agents: agentsController,
    conversations: persistentConversations,
    messages: messagesController,
  };
}

/** A dev JWT authenticator accepting exactly one configured bearer token. */
function buildDevJwt(config: ServerConfig): { validate(token: string): Promise<SessionIdentity> } {
  const identity: SessionIdentity = {
    userId: 'dev-user',
    organizationId: 'dev-org',
    roles: ['admin'],
    sessionId: 'dev-session',
  };
  return {
    async validate(token: string): Promise<SessionIdentity> {
      if (!csrfConstantTimeEqual(token, config.devToken)) {
        throw new Error('invalid dev token');
      }
      return Promise.resolve(identity);
    },
  };
}

/** A dev API-key authenticator accepting exactly one configured key. */
function buildDevApiKey(config: ServerConfig): { authenticate(key: string): Promise<KeyAuthResult> } {
  const masked: MaskedKey = {
    id: 'dev-key',
    organizationId: 'dev-org',
    ownerId: 'dev-user',
    name: 'dev local key',
    prefix: 'dev',
    masked: 'dev…',
    active: true,
    rateLimit: { requestsPerWindow: 600, windowSeconds: 60 },
    createdAt: new Date().toISOString(),
  };
  return {
    async authenticate(key: string): Promise<KeyAuthResult> {
      if (!csrfConstantTimeEqual(key, config.devApiKey)) {
        return Promise.resolve({ authenticated: false, reason: 'unknown' });
      }
      return Promise.resolve({ authenticated: true, key: masked });
    },
  };
}

/** Assemble the full runnable composition from the server config. */
export function buildComposition(config: ServerConfig, database: Database | null = null): Composition {
  const registry = buildRegistry(config);
  const providers = buildProviders(config, registry);
  const agents = new Map(BUILTIN_AGENTS.map((agent) => [agent.id, agent]));
  const search = new ProviderRotationService();
  const streaming = new StreamingEngine({ persister: noopPersister });

  // A model-resolving chat runner: routes to the requested model's provider, or
  // falls back to any live chat/reasoning model (used by file/research helpers).
  const runChat = (req: ChatRequest): AsyncIterable<ChatChunk> => {
    let modelId = req.modelId;
    if (!isLiveChatModel(registry, providers, modelId)) {
      const fallback = registry
        .list()
        .find(
          (m) =>
            providers.serveableModelIds.has(m.id) &&
            (m.modality === 'chat' || m.modality === 'reasoning'),
        );
      modelId = fallback?.id ?? ECHO_MODEL.id;
    }
    const model = registry.get(modelId);
    const provider = providers.byId.get(model.provider);
    if (provider === undefined) {
      throw new Error(`no live provider for model "${modelId}"`);
    }
    return provider.chat({ ...req, modelId });
  };

  /** The default chat/reasoning model id for research when none is specified. */
  const defaultResearchModel =
    registry
      .list()
      .find(
        (m) =>
          providers.serveableModelIds.has(m.id) &&
          (m.modality === 'chat' || m.modality === 'reasoning'),
      )?.id ?? ECHO_MODEL.id;

  // --- Knowledge / RAG layer. Collab/CRUD work on any Postgres; semantic
  // search + RAG grounding additionally require pgvector + embeddings. ---
  const embed: EmbedTexts | null =
    config.azureEmbedding !== null ? createEmbedder(config.azureEmbedding) : null;
  const vectors = database !== null && database.vectorReady ? new PgVectorStore(database.sql) : null;
  const knowledgeControllers =
    database !== null
      ? buildKnowledgeControllers({ sql: database.sql, vectors, embed })
      : {};
  const retriever: KnowledgeRetriever | null =
    vectors !== null && database !== null && embed !== null
      ? buildKnowledgeRetriever({ sql: database.sql, vectors, embed })
      : null;
  const knowledgeEnabled = vectors !== null && embed !== null;

  const services: RestServices = {
    controllers: {
      ...buildControllers(registry, providers, search, database, agents),
      ...knowledgeControllers,
    },
    chatStream: buildChatStreamPort(registry, providers, retriever),
    agentRuns: buildAgentRunPort(registry, providers, agents),
  };

  const restApi = new RestApi({
    router: createRouter(services),
    authenticator: new RestAuthenticator({
      jwt: buildDevJwt(config),
      apiKey: buildDevApiKey(config),
    }),
    services,
    streaming,
    // Enable the dispatcher's rate-limit gate (per IP + per user/key). Without
    // this the gate is silently disabled.
    rateLimiter: new InMemoryRateLimiter(),
  });

  return {
    restApi,
    serveableModelIds: [...providers.serveableModelIds],
    activeSearchProviders: search.activeProviders,
    activeAiProviders: [...providers.byId.keys()],
    imageEnabled: config.azureImage !== null,
    videoEnabled: config.azureVideo !== null,
    realtimeEnabled: config.azureRealtime !== null,
    knowledgeEnabled,
    generateImage: async (prompt, count, size, quality) => {
      if (config.azureImage === null) {
        throw new Error(
          'Image generation is not configured. Set AZURE_OPENAI_DEPLOYMENT_IMAGE (+ endpoint/key).',
        );
      }
      return generateImages(config.azureImage, prompt, { count, size, quality });
    },
    extractFiles: async (uploads, deep) => {
      const results = await Promise.all(uploads.map((u) => extractText(u, { deep: deep === true })));
      return results;
    },
    createVideo: async (prompt, seconds, size) => {
      if (config.azureVideo === null) {
        throw new Error(
          'Video generation is not configured. Set AZURE_OPENAI_DEPLOYMENT_VIDEO (+ endpoint/key).',
        );
      }
      return createVideoJob(config.azureVideo, prompt, { seconds, size });
    },
    getVideo: async (id) => {
      if (config.azureVideo === null) {
        throw new Error('Video generation is not configured.');
      }
      return getVideoJob(config.azureVideo, id);
    },
    getVideoContent: async (id) => {
      if (config.azureVideo === null) {
        throw new Error('Video generation is not configured.');
      }
      return getVideoContent(config.azureVideo, id);
    },
    createRealtimeSession: async (voice, instructions) => {
      if (config.azureRealtime === null) {
        throw new Error(
          'Realtime audio is not configured. Set AZURE_OPENAI_DEPLOYMENT_REALTIME (+ endpoint/key).',
        );
      }
      return createRealtimeSession(config.azureRealtime, { voice, instructions });
    },
    generateFile: async (format, markdown, title) =>
      generateFile({ format: format as FileFormat, markdown, ...(title !== undefined ? { title } : {}) }),
    deepResearch: (query, modelId, maxSources, maxTokens, depth) => {
      const id =
        modelId !== undefined && isLiveChatModel(registry, providers, modelId)
          ? modelId
          : defaultResearchModel;
      return runDeepResearch(
        {
          query,
          modelId: id,
          ...(maxSources !== undefined ? { maxSources } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(depth !== undefined ? { depth } : {}),
        },
        { search, runChat },
      );
    },
    generateDocument: (input) => {
      const id =
        input.modelId !== undefined && isLiveChatModel(registry, providers, input.modelId)
          ? input.modelId
          : defaultResearchModel;
      return runDocumentGeneration(
        {
          prompt: input.prompt,
          modelId: id,
          ...(input.format !== undefined ? { format: input.format } : {}),
          ...(input.themeId !== undefined ? { themeId: input.themeId as ThemeId } : {}),
          ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        },
        { runChat },
      );
    },
    renderDocument: async (input) => {
      const spec = specFromMarkdown(input.markdown, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.themeId !== undefined ? { themeId: input.themeId } : {}),
        ...(input.brand !== undefined ? { brand: input.brand } : {}),
      });
      const format: DesignedFormat = input.format ?? 'pdf';
      const file = await renderDesignedDocument(spec, format);
      let preview: GeneratedFile | undefined;
      if (format !== 'pdf') {
        try {
          preview = await renderDesignedDocument(spec, 'pdf');
        } catch {
          // Preview is best-effort.
        }
      }
      return {
        file,
        ...(preview !== undefined ? { preview } : {}),
        sectionCount: spec.sections.length,
        themeId: spec.themeId,
        docType: spec.docType,
      };
    },
  };
}
