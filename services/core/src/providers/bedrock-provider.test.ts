/**
 * Unit tests for the {@link BedrockProvider} adapter (Req 2.4, 2.7, 2.8, 2.9,
 * 4.3).
 *
 * These prove the adapter conforms to the unified {@link AIProvider} interface
 * and — crucially — that it shapes requests with the *configured* Bedrock model
 * id and region (Req 2.4), maps the streamed Anthropic events to
 * {@link ChatChunk}s with a terminal usage + finishReason chunk (Req 4.3), and
 * enforces the vision (Req 2.8) and image-generation (Req 2.9) capability gates.
 * A fake {@link BedrockClientPort} stands in for the AWS SDK so no network or
 * credentials are needed.
 */

import { describe, expect, it } from 'vitest';

import { ConfigModelRegistry } from './model-registry.js';
import {
  BedrockProvider,
  UnsupportedModelCapabilityError,
  type BedrockClientPort,
  type BedrockInvokeModelInput,
  type BedrockInvokeModelResult,
  type BedrockStreamEvent,
  type ProviderConfig,
  type RegistryConfig,
} from './index.js';
import type { ChatChunk } from '@auxify/types';

// A registry covering the model shapes the Bedrock adapter must serve.
const registryConfig: RegistryConfig = {
  providers: [
    { id: 'bedrock', kind: 'bedrock', region: 'us-east-1' },
    { id: 'azure', kind: 'azure', apiVersion: '2024-10-21' },
  ],
  models: [
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
    {
      id: 'claude-haiku-novision',
      provider: 'bedrock',
      providerModelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      displayName: 'Claude 3.5 Haiku',
      modality: 'chat',
      tier: 'economy',
      maxTokens: 200_000,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: false,
      cost: { per1kInputTokens: 0.0008, per1kOutputTokens: 0.004 },
    },
    {
      id: 'titan-embed',
      provider: 'bedrock',
      providerModelId: 'amazon.titan-embed-text-v2:0',
      displayName: 'Titan Embeddings',
      modality: 'embedding',
      tier: 'economy',
      maxTokens: 8_192,
      supportsVision: false,
      supportsTools: false,
      supportsReasoning: false,
      cost: { per1kInputTokens: 0.00002, per1kOutputTokens: 0 },
    },
    {
      id: 'titan-image',
      provider: 'bedrock',
      providerModelId: 'amazon.titan-image-generator-v2:0',
      displayName: 'Titan Image',
      modality: 'image',
      tier: 'standard',
      maxTokens: 4_000,
      supportsVision: false,
      supportsTools: false,
      supportsReasoning: false,
      cost: { per1kInputTokens: 0, per1kOutputTokens: 0 },
    },
    {
      // A model owned by a different provider — must be rejected by the adapter.
      id: 'gpt-4o',
      provider: 'azure',
      providerModelId: 'gpt-4o',
      displayName: 'GPT-4o',
      modality: 'chat',
      tier: 'standard',
      maxTokens: 128_000,
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: false,
      cost: { per1kInputTokens: 0.005, per1kOutputTokens: 0.015 },
    },
  ],
};

const bedrockConfig: ProviderConfig = {
  id: 'bedrock',
  kind: 'bedrock',
  region: 'eu-west-1',
};

/** Record of every call made to the fake client, for request-shape assertions. */
interface RecordedCalls {
  invoke: BedrockInvokeModelInput[];
  stream: BedrockInvokeModelInput[];
  healthProbes: string[];
}

/** A configurable fake {@link BedrockClientPort} that records what it received. */
function fakeClient(opts: {
  streamEvents?: BedrockStreamEvent[];
  invokeBody?: string;
  healthShouldThrow?: boolean;
}): { client: BedrockClientPort; calls: RecordedCalls } {
  const calls: RecordedCalls = { invoke: [], stream: [], healthProbes: [] };
  const client: BedrockClientPort = {
    async invokeModel(input: BedrockInvokeModelInput): Promise<BedrockInvokeModelResult> {
      calls.invoke.push(input);
      return { body: opts.invokeBody ?? '{}' };
    },
    async *invokeModelWithResponseStream(
      input: BedrockInvokeModelInput,
    ): AsyncIterable<BedrockStreamEvent> {
      calls.stream.push(input);
      for (const event of opts.streamEvents ?? []) {
        yield event;
      }
    },
    async healthProbe(region: string): Promise<void> {
      calls.healthProbes.push(region);
      if (opts.healthShouldThrow) {
        throw new Error('bedrock unreachable');
      }
    },
  };
  return { client, calls };
}

function provider(
  opts: Parameters<typeof fakeClient>[0] = {},
): { provider: BedrockProvider; calls: RecordedCalls } {
  const registry = new ConfigModelRegistry(registryConfig);
  const { client, calls } = fakeClient(opts);
  return {
    provider: new BedrockProvider(bedrockConfig, registry, client, {
      now: () => 1_700_000_000_000,
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

/** A minimal Anthropic streaming event sequence with usage + stop reason. */
const claudeStream: BedrockStreamEvent[] = [
  { type: 'message_start', message: { usage: { input_tokens: 11 } } },
  { type: 'content_block_start', index: 0 },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];

describe('BedrockProvider construction (Req 2.4)', () => {
  it('requires a configured region', () => {
    const registry = new ConfigModelRegistry(registryConfig);
    const { client } = fakeClient({});
    expect(
      () => new BedrockProvider({ id: 'bedrock', kind: 'bedrock' }, registry, client),
    ).toThrow(/region/);
  });

  it('exposes the configured provider id', () => {
    const { provider: p } = provider();
    expect(p.providerId).toBe('bedrock');
  });
});

describe('BedrockProvider.chat (Req 2.4, 4.2, 4.3)', () => {
  it('submits to Bedrock with the configured providerModelId and region', async () => {
    const { provider: p, calls } = provider({ streamEvents: claudeStream });
    await collect(
      p.chat({ modelId: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(calls.stream).toHaveLength(1);
    const call = calls.stream[0]!;
    // Uses the configured Bedrock model id, not the platform id (Req 2.4).
    expect(call.modelId).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
    // Uses the configured region (Req 2.4).
    expect(call.region).toBe('eu-west-1');
  });

  it('shapes the Anthropic Messages body with system prompt and max_tokens', async () => {
    const { provider: p, calls } = provider({ streamEvents: claudeStream });
    await collect(
      p.chat({
        modelId: 'claude-sonnet',
        systemPrompt: 'be terse',
        maxTokens: 256,
        temperature: 0.5,
        messages: [
          { role: 'system', content: 'also helpful' },
          { role: 'user', content: 'hi' },
        ],
      }),
    );
    const body = JSON.parse(calls.stream[0]!.body);
    expect(body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.5);
    expect(body.system).toContain('be terse');
    expect(body.system).toContain('also helpful');
    // Only user/assistant turns remain in `messages` (system folded into `system`).
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('streams text deltas then a terminal chunk with model, usage, and finishReason', async () => {
    const { provider: p } = provider({ streamEvents: claudeStream });
    const chunks = await collect(
      p.chat({ modelId: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const intermediate = chunks.slice(0, -1);
    const terminal = chunks.at(-1)!;

    expect(intermediate.map((c) => c.delta).join('')).toBe('Hello, world');
    expect(intermediate.every((c) => c.done !== true)).toBe(true);
    expect(terminal.done).toBe(true);
    expect(terminal.model).toBe('claude-sonnet');
    expect(terminal.finishReason).toBe('stop');
    expect(terminal.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
  });

  it('maps a max_tokens stop reason to the "length" finish reason (Req 4.3)', async () => {
    const stream: BedrockStreamEvent[] = [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } },
    ];
    const { provider: p } = provider({ streamEvents: stream });
    const chunks = await collect(
      p.chat({ modelId: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(chunks.at(-1)!.finishReason).toBe('length');
  });

  it('encodes vision input as a base64 image source for a vision model (Req 2.8)', async () => {
    const { provider: p, calls } = provider({ streamEvents: claudeStream });
    await collect(
      p.chat({
        modelId: 'claude-sonnet',
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
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'describe' });
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  it('rejects image input for a non-vision model before calling Bedrock (Req 2.8)', async () => {
    const { provider: p, calls } = provider({ streamEvents: claudeStream });
    const stream = p.chat({
      modelId: 'claude-haiku-novision',
      messages: [
        { role: 'user', content: [{ type: 'image', image: { mimeType: 'image/png', base64: 'A' } }] },
      ],
    });
    await expect(collect(stream)).rejects.toBeInstanceOf(UnsupportedModelCapabilityError);
    expect(calls.stream).toHaveLength(0);
  });

  it('rejects a model owned by a different provider', async () => {
    const { provider: p } = provider({ streamEvents: claudeStream });
    await expect(
      collect(p.chat({ modelId: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toThrow(/served by provider "azure"/);
  });
});

describe('BedrockProvider.embed', () => {
  it('invokes Bedrock per input with the configured id/region and maps embeddings', async () => {
    const { provider: p, calls } = provider({
      invokeBody: JSON.stringify({ embedding: [0.1, 0.2, 0.3], inputTextTokenCount: 4 }),
    });
    const res = await p.embed({ modelId: 'titan-embed', input: ['a', 'b'] });
    expect(res.embeddings).toHaveLength(2);
    expect(res.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(res.usage).toEqual({ inputTokens: 8, outputTokens: 0 });
    expect(calls.invoke).toHaveLength(2);
    expect(calls.invoke[0]!.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(calls.invoke[0]!.region).toBe('eu-west-1');
  });

  it('rejects a non-embedding model', async () => {
    const { provider: p } = provider({});
    await expect(p.embed({ modelId: 'claude-sonnet', input: 'x' })).rejects.toBeInstanceOf(
      UnsupportedModelCapabilityError,
    );
  });
});

describe('BedrockProvider.generateImage (Req 2.9)', () => {
  it('maps base64 images for an image model', async () => {
    const { provider: p, calls } = provider({
      invokeBody: JSON.stringify({ images: ['b64one', 'b64two'] }),
    });
    const res = await p.generateImage({ modelId: 'titan-image', prompt: 'a cat', count: 2 });
    expect(res.images).toHaveLength(2);
    expect(res.images[0]).toEqual({ mimeType: 'image/png', base64: 'b64one' });
    expect(calls.invoke[0]!.modelId).toBe('amazon.titan-image-generator-v2:0');
  });

  it('rejects image generation on a non-image model (Req 2.9)', async () => {
    const { provider: p } = provider({});
    await expect(
      p.generateImage({ modelId: 'claude-sonnet', prompt: 'no' }),
    ).rejects.toBeInstanceOf(UnsupportedModelCapabilityError);
  });
});

describe('BedrockProvider.realtime / listModels / healthCheck', () => {
  it('does not support realtime sessions', () => {
    const { provider: p } = provider({});
    expect(() => p.realtime({ modelId: 'claude-sonnet' })).toThrow(
      UnsupportedModelCapabilityError,
    );
  });

  it('lists only this provider models', async () => {
    const { provider: p } = provider({});
    const models = await p.listModels();
    expect(models.map((m) => m.id).sort()).toEqual([
      'claude-haiku-novision',
      'claude-sonnet',
      'titan-embed',
      'titan-image',
    ]);
    expect(models.every((m) => m.provider === 'bedrock')).toBe(true);
  });

  it('reports healthy when the probe succeeds, using the configured region', async () => {
    const { provider: p, calls } = provider({});
    const status = await p.healthCheck();
    expect(status.healthy).toBe(true);
    expect(status.providerId).toBe('bedrock');
    expect(calls.healthProbes).toEqual(['eu-west-1']);
  });

  it('reports unhealthy with detail when the probe throws (Req 2.10)', async () => {
    const { provider: p } = provider({ healthShouldThrow: true });
    const status = await p.healthCheck();
    expect(status.healthy).toBe(false);
    expect(status.detail).toContain('unreachable');
  });
});
