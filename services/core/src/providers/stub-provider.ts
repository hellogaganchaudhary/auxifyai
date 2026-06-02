/**
 * A deterministic, in-memory {@link AIProvider} (Req 2.1).
 *
 * {@link StubProvider} is a fully spec-faithful reference implementation of the
 * unified provider interface used to prove the abstraction is implementable and
 * to drive tests without any network or vendor SDK. It is NOT a concrete vendor
 * adapter — the Bedrock and Azure adapters are task 5.3 — but it exercises the
 * same contract the real adapters must honor: it streams chat token-by-token
 * (Req 4.2) with a terminal usage chunk (Req 4.3), produces 1536-dimension
 * embeddings (Req 44.2), returns image assets for image models (Req 2.9), opens
 * a realtime session (Req 2.1), lists its models with full capability metadata
 * (Req 2.7), and reports health (Req 2.10). It enforces the vision (Req 2.8) and
 * image-generation (Req 2.9) capability gates exactly like a real adapter.
 */

import type {
  ChatChunk,
  ChatRequest,
  EmbedRequest,
  EmbedResponse,
  HealthStatus,
  ImageRequest,
  ImageResponse,
  ModelInfo,
  RealtimeRequest,
  RealtimeSession,
} from '@auxify/types';

import { EMBEDDING_DIMENSIONS } from '../storage/index.js';

import {
  assertChatCapability,
  assertImageGenerationCapability,
} from './capabilities.js';
import { ModelNotFoundError, type AIProvider } from './types.js';

/** Construction options for a {@link StubProvider}. */
export interface StubProviderOptions {
  /** Stable provider id (defaults to `stub`). */
  providerId?: string;
  /** The models this provider advertises via {@link AIProvider.listModels}. */
  models?: ModelInfo[];
  /** Initial health state (defaults to healthy). */
  healthy?: boolean;
  /** Clock for deterministic timestamps in tests; defaults to {@link Date.now}. */
  now?: () => number;
}

/** Split a string into whitespace-delimited tokens, preserving the separators. */
function tokenize(text: string): string[] {
  const matches = text.match(/\S+\s*/g);
  return matches ?? [];
}

/** Flatten a {@link ChatRequest} into a plain prompt string for the echo response. */
function flattenLastUserText(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const message = req.messages[i]!;
    if (message.role !== 'user') {
      continue;
    }
    if (typeof message.content === 'string') {
      return message.content;
    }
    return message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

/**
 * Deterministically derive a 1536-dimension unit-ish embedding from text, so
 * tests get stable, dependency-free vectors that always satisfy the storage
 * dimensionality invariant (Req 44.2).
 */
function deterministicEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i += 1) {
    // Cheap LCG seeded by the content hash and index; values in [-1, 1).
    hash = (Math.imul(hash, 1103515245) + 12345 + i) | 0;
    vector[i] = ((hash >>> 8) % 20000) / 10000 - 1;
  }
  return vector;
}

/**
 * A reference, in-memory provider that conforms to {@link AIProvider} (Req 2.1).
 */
export class StubProvider implements AIProvider {
  readonly providerId: string;

  private readonly models: Map<string, ModelInfo>;
  private healthy: boolean;
  private readonly now: () => number;

  constructor(options: StubProviderOptions = {}) {
    this.providerId = options.providerId ?? 'stub';
    this.models = new Map((options.models ?? []).map((m) => [m.id, m]));
    this.healthy = options.healthy ?? true;
    this.now = options.now ?? Date.now;
  }

  /** Set the health state returned by {@link StubProvider.healthCheck} (test hook). */
  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  /**
   * Stream an echo of the last user message token-by-token (Req 4.2), ending
   * with a terminal chunk that carries the model, token usage, and finish
   * reason (Req 4.3). Enforces the vision capability gate (Req 2.8).
   */
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const model = this.requireModel(req.modelId);
    assertChatCapability(model, req);

    const prompt = flattenLastUserText(req);
    const responseText = prompt.length > 0 ? `Echo: ${prompt}` : 'Echo.';
    const tokens = tokenize(responseText);

    let outputTokens = 0;
    for (const token of tokens) {
      outputTokens += 1;
      yield { delta: token };
    }

    yield {
      delta: '',
      done: true,
      model: req.modelId,
      finishReason: 'stop',
      usage: {
        inputTokens: tokenize(prompt).length,
        outputTokens,
      },
    };
  }

  /** Produce one deterministic 1536-dimension embedding per input (Req 44.2). */
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.requireModel(req.modelId);
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const embeddings = inputs.map((text) => deterministicEmbedding(text));
    const inputTokens = inputs.reduce((sum, text) => sum + tokenize(text).length, 0);
    return {
      embeddings,
      model: req.modelId,
      usage: { inputTokens, outputTokens: 0 },
    };
  }

  /** Return placeholder image assets for an image-modality model (Req 2.9). */
  async generateImage(req: ImageRequest): Promise<ImageResponse> {
    const model = this.requireModel(req.modelId);
    assertImageGenerationCapability(model);
    const count = req.count ?? 1;
    const images = Array.from({ length: count }, () => ({
      mimeType: 'image/png',
      // 1x1 transparent PNG — a deterministic, dependency-free placeholder asset.
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    }));
    return { images, model: req.modelId };
  }

  /** Open a closeable in-memory realtime session (Req 2.1). */
  realtime(req: RealtimeRequest): RealtimeSession {
    this.requireModel(req.modelId);
    const session: RealtimeSession = {
      sessionId: `stub-rt-${this.now()}`,
      modelId: req.modelId,
      status: 'open',
      close: async () => {
        session.status = 'closed';
      },
    };
    return session;
  }

  /** List the advertised models, each with full capability metadata (Req 2.7). */
  async listModels(): Promise<ModelInfo[]> {
    return [...this.models.values()].map((info) => ({ ...info, cost: { ...info.cost } }));
  }

  /** Report the current health state (Req 2.10). */
  async healthCheck(): Promise<HealthStatus> {
    return {
      providerId: this.providerId,
      healthy: this.healthy,
      checkedAt: new Date(this.now()).toISOString(),
      latencyMs: 0,
      ...(this.healthy ? {} : { detail: 'stub provider marked unhealthy' }),
    };
  }

  private requireModel(modelId: string): ModelInfo {
    const model = this.models.get(modelId);
    if (model === undefined) {
      throw new ModelNotFoundError(modelId);
    }
    return model;
  }
}
