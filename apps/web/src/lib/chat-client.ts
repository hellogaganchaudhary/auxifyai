/**
 * The real chat client the chat screen uses, backed by the Auxify SDK
 * (`@auxify/sdk`) talking to the running API.
 *
 * This replaces the placeholder "simulated stream" in the chat UI with a true
 * server-sent-events stream from the backend (`POST /v1/chat/stream`), exposes
 * the live model catalog (`GET /v1/models`), and runs web search through the
 * provider-rotation backend (`POST /v1/web-search`). Everything is typed
 * against the shared `@auxify/types`/SDK shapes.
 */

import { AuxifyClient, type ChatEvent, type SearchResult } from '@auxify/sdk';
import type { ChatMessage, ModelInfo, TokenUsage } from '@auxify/types';

import { API_BASE_URL, API_KEY } from './config';

/** A single shared client instance (browser global `fetch` transport). */
export const client = new AuxifyClient({ baseUrl: API_BASE_URL, apiKey: API_KEY });

/** Fetch the live model catalog from the API. */
export async function listModels(): Promise<ModelInfo[]> {
  const response = await fetch(`${API_BASE_URL}/v1/models`, {
    headers: { 'x-api-key': API_KEY },
  });
  if (!response.ok) {
    throw new Error(`failed to load models (${response.status})`);
  }
  const data = (await response.json()) as { models?: ModelInfo[] };
  return data.models ?? [];
}

/** Server capabilities that drive the UI tool toggles. */
export interface Capabilities {
  image: boolean;
  video: boolean;
  realtime: boolean;
  webSearch: boolean;
  knowledge: boolean;
}

/** Fetch which optional capabilities the server has configured. */
export async function getCapabilities(): Promise<Capabilities> {
  try {
    const response = await fetch(`${API_BASE_URL}/v1/capabilities`);
    if (!response.ok) {
      return { image: false, video: false, realtime: false, webSearch: false, knowledge: false };
    }
    return (await response.json()) as Capabilities;
  } catch {
    return { image: false, video: false, realtime: false, webSearch: false, knowledge: false };
  }
}

/** A knowledge source registered in the org knowledge base. */
export interface KnowledgeSource {
  id: string;
  name: string;
  kind: string;
  status: string;
  chunk_count: number;
  created_at: string;
}

/** A single knowledge search hit. */
export interface KnowledgeHit {
  text: string;
  title: string;
  kind: string;
  score: number;
}

/** JSON helper for the authenticated knowledge endpoints. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...(init?.headers ?? {}) },
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok || (data as { error?: string }).error) {
    throw new Error((data as { error?: string }).error ?? `request failed (${response.status})`);
  }
  return data;
}

/**
 * `fetch` with an abort-based timeout so a hung request fails fast and can be
 * retried, rather than blocking forever.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retry an async operation with exponential backoff. Every throw is treated as
 * retryable (network drop, timeout, 5xx, throttling) so long-running, flaky
 * operations like document ingestion and image rendering eventually succeed —
 * the priority is "no failure", even if it takes a while.
 */
export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const baseDelay = opts.baseDelayMs ?? 2000;
  const maxDelay = opts.maxDelayMs ?? 30000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        opts.onRetry?.(attempt, err);
        const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/** List the org's knowledge sources. */
export async function listKnowledgeSources(): Promise<KnowledgeSource[]> {
  const data = await api<{ sources?: KnowledgeSource[] }>('/v1/knowledge-base/sources');
  return data.sources ?? [];
}

/**
 * Add a text knowledge source (embedded + indexed for RAG). Hardened for
 * background ingestion: each attempt has a generous 5-minute timeout and the
 * call is retried with backoff, so a slow embedding pass or a transient blip
 * never surfaces as a failure — it just takes as long as it needs.
 */
export async function addKnowledgeSource(
  name: string,
  text: string,
  onRetry?: (attempt: number) => void,
): Promise<{ id: string; chunkCount: number }> {
  return retryAsync(
    async () => {
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/v1/knowledge-base/sources`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ name, text }),
        },
        300_000,
      );
      const data = (await response.json()) as { id: string; chunkCount: number; error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error ?? `request failed (${response.status})`);
      }
      return data;
    },
    { attempts: 8, baseDelayMs: 3000, onRetry: (a) => onRetry?.(a) },
  );
}

/** Semantic-search the org knowledge base. */
export async function searchKnowledge(query: string, limit = 8): Promise<KnowledgeHit[]> {
  const data = await api<{ results?: KnowledgeHit[] }>('/v1/knowledge-base/search', {
    method: 'POST',
    body: JSON.stringify({ query, limit }),
  });
  return data.results ?? [];
}

/** A reconstructed knowledge source (full text) from {@link getAllKnowledge}. */
export interface KnowledgeFullSource {
  title: string;
  kind: string;
  text: string;
}

/** The entire knowledge base, reconstructed for full-context grounding. */
export interface KnowledgeBundle {
  sources: KnowledgeFullSource[];
  sourceCount: number;
  chunkCount: number;
  totalChars: number;
  truncated: boolean;
}

/**
 * Fetch the ENTIRE knowledge base — every source's full text — so the caller
 * can feed all of it to the model. `maxChars` bounds the payload so it fits the
 * target model's context window.
 */
export async function getAllKnowledge(maxChars?: number): Promise<KnowledgeBundle> {
  const data = await api<Partial<KnowledgeBundle>>('/v1/knowledge-base/all', {
    method: 'POST',
    body: JSON.stringify(maxChars !== undefined ? { maxChars } : {}),
  });
  return {
    sources: data.sources ?? [],
    sourceCount: data.sourceCount ?? 0,
    chunkCount: data.chunkCount ?? 0,
    totalChars: data.totalChars ?? 0,
    truncated: data.truncated ?? false,
  };
}

/** Org-wide usage analytics (per model), aggregated server-side. */
export interface AnalyticsUsage {
  totals: { requests: number; inputTokens: number; outputTokens: number; cost: number };
  byModel: Array<{ model: string; requests: number; inputTokens: number; outputTokens: number; cost: number }>;
}

/** Fetch org-wide usage analytics. */
export async function getAnalytics(): Promise<AnalyticsUsage> {
  return api<AnalyticsUsage>('/v1/analytics/usage');
}

/**
 * Stream a chat completion for the given model + conversation history, invoking
 * `onToken` for each delta. Resolves when the stream completes; rejects (or
 * surfaces a terminal error event) on failure. The resolved value carries the
 * model, finish reason, token usage, and (when reported) the server-computed
 * cost so the caller can attribute tokens and cost per user/model.
 */
export async function streamChat(
  modelId: string,
  messages: ChatMessage[],
  onToken: (delta: string) => void,
  options: { signal?: AbortSignal; maxTokens?: number } = {},
): Promise<{ model?: string; finishReason?: string; usage?: TokenUsage; cost?: number }> {
  let model: string | undefined;
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;
  let cost: number | undefined;

  const stream = client.streamChat({
    modelId,
    messages,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  });
  for await (const event of stream as AsyncIterable<ChatEvent>) {
    if (options.signal?.aborted) {
      break;
    }
    if (event.type === 'token') {
      onToken(event.delta);
    } else if (event.type === 'completion') {
      model = event.model;
      finishReason = event.finishReason;
      usage = event.usage;
      cost = event.cost;
    } else if (event.type === 'error') {
      throw new Error(event.error.message);
    }
  }
  return { model, finishReason, usage, cost };
}

/** Run a web search through the backend provider rotation. */
export async function webSearch(query: string, limit = 6): Promise<SearchResult[]> {
  return client.webSearch({ query, limit });
}

/** Downloadable file returned by `/v1/files/generate`. */
export interface GeneratedFile {
  filename: string;
  mimeType: string;
  base64: string;
}

/** File formats supported by the server-side generator. */
export type GeneratedFileFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'md' | 'html' | 'txt' | 'csv';

/** Generate a real file from Markdown (PDF/DOCX/PPTX/XLSX/etc.). */
export async function generateFile(
  format: GeneratedFileFormat,
  markdown: string,
  title?: string,
): Promise<GeneratedFile> {
  const response = await fetch(`${API_BASE_URL}/v1/files/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ format, markdown, title }),
  });
  const data = (await response.json()) as GeneratedFile & { error?: string };
  if (!response.ok || data.error) {
    throw new Error(data.error ?? `file generation failed (${response.status})`);
  }
  return data;
}

/** Trigger a browser download for a base64 file returned by the API. */
export function downloadGeneratedFile(file: GeneratedFile): void {
  const raw = atob(file.base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const blob = new Blob([bytes], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ── Designed documents (Gamma-like) ──────────────────────────────────────── */

/** Output formats for the designed-document engine. */
export type DesignedFormat = 'pptx' | 'pdf' | 'docx';

/** A theme id for the designed-document engine (`auto` lets the AI choose). */
export type DocThemeId =
  | 'auto'
  | 'modern-saas'
  | 'enterprise'
  | 'startup'
  | 'consulting'
  | 'government'
  | 'investor-pitch'
  | 'corporate';

/** Selectable themes for the design picker (label + id). */
export const DOC_THEMES: { id: DocThemeId; label: string }[] = [
  { id: 'auto', label: 'Auto (AI picks)' },
  { id: 'modern-saas', label: 'Modern SaaS' },
  { id: 'enterprise', label: 'Enterprise' },
  { id: 'startup', label: 'Startup' },
  { id: 'consulting', label: 'Consulting' },
  { id: 'government', label: 'Government' },
  { id: 'investor-pitch', label: 'Investor Pitch' },
  { id: 'corporate', label: 'Corporate' },
];

/** Designed-format labels for the format picker. */
export const DESIGNED_FORMATS: { format: DesignedFormat; label: string }[] = [
  { format: 'pptx', label: 'Presentation (.pptx)' },
  { format: 'pdf', label: 'Document (.pdf)' },
  { format: 'docx', label: 'Word (.docx)' },
];

/** Branding overrides for a designed document. */
export interface DesignBrand {
  organization?: string;
  primaryColor?: string;
  accentColor?: string;
  footer?: string;
  watermark?: string;
}

/** Options for {@link generateDesignedDocument}. */
export interface DesignedDocOptions {
  format: DesignedFormat;
  /** A theme id, or `auto` / undefined to let the AI choose. */
  themeId?: DocThemeId;
  /** Force a template; otherwise it is auto-selected from the prompt. */
  templateId?: string;
  /** Max output tokens (controls document length). */
  maxTokens?: number;
  /** Branding overrides. */
  brand?: DesignBrand;
}

/** Streaming callbacks for {@link generateDesignedDocument}. */
export interface DesignedDocCallbacks {
  signal?: AbortSignal;
  /** A phase update (`planning`, `authoring`, `rendering`). */
  onStep?: (phase: string, message: string) => void;
  /** The validated spec metadata (e.g. how many sections/slides). */
  onSpec?: (info: { sectionCount: number; themeId?: string; docType?: string }) => void;
}

/** The result of a designed-document run. */
export interface DesignedDocResult {
  file: GeneratedFile;
  /** A PDF rendering of the same design for in-browser preview (non-PDF formats). */
  preview?: GeneratedFile;
  themeId?: string;
  docType?: string;
  format: DesignedFormat;
  sectionCount: number;
  usage?: TokenUsage;
}

/**
 * Generate a fully designed, themed document (Gamma-like) from a prompt. Runs
 * the backend design workflow (`POST /v1/documents/generate`) and streams phase
 * updates via callbacks, returning the rendered file plus token usage.
 */
export async function generateDesignedDocument(
  prompt: string,
  modelId: string,
  opts: DesignedDocOptions,
  callbacks: DesignedDocCallbacks = {},
): Promise<DesignedDocResult> {
  const response = await fetch(`${API_BASE_URL}/v1/documents/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, accept: 'text/event-stream' },
    body: JSON.stringify({
      prompt,
      modelId,
      format: opts.format,
      ...(opts.themeId !== undefined && opts.themeId !== 'auto' ? { themeId: opts.themeId } : {}),
      ...(opts.templateId !== undefined ? { templateId: opts.templateId } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.brand !== undefined ? { brand: opts.brand } : {}),
    }),
    signal: callbacks.signal,
  });
  if (!response.ok || response.body === null) {
    throw new Error(`document generation failed (${response.status})`);
  }

  let file: GeneratedFile | undefined;
  let preview: GeneratedFile | undefined;
  let usage: TokenUsage | undefined;
  let themeId: string | undefined;
  let docType: string | undefined;
  let sectionCount = 0;
  let errorMessage: string | undefined;
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  const consumeFrame = (frame: string): void => {
    const event = frame.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
    const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
    if (event === undefined || dataLine === undefined) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataLine) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event === 'step') {
      callbacks.onStep?.(String(payload.phase ?? ''), String(payload.message ?? ''));
    } else if (event === 'spec') {
      sectionCount = typeof payload.sectionCount === 'number' ? payload.sectionCount : sectionCount;
      const spec = payload.spec as Record<string, unknown> | undefined;
      if (spec !== undefined) {
        themeId = typeof spec.themeId === 'string' ? spec.themeId : themeId;
        docType = typeof spec.docType === 'string' ? spec.docType : docType;
      }
      callbacks.onSpec?.({ sectionCount, themeId, docType });
    } else if (event === 'completion') {
      file = payload.file as GeneratedFile | undefined;
      preview = payload.preview as GeneratedFile | undefined;
      themeId = typeof payload.themeId === 'string' ? payload.themeId : themeId;
      docType = typeof payload.docType === 'string' ? payload.docType : docType;
      const u = payload.usage as Record<string, unknown> | undefined;
      if (typeof u === 'object' && u !== null) {
        const inTok = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
        const outTok = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
        if (inTok + outTok > 0) usage = { inputTokens: inTok, outputTokens: outTok };
      }
    } else if (event === 'error') {
      errorMessage = typeof payload.message === 'string' ? payload.message : 'document generation failed';
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        consumeFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim().length > 0) consumeFrame(buffer);

  if (errorMessage !== undefined) throw new Error(errorMessage);
  if (file === undefined) throw new Error('document generation produced no file');
  return {
    file,
    ...(preview !== undefined ? { preview } : {}),
    themeId,
    docType,
    format: opts.format,
    sectionCount,
    usage,
  };
}

/** The result of a deterministic Markdown render (no model call). */
export interface RenderedDocResult {
  file: GeneratedFile;
  /** PDF preview when the requested format is not already PDF. */
  preview?: GeneratedFile;
  sectionCount: number;
  themeId: string;
  docType: string;
}

/**
 * Render existing Markdown (e.g. a chat answer) as a fully designed, themed
 * document via `POST /v1/documents/render`. Deterministic and instant — no
 * model tokens are spent. Returns the file plus a PDF preview for non-PDF
 * formats so the UI can show the result inline.
 */
export async function renderDesignedFromMarkdown(
  markdown: string,
  opts: { format?: DesignedFormat; title?: string; themeId?: DocThemeId; brand?: DesignBrand } = {},
): Promise<RenderedDocResult> {
  const response = await fetch(`${API_BASE_URL}/v1/documents/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({
      markdown,
      ...(opts.format !== undefined ? { format: opts.format } : {}),
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.themeId !== undefined && opts.themeId !== 'auto' ? { themeId: opts.themeId } : {}),
      ...(opts.brand !== undefined ? { brand: opts.brand } : {}),
    }),
  });
  const data = (await response.json()) as RenderedDocResult & { error?: string };
  if (!response.ok || data.error !== undefined) {
    throw new Error(data.error ?? `document render failed (${response.status})`);
  }
  return data;
}

/** A source surfaced by the deep-research endpoint. */
export interface ResearchSource {
  index: number;
  title: string;
  url: string;
  snippet: string;
}

/** A structured progress update from a deep-research run (drives the live UI). */
export interface ResearchProgress {
  /** The orchestrator phase. */
  phase:
    | 'planning'
    | 'planned'
    | 'searching'
    | 'searched'
    | 'reading'
    | 'read'
    | 'outlining'
    | 'outlined'
    | 'writing'
    | 'progress'
    | 'retry'
    | 'skipped'
    | 'synthesizing'
    | string;
  /** Human-readable status line. */
  message: string;
  /** Planned search queries (on `planned`). */
  queries?: string[];
  /** The section outline (on `outlined`). */
  sections?: string[];
  /** Current section index (1-based). */
  current?: number;
  /** Total sections / sources / queries. */
  total?: number;
  /** Sources found (on `searched`). */
  found?: number;
  /** The section heading currently being written. */
  heading?: string;
  /** Running character count of the report. */
  chars?: number;
  /** Running word count of the report. */
  words?: number;
  /** Running token estimate. */
  tokens?: number;
}

/** Callbacks for a streamed deep-research run. */
export interface ResearchCallbacks {
  onStep?: (message: string) => void;
  /** Structured progress (preferred — drives the premium research UI). */
  onProgress?: (progress: ResearchProgress) => void;
  onSource?: (source: ResearchSource) => void;
  onToken?: (delta: string) => void;
  onComplete?: (report: string, sources: ResearchSource[]) => void;
  signal?: AbortSignal;
  /**
   * Report depth. `exhaustive` ("very deep") writes the report section-by-
   * section in multiple batches, up to ~100,000 tokens / 100k+ characters.
   */
  depth?: 'standard' | 'exhaustive';
  /** Override the maximum output token budget for the report. */
  maxTokens?: number;
}

/** Run GPT-style deep research: plan → search → read → cited report. */
export async function runDeepResearch(
  query: string,
  modelId: string,
  callbacks: ResearchCallbacks = {},
): Promise<{ report: string; sources: ResearchSource[]; usage?: TokenUsage }> {
  const exhaustive = callbacks.depth === 'exhaustive';
  const response = await fetch(`${API_BASE_URL}/v1/research`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, accept: 'text/event-stream' },
    body: JSON.stringify(
      exhaustive
        ? { query, modelId, depth: 'exhaustive', maxTokens: callbacks.maxTokens ?? 100000 }
        : { query, modelId, maxTokens: callbacks.maxTokens ?? 16000 },
    ),
    signal: callbacks.signal,
  });
  if (!response.ok || response.body === null) {
    throw new Error(`deep research failed (${response.status})`);
  }

  let report = '';
  let sources: ResearchSource[] = [];
  let usage: TokenUsage | undefined;
  let buffer = '';
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const consumeFrame = (frame: string) => {
    const event = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!event || data.length === 0) return;
    const payload = JSON.parse(data) as Record<string, unknown>;
    if (event === 'step') {
      callbacks.onStep?.(typeof payload.message === 'string' ? payload.message : 'Working…');
      callbacks.onProgress?.(payload as unknown as ResearchProgress);
    } else if (event === 'source') {
      const source = payload as unknown as ResearchSource;
      sources = [...sources, source];
      callbacks.onSource?.(source);
    } else if (event === 'token') {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      report += delta;
      callbacks.onToken?.(delta);
    } else if (event === 'completion') {
      report = typeof payload.report === 'string' ? payload.report : report;
      sources = Array.isArray(payload.sources) ? (payload.sources as ResearchSource[]) : sources;
      // Parse accumulated token usage emitted by the server.
      const u = payload.usage as Record<string, unknown> | undefined;
      if (typeof u === 'object' && u !== null) {
        const inTok = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
        const outTok = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
        if (inTok + outTok > 0) usage = { inputTokens: inTok, outputTokens: outTok };
      }
      callbacks.onComplete?.(report, sources);
    } else if (event === 'error') {
      throw new Error(typeof payload.message === 'string' ? payload.message : 'deep research failed');
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        consumeFrame(frame);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim().length > 0) consumeFrame(buffer);
  return { report, sources, usage };
}

/**
 * Get a single non-streamed text completion (used internally to resolve
 * referential prompts, e.g. turning "make the previous image but blue" into a
 * concrete standalone image prompt the generator can use).
 *
 * Returns the generated text plus token usage and cost so callers can attribute
 * cost for file-generation, prompt-resolution, etc.
 */
export async function completeText(
  modelId: string,
  messages: ChatMessage[],
  maxTokens = 400,
): Promise<{ text: string; usage?: TokenUsage; cost?: number }> {
  let out = '';
  const result = await streamChat(modelId, messages, (delta) => {
    out += delta;
  }, { maxTokens });
  return { text: out.trim(), usage: result.usage, cost: result.cost };
}

/**
 * Whether an image/video request actually refers to something earlier (and thus
 * needs context resolution). Plain requests like "a blue fox logo" skip the
 * extra model round-trip and go straight to generation for speed.
 */
export function needsContextResolution(userRequest: string): boolean {
  const t = userRequest.trim().toLowerCase();
  if (t.length === 0) return true;
  return /\b(previous|last|that|it|same|again|earlier|above|the one|make it|change it|instead|but |redo|regenerate)\b/.test(
    t,
  );
}

/**
 * Resolve a (possibly referential) image/video request into a concrete,
 * standalone generation prompt using the conversation context + media memory.
 * This is what makes the platform feel context-aware: "generate the previous
 * image but at night" becomes a full prompt that includes the prior subject.
 *
 * For non-referential requests the user's text is used directly (no extra model
 * round-trip), which keeps simple generations fast.
 */
export async function resolveGenerationPrompt(
  modelId: string,
  kind: 'image' | 'video',
  userRequest: string,
  mediaMemory: string,
  recentContext: ChatMessage[],
): Promise<string> {
  // Fast path: a self-contained request with no prior media to reference.
  if (mediaMemory.length === 0 && !needsContextResolution(userRequest)) {
    return userRequest;
  }
  const system: ChatMessage = {
    role: 'system',
    content:
      `You write concise, vivid ${kind}-generation prompts. The user is asking to generate ${kind === 'image' ? 'an image' : 'a video'} ` +
      `in an ongoing conversation. Using the conversation context and the list of previously generated media, ` +
      `rewrite their request as a single self-contained ${kind} prompt (one paragraph, no preamble, no quotes). ` +
      `If they reference a previous ${kind} (e.g. "the previous one", "that image", "make it blue"), carry over the ` +
      `original subject/details and apply the requested change. Output ONLY the final prompt.` +
      (mediaMemory ? `\n\n${mediaMemory}` : ''),
  };
  const messages: ChatMessage[] = [
    system,
    ...recentContext.slice(-6),
    { role: 'user', content: `Request: ${userRequest || `generate ${kind}`}` },
  ];
  try {
    const { text: resolved } = await completeText(modelId, messages, 300);
    return resolved.length > 0 ? resolved : userRequest;
  } catch {
    return userRequest;
  }
}

/** A file selected by the user, decoded for upload. */
export interface PreparedFile {
  name: string;
  mimeType: string;
  /** Base64 (no data: prefix). */
  base64: string;
  /** Whether this is an image (sent as vision input) vs a document (text-extracted). */
  isImage: boolean;
  /** Size in bytes. */
  size: number;
}

/** Read a browser File into a {@link PreparedFile} (base64, no data: prefix). */
export function prepareFile(file: File): Promise<PreparedFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      const base64 = comma === -1 ? result : result.slice(comma + 1);
      resolve({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64,
        isImage: file.type.startsWith('image/'),
        size: file.size,
      });
    };
    reader.onerror = () => reject(new Error(`failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** A document's extracted text. */
export interface ExtractedFile {
  name: string;
  text: string;
  failed?: boolean;
}

/** Extract model-ready text from uploaded documents (PDF/Excel/CSV/Word/text). */
export async function extractFiles(
  files: { name: string; mimeType: string; base64: string }[],
  deep = false,
): Promise<ExtractedFile[]> {
  return retryAsync(
    async () => {
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/v1/files/extract`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ files, deep }),
        },
        300_000,
      );
      if (!response.ok) {
        throw new Error(`file extraction failed (${response.status})`);
      }
      const data = (await response.json()) as { files?: ExtractedFile[] };
      return data.files ?? [];
    },
    { attempts: 6, baseDelayMs: 2000 },
  );
}

/** A generated image returned by the backend. */
export interface GeneratedImage {
  mimeType: string;
  base64?: string;
  url?: string;
}

/** Generate image(s) from a text prompt. High-quality renders are slow, so each
 * attempt has a generous timeout and the call is retried — it may take a while
 * but should not fail. */
export async function generateImage(
  prompt: string,
  count = 1,
  size = '1024x1024',
  quality = 'high',
  onRetry?: (attempt: number) => void,
): Promise<GeneratedImage[]> {
  return retryAsync(
    async () => {
      const response = await fetchWithTimeout(
        `${API_BASE_URL}/v1/images/generate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ prompt, count, size, quality }),
        },
        300_000,
      );
      const data = (await response.json()) as { images?: GeneratedImage[]; error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error ?? `image generation failed (${response.status})`);
      }
      return data.images ?? [];
    },
    { attempts: 5, baseDelayMs: 3000, onRetry: (a) => onRetry?.(a) },
  );
}

/**
 * Expand a short user request into a richly detailed image prompt for sharper,
 * more accurate renders. Adds concrete subject, composition, lighting, style,
 * and quality descriptors while preserving the user's intent. Best-effort: on
 * any failure it returns the original prompt so generation still proceeds.
 */
export async function enhanceImagePrompt(modelId: string, basePrompt: string): Promise<string> {
  const trimmed = basePrompt.trim();
  if (trimmed.length === 0) return trimmed;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are an expert image-generation prompt engineer. Rewrite the user request as ONE ' +
        'vivid, self-contained prompt for a high-end text-to-image model. Specify subject, ' +
        'setting, composition/framing, lighting, color palette, mood, art style or medium, and ' +
        'quality cues (e.g. "ultra-detailed, sharp focus, high dynamic range, 4k"). Preserve the ' +
        "user's intent and any specifics they gave; do not add text/watermarks. Output ONLY the " +
        'final prompt as a single paragraph — no preamble, no quotes, no lists.',
    },
    { role: 'user', content: trimmed },
  ];
  try {
    const { text } = await completeText(modelId, messages, 320);
    return text.length > 0 ? text : trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Turn an image into searchable text for the knowledge base using a
 * vision-capable model: transcribe any visible text (OCR) and add a structured
 * description of the contents (charts, tables, diagrams, layout). Best-effort —
 * returns an empty string on failure so the caller can skip the file.
 */
export async function describeImageForIndex(
  modelId: string,
  image: { mimeType: string; base64: string },
  name: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You convert images into searchable text for a knowledge base. First transcribe ALL ' +
        'visible text verbatim (OCR). Then add a concise, structured description of the image: ' +
        'objects, people, charts, tables, diagrams, and layout. If it contains a table or chart, ' +
        'render the data as text. Output plain text only — no preamble.',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `Image file: ${name}. Extract its text and describe its contents.` },
        { type: 'image', image: { mimeType: image.mimeType, base64: image.base64 } },
      ],
    },
  ];
  try {
    const { text } = await completeText(modelId, messages, 1500);
    return text;
  } catch {
    return '';
  }
}

/** A Sora video job. */
export interface VideoJob {
  id: string;
  status: string;
  progress?: number;
  error?: unknown;
}

/** Create a Sora video-generation job (async — poll with {@link getVideo}). */
export async function createVideo(
  prompt: string,
  seconds = 4,
  size = '720x1280',
): Promise<VideoJob> {
  const response = await fetch(`${API_BASE_URL}/v1/videos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ prompt, seconds, size }),
  });
  const data = (await response.json()) as VideoJob & { error?: string };
  if (!response.ok || data.error) {
    throw new Error((data.error as string) ?? `video creation failed (${response.status})`);
  }
  return data;
}

/** Poll a Sora video job's status. */
export async function getVideo(id: string): Promise<VideoJob> {
  const response = await fetch(`${API_BASE_URL}/v1/videos/${encodeURIComponent(id)}`, {
    headers: { 'x-api-key': API_KEY },
  });
  if (!response.ok) {
    throw new Error(`video status failed (${response.status})`);
  }
  return (await response.json()) as VideoJob;
}

/** Download a completed Sora video as a data URL. */
export async function getVideoDataUrl(id: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/v1/videos/${encodeURIComponent(id)}/content`, {
    headers: { 'x-api-key': API_KEY },
  });
  if (!response.ok) {
    throw new Error(`video download failed (${response.status})`);
  }
  const data = (await response.json()) as { mimeType: string; base64: string };
  return `data:${data.mimeType};base64,${data.base64}`;
}

/** Poll a video job to completion, then return its data URL. */
export async function generateVideo(
  prompt: string,
  onProgress?: (status: string, progress: number) => void,
  options: { seconds?: number; size?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const job = await createVideo(prompt, options.seconds, options.size);
  for (let i = 0; i < 120; i++) {
    if (options.signal?.aborted) {
      throw new Error('cancelled');
    }
    const current = await getVideo(job.id);
    onProgress?.(current.status, current.progress ?? 0);
    if (current.status === 'completed') {
      return getVideoDataUrl(job.id);
    }
    if (current.status === 'failed') {
      throw new Error('video generation failed');
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('video generation timed out');
}

/** Realtime audio: the browser connects to our server's proxy WebSocket. */
export const REALTIME_WS_URL = `${API_BASE_URL.replace(/^http/, 'ws')}/v1/realtime/ws`;

/**
 * Mint a single-use realtime ticket (authenticated) and build the proxy WS
 * URL. The proxy refuses upgrades without a valid ticket, so the Azure-funded
 * realtime bridge cannot be opened by arbitrary pages (WebSockets bypass CORS).
 */
export async function getRealtimeWsUrl(): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/v1/realtime/ticket`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY },
  });
  if (!response.ok) {
    throw new Error(`failed to authorize realtime session (${response.status})`);
  }
  const data = (await response.json()) as { ticket?: string };
  if (typeof data.ticket !== 'string' || data.ticket.length === 0) {
    throw new Error('realtime ticket missing from response');
  }
  return `${REALTIME_WS_URL}?ticket=${encodeURIComponent(data.ticket)}`;
}
