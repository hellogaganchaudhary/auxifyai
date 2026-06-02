/**
 * Unit tests for the {@link AzureProvider} adapter (Req 2.5, 2.7, 2.8, 2.9,
 * 4.3).
 *
 * These prove the adapter conforms to the unified {@link AIProvider} interface
 * and — crucially — that it shapes requests with the *configured* Azure
 * deployment name and API version (Req 2.5), maps the streamed Chat Completions
 * SSE deltas to {@link ChatChunk}s with a terminal usage + finishReason chunk
 * (Req 4.3), routes reasoning/realtime/image modalities correctly, and enforces
 * the vision (Req 2.8) and image-generation (Req 2.9) capability gates. A fake
 * {@link AzureClientPort} stands in for the Azure SDK so no network or
 * credentials are needed.
 */

import { describe, expect, it } from 'vitest';

import { ConfigModelRegistry } from './model-registry.js';
import {
  AzureProvider,
  UnsupportedModelCapabilityError,
  type AzureClientPort,
  type AzureRequestInput,
  type AzureResponseResult,
  type AzureStreamEvent,
  type ProviderConfig,
  type RegistryConfig,
} from './index.js';
import type { ChatChunk } from '@auxify/types';

const registryConfig: RegistryConfig = {
  providers: [
    { id: 'azure', kind: 'azure', apiVersion: '2024-10-21' },
    { id: 'bedrock', kind: 'bedrock', region: 'us-east-1' },
  ],
  models: [
    {
      id: 'gpt-4o',
      provider: 'azure',
      providerModelId: 'gpt-4o-deployment',
      displayName: 'GPT-4o',
      modality: 'chat',
      tier: 'standard',
      maxTokens: 128_000,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: false,
      cost: { per1kInputTokens: 0.005, per1kOutputTokens: 0.015 },
    },
    {
      id: 'gpt-4o-mini-novision',
      provider: 'azure',
      providerModelId: 'gpt-4o-mini-deployment',
      displayName: 'GPT-4o mini',
      modality: 'chat',
      tier: 'economy',
      maxTokens: 128_000,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: false,
      cost: { per1kInputTokens: 0.00015, per1kOutputTokens: 0.0006 },
    },
    {
      id: 'o3',
      provider: 'azure',
      providerModelId: 'o3-deployment',
      displayName: 'OpenAI o3',
      modality: 'reasoning',
      tier: 'premium',
      maxTokens: 200_000,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      cost: { per1kInputTokens: 0.01, per1kOutputTokens: 0.04 },
    },
    {
      id: 'embed',
      provider: 'azure',
      providerModelId: 'text-embedding-3-small-deployment',
      displayName: 'Embeddings',
      modality: 'embedding',
      tier: 'economy',
      maxTokens: 8_191,
      supportsVision: false,
      supportsTools: false,
      supportsReasoning: false,
      cost: { per1kInputTokens: 0.00002, per1kOutputTokens: 0 },
    },
    {
      id: 'gpt-image-1',
      provider: 'azure',
      providerModelId: 'gpt-image-1-deployment',
      displayName: 'GPT Image 1',
      modality: 'image',
      tier: 'standard',
      maxTokens: 4_000,
      supportsVision: true,
      supportsTools: false,
      supportsReasoning: false,
      cost: { per1kInputTokens: 0, per1kOutputTokens: 0 },
    },
    {
      id: 'gpt-4o-realtime',
      provider: 'azure',
      providerModelId: 'gpt-4o-realtime-deployment',
      displayName: 'GPT-4o Realtime',
      modality: 'realtime',
      tier: 'standard',
      maxTokens: 128_000,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: false,
      cost: { per1kInputTokens: 0.005, per1kOutputTokens: 0.02 },
    },
    {
      id: 'claude-sonnet',
      provider: 'bedrock',
      providerModelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
      displayName: 'Claude Sonnet 4',
      modality: 'chat',
      tier: 'standard',
      maxTokens: 200_000,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      cost: { per1kInputTokens: 0.003, per1kOutputTokens: 0.015 },
    },
  ],
};

const azureConfig: ProviderConfig = {
  id: 'azure',
  kind: 'azure',
  apiVersion: '2024-10-21',
};

interface RecordedCalls {
  send: AzureRequestInput[];
  stream: AzureRequestInput[];
  realtime: Array<{ deployment: string; apiVersion: string }>;
  healthProbes: string[];
}

function fakeClient(opts: {
  streamEvents?: AzureStreamEvent[];
  sendBody?: string;
  healthShouldThrow?: boolean;
  realtimeSessionId?: string;
}): { client: AzureClientPort; calls: RecordedCalls } {
  const calls: RecordedCalls = { send: [], stream: [], realtime: [], healthProbes: [] };
  const client: AzureClientPort = {
    async send(input: AzureRequestInput): Promise<AzureResponseResult> {
      calls.send.push(input);
      return { body: opts.sendBody ?? '{}' };
    },
    async *sendStream(input: AzureRequestInput): AsyncIterable<AzureStreamEvent> {
      calls.stream.push(input);
      for (const event of opts.streamEvents ?? []) {
        yield event;
      }
    },
    async openRealtime(input) {
      calls.realtime.push({ deployment: input.deployment, apiVersion: input.apiVersion });
      return {
        sessionId: opts.realtimeSessionId ?? 'rt-123',
        close: async () => {},
      };
    },
    async healthProbe(apiVersion: string): Promise<void> {
      calls.healthProbes.push(apiVersion);
      if (opts.healthShouldThrow) {
        throw new Error('azure unreachable');
      }
    },
  };
  return { client, calls };
}

function provider(
  opts: Parameters<typeof fakeClient>[0] = {},
  providerOpts?: ConstructorParameters<typeof AzureProvider>[3],
): { provider: AzureProvider; calls: RecordedCalls } {
  const registry = new ConfigModelRegistry(registryConfig);
  const { client, calls } = fakeClient(opts);
  return {
    provider: new AzureProvider(azureConfig, registry, client, {
      now: () => 1_700_000_000_000,
      ...providerOpts,
    }),
    calls,
  };
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** A minimal Chat Completions streaming sequence with a trailing usage chunk. */
const chatStream: AzureStreamEvent[] = [
  { choices: [{ delta: { role: 'assistant', content: '' } }] },
  { choices: [{ delta: { content: 'Hi' } }] },
  { choices: [{ delta: { content: ' there' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
];

describe('AzureProvider construction (Req 2.5)', () => {
  it('requires a configured apiVersion', () => {
    const registry = new ConfigModelRegistry(registryConfig);
    const { client } = fakeClient({});
    expect(() => new AzureProvider({ id: 'azure', kind: 'azure' }, registry, client)).toThrow(
      /apiVersion/,
    );
  });

  it('exposes the configured provider id', () => {
    const { provider: p } = provider();
    expect(p.providerId).toBe('azure');
  });
});

describe('AzureProvider.chat (Req 2.5, 4.2, 4.3)', () => {
  it('submits to the configured deployment and api version', async () => {
    const { provider: p, calls } = provider({ streamEvents: chatStream });
    await collect(p.chat({ modelId: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }));
    expect(calls.stream).toHaveLength(1);
    const call = calls.stream[0]!;
    // Uses the configured deployment name, not the platform id (Req 2.5).
    expect(call.deployment).toBe('gpt-4o-deployment');
    // Uses the configured API version (Req 2.5).
    expect(call.apiVersion).toBe('2024-10-21');
    expect(call.operation).toBe('chat/completions');
  });

  it('streams content deltas then a terminal chunk with model, usage, and finishReason', async () => {
    const { provider: p } = provider({ streamEvents: chatStream });
    const chunks = await collect(
      p.chat({ modelId: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const intermediate = chunks.slice(0, -1);
    const terminal = chunks.at(-1)!;
    expect(intermediate.map((c) => c.delta).join('')).toBe('Hi there');
    expect(terminal.done).toBe(true);
    expect(terminal.model).toBe('gpt-4o');
    expect(terminal.finishReason).toBe('stop');
    expect(terminal.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
  });

  it('shapes the chat body with system role, max_tokens, temperature, and tools', async () => {
    const { provider: p, calls } = provider({ streamEvents: chatStream });
    await collect(
      p.chat({
        modelId: 'gpt-4o',
        systemPrompt: 'be terse',
        maxTokens: 128,
        temperature: 0.3,
        tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object' } }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    const body = JSON.parse(calls.stream[0]!.body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(body.max_tokens).toBe(128);
    expect(body.temperature).toBe(0.3);
    expect(body.stream).toBe(true);
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('lookup');
  });

  it('uses developer role and max_completion_tokens and drops temperature for reasoning models', async () => {
    const { provider: p, calls } = provider({ streamEvents: chatStream });
    await collect(
      p.chat({
        modelId: 'o3',
        systemPrompt: 'think',
        maxTokens: 1000,
        temperature: 0.9,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    const body = JSON.parse(calls.stream[0]!.body);
    expect(body.messages[0]).toEqual({ role: 'developer', content: 'think' });
    expect(body.max_completion_tokens).toBe(1000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('encodes vision input as an image_url data URL for a vision model (Req 2.8)', async () => {
    const { provider: p, calls } = provider({ streamEvents: chatStream });
    await collect(
      p.chat({
        modelId: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              { type: 'image', image: { mimeType: 'image/png', base64: 'AAAA' } },
            ],
          },
        ],
      }),
    );
    const body = JSON.parse(calls.stream[0]!.body);
    const content = body.messages.at(-1).content;
    expect(content[0]).toEqual({ type: 'text', text: 'describe' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' },
    });
  });

  it('rejects image input for a non-vision model before calling Azure (Req 2.8)', async () => {
    const { provider: p, calls } = provider({ streamEvents: chatStream });
    const stream = p.chat({
      modelId: 'gpt-4o-mini-novision',
      messages: [
        { role: 'user', content: [{ type: 'image', image: { mimeType: 'image/png', base64: 'A' } }] },
      ],
    });
    await expect(collect(stream)).rejects.toBeInstanceOf(UnsupportedModelCapabilityError);
    expect(calls.stream).toHaveLength(0);
  });

  it('rejects a model owned by a different provider', async () => {
    const { provider: p } = provider({ streamEvents: chatStream });
    await expect(
      collect(p.chat({ modelId: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toThrow(/served by provider "bedrock"/);
  });
});

describe('AzureProvider.embed', () => {
  it('sends a batched embeddings request and maps data[].embedding', async () => {
    const { provider: p, calls } = provider({
      sendBody: JSON.stringify({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        usage: { prompt_tokens: 6 },
      }),
    });
    const res = await p.embed({ modelId: 'embed', input: ['a', 'b'] });
    expect(res.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(res.usage).toEqual({ inputTokens: 6, outputTokens: 0 });
    expect(calls.send[0]!.deployment).toBe('text-embedding-3-small-deployment');
    expect(calls.send[0]!.operation).toBe('embeddings');
  });

  it('rejects a non-embedding model', async () => {
    const { provider: p } = provider({});
    await expect(p.embed({ modelId: 'gpt-4o', input: 'x' })).rejects.toBeInstanceOf(
      UnsupportedModelCapabilityError,
    );
  });
});

describe('AzureProvider.generateImage (Req 2.5, 2.9)', () => {
  it('maps b64_json images and routes to the configured image deployment/api version', async () => {
    const { provider: p, calls } = provider(
      { sendBody: JSON.stringify({ data: [{ b64_json: 'img1' }] }) },
      { apiVersionOverrides: { image: '2025-04-01-preview' } },
    );
    const res = await p.generateImage({ modelId: 'gpt-image-1', prompt: 'a cat' });
    expect(res.images).toEqual([{ mimeType: 'image/png', base64: 'img1' }]);
    expect(calls.send[0]!.deployment).toBe('gpt-image-1-deployment');
    expect(calls.send[0]!.apiVersion).toBe('2025-04-01-preview');
    expect(calls.send[0]!.operation).toBe('images/generations');
  });

  it('rejects image generation on a non-image model (Req 2.9)', async () => {
    const { provider: p } = provider({});
    await expect(p.generateImage({ modelId: 'gpt-4o', prompt: 'no' })).rejects.toBeInstanceOf(
      UnsupportedModelCapabilityError,
    );
  });
});

describe('AzureProvider.realtime (Req 2.5)', () => {
  it('opens a realtime session against the configured deployment', async () => {
    const { provider: p, calls } = provider({ realtimeSessionId: 'sess-9' });
    const session = p.realtime({ modelId: 'gpt-4o-realtime', instructions: 'hi' });
    expect(session.status).toBe('open');
    expect(session.modelId).toBe('gpt-4o-realtime');
    // The underlying transport is established asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.realtime[0]!.deployment).toBe('gpt-4o-realtime-deployment');
    expect(session.sessionId).toBe('sess-9');
    await session.close();
    expect(session.status).toBe('closed');
  });

  it('rejects realtime on a non-realtime model', () => {
    const { provider: p } = provider({});
    expect(() => p.realtime({ modelId: 'gpt-4o' })).toThrow(UnsupportedModelCapabilityError);
  });
});

describe('AzureProvider.listModels / healthCheck', () => {
  it('lists only this provider models', async () => {
    const { provider: p } = provider({});
    const models = await p.listModels();
    expect(models.every((m) => m.provider === 'azure')).toBe(true);
    expect(models.map((m) => m.id)).toContain('gpt-4o');
    expect(models.map((m) => m.id)).not.toContain('claude-sonnet');
  });

  it('reports healthy using the configured api version, unhealthy on probe failure (Req 2.10)', async () => {
    const { provider: ok, calls } = provider({});
    const okStatus = await ok.healthCheck();
    expect(okStatus.healthy).toBe(true);
    expect(calls.healthProbes).toEqual(['2024-10-21']);

    const { provider: bad } = provider({ healthShouldThrow: true });
    const badStatus = await bad.healthCheck();
    expect(badStatus.healthy).toBe(false);
    expect(badStatus.detail).toContain('unreachable');
  });
});
