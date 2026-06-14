/**
 * Thinking-aware streaming chat.
 *
 * Streams a chat completion as a sequence of typed events:
 *   - `thinking` — the model's reasoning, shown before the answer (real, not
 *     simulated). Claude models on Bedrock with reasoning support emit genuine
 *     `thinking` content blocks via Anthropic extended thinking; other models
 *     stream straight to the answer.
 *   - `token`   — incremental answer text.
 *   - `completion` — terminal event with model + token usage.
 *   - `error`   — a terminal failure.
 *
 * This is a dedicated path the server owns end-to-end (it does not flow through
 * the spec's RestApi/StreamingEngine, which only model `token`/`completion`),
 * so the reasoning channel can be surfaced to the UI.
 */

import type { ConfigModelRegistry } from '@auxify/core';
import type { ChatMessage, ModelInfo } from '@auxify/types';

import { HttpBedrockClient } from './bedrock-client';
import { HttpAzureClient } from './azure-client';
import type { ServerConfig } from './env';
import { extractVisualArtifacts, type VisualArtifact } from './artifact-render';

/** One event in a thinking-aware chat stream. */
export type ChatStreamEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'token'; delta: string }
  | { type: 'artifact'; artifact: VisualArtifact }
  | { type: 'completion'; model: string; inputTokens?: number; outputTokens?: number }
  | { type: 'error'; message: string };

/**
 * Guidance injected ahead of every chat so a model that cannot emit raster
 * images stops refusing and instead returns vector markup the platform renders
 * inline as a real picture (see {@link extractVisualArtifacts}).
 */
const VISUAL_ARTIFACT_SYSTEM_PROMPT =
  'When the user asks you to draw, illustrate, or create a picture, diagram, ' +
  'logo, or chart, do not refuse for lack of image generation. Instead, output ' +
  'a complete, self-contained SVG document inside a ```svg code block (or a ' +
  'small self-contained HTML/CSS scene inside a ```html block). The platform ' +
  'automatically renders that markup as a visible image, so produce real, ' +
  'detailed markup rather than describing what you would draw.';

/** Inputs for {@link streamChatEvents}. */
export interface StreamChatInput {
  /** Platform model id (e.g. `claude-sonnet-4-5`, `gpt-5.5`). */
  modelId: string;
  /** Conversation so far. */
  messages: ChatMessage[];
  /** Max output tokens. */
  maxTokens?: number;
  /** Request extended thinking (honored only by reasoning-capable Claude). */
  thinking?: boolean;
}

/** Split text into word-ish chunks for incremental reveal. */
function words(text: string): string[] {
  const matches = text.match(/\S+\s*/g);
  return matches ?? (text.length > 0 ? [text] : []);
}

/** Map a ChatMessage's content to Anthropic content blocks. */
function toAnthropicContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    if (part.image.base64 !== undefined) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.image.mimeType, data: part.image.base64 },
      };
    }
    return { type: 'image', source: { type: 'url', url: part.image.url } };
  });
}

/** Map a ChatMessage's content to OpenAI content. */
function toOpenAIContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    const url =
      part.image.url ??
      (part.image.base64 !== undefined
        ? `data:${part.image.mimeType};base64,${part.image.base64}`
        : '');
    return { type: 'image_url', image_url: { url } };
  });
}

/** Pull a record field as a string, else undefined. */
function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = record?.[key];
  return typeof v === 'string' ? v : undefined;
}

/** Pull a record field as a finite number, else undefined. */
function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = record?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Build a thinking-aware chat streamer bound to the server config + registry. */
export function createChatStreamer(config: ServerConfig, registry: ConfigModelRegistry) {
  const bedrockClient = config.bedrock !== null ? new HttpBedrockClient({ token: config.bedrock.token }) : null;
  const azureClient =
    config.azure !== null
      ? new HttpAzureClient({ endpoint: config.azure.endpoint, apiKey: config.azure.apiKey })
      : null;

  /** Stream a chat completion as {@link ChatStreamEvent}s. */
  async function* streamChatEvents(input: StreamChatInput): AsyncGenerator<ChatStreamEvent> {
    let model: ModelInfo;
    try {
      model = registry.get(input.modelId);
    } catch {
      yield { type: 'error', message: `unknown model "${input.modelId}"` };
      return;
    }

    // Nudge the model to emit renderable vector markup instead of refusing to
    // "make an image"; the platform turns that markup into a visible picture.
    const withGuidance: StreamChatInput = {
      ...input,
      messages: [
        { role: 'system', content: VISUAL_ARTIFACT_SYSTEM_PROMPT },
        ...input.messages,
      ],
    };

    // Tee the provider stream: re-yield every event, accumulate the answer
    // text, and on completion emit one `artifact` event per visual artifact
    // (SVG/HTML) found in the answer — just before the terminal completion.
    let answer = '';
    for await (const event of dispatch(model, withGuidance)) {
      if (event.type === 'completion') {
        for (const artifact of extractVisualArtifacts(answer)) {
          yield { type: 'artifact', artifact };
        }
        yield event;
        continue;
      }
      if (event.type === 'token') {
        answer += event.delta;
      }
      yield event;
    }
  }

  /** Route to the right provider stream for the resolved model. */
  function dispatch(model: ModelInfo, input: StreamChatInput): AsyncGenerator<ChatStreamEvent> {
    if (model.provider === 'bedrock') {
      return streamBedrock(model, input);
    }
    if (model.provider === 'azure') {
      return streamAzure(model, input);
    }
    // Stub/echo or anything else: a minimal echo.
    return streamEcho(model, input);
  }

  /** Stream a Claude response from Bedrock, with real extended thinking. */
  async function* streamBedrock(model: ModelInfo, input: StreamChatInput): AsyncGenerator<ChatStreamEvent> {
    if (bedrockClient === null || config.bedrock === null) {
      yield { type: 'error', message: 'Bedrock is not configured' };
      return;
    }
    const useThinking = input.thinking === true && model.supportsReasoning;

    const systemParts: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [];
    for (const m of input.messages) {
      if (m.role === 'system') {
        const t = typeof m.content === 'string' ? m.content : '';
        if (t.length > 0) systemParts.push(t);
        continue;
      }
      messages.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: toAnthropicContent(m.content),
      });
    }

    const body: Record<string, unknown> = {
      anthropic_version: 'bedrock-2023-05-31',
      // Thinking budget must be < max_tokens; keep headroom for the answer.
      max_tokens: input.maxTokens ?? (useThinking ? 8000 : 4096),
      messages,
    };
    // Opt into the 1M-token context window (beta) for large-context models.
    if (model.maxTokens > 200_000) {
      body.anthropic_beta = ['context-1m-2025-08-07'];
    }
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
    if (useThinking) {
      body.thinking = { type: 'enabled', budget_tokens: 2048 };
      // Anthropic requires temperature unset (=1) when thinking is enabled.
    }

    let result;
    try {
      result = await bedrockClient.invokeModel({
        modelId: model.providerModelId,
        region: config.bedrock.region,
        body: JSON.stringify(body),
      });
    } catch (e) {
      yield { type: 'error', message: e instanceof Error ? e.message : 'Bedrock request failed' };
      return;
    }

    const parsed = JSON.parse(result.body) as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const blocks = parsed.content ?? [];

    // Reveal thinking first (word-by-word for a live feel), then the answer.
    for (const block of blocks) {
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        for (const w of words(block.thinking)) {
          yield { type: 'thinking', delta: w };
        }
      }
    }
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        for (const w of words(block.text)) {
          yield { type: 'token', delta: w };
        }
      }
    }
    yield {
      type: 'completion',
      model: model.id,
      inputTokens: parsed.usage?.input_tokens,
      outputTokens: parsed.usage?.output_tokens,
    };
  }

  /** Stream a GPT/reasoning response from Azure (live token streaming). */
  async function* streamAzure(model: ModelInfo, input: StreamChatInput): AsyncGenerator<ChatStreamEvent> {
    if (azureClient === null || config.azure === null) {
      yield { type: 'error', message: 'Azure is not configured' };
      return;
    }
    const reasoning = model.modality === 'reasoning';

    const messages: Array<Record<string, unknown>> = [];
    for (const m of input.messages) {
      const role = m.role === 'system' && reasoning ? 'developer' : m.role;
      messages.push({ role, content: toOpenAIContent(m.content) });
    }

    const reqBody: Record<string, unknown> = {
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (input.maxTokens !== undefined) {
      if (reasoning) reqBody.max_completion_tokens = input.maxTokens;
      else reqBody.max_tokens = input.maxTokens;
    }

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      const stream = azureClient.sendStream({
        deployment: model.providerModelId,
        apiVersion: reasoning ? config.azure.reasoningApiVersion : config.azure.apiVersion,
        operation: 'chat/completions',
        body: JSON.stringify(reqBody),
      });
      for await (const event of stream) {
        const choices = Array.isArray((event as Record<string, unknown>).choices)
          ? ((event as Record<string, unknown>).choices as unknown[])
          : [];
        const choice = (typeof choices[0] === 'object' && choices[0] !== null ? choices[0] : {}) as Record<string, unknown>;
        const delta = (typeof choice.delta === 'object' && choice.delta !== null ? choice.delta : {}) as Record<string, unknown>;
        const text = readString(delta, 'content');
        if (text !== undefined && text.length > 0) {
          yield { type: 'token', delta: text };
        }
        const usage = (typeof (event as Record<string, unknown>).usage === 'object'
          ? (event as Record<string, unknown>).usage
          : undefined) as Record<string, unknown> | undefined;
        if (usage !== undefined) {
          inputTokens = readNumber(usage, 'prompt_tokens') ?? inputTokens;
          outputTokens = readNumber(usage, 'completion_tokens') ?? outputTokens;
        }
      }
    } catch (e) {
      yield { type: 'error', message: e instanceof Error ? e.message : 'Azure request failed' };
      return;
    }
    yield { type: 'completion', model: model.id, inputTokens, outputTokens };
  }

  /** A trivial echo for the built-in stub model. */
  async function* streamEcho(model: ModelInfo, input: StreamChatInput): AsyncGenerator<ChatStreamEvent> {
    const last = [...input.messages].reverse().find((m) => m.role === 'user');
    const text =
      last === undefined
        ? 'Echo.'
        : typeof last.content === 'string'
          ? `Echo: ${last.content}`
          : 'Echo.';
    for (const w of words(text)) {
      yield { type: 'token', delta: w };
    }
    yield { type: 'completion', model: model.id };
  }

  return { streamChatEvents };
}
