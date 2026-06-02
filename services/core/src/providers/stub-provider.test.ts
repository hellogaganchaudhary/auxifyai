/**
 * Unit tests for the {@link StubProvider} reference implementation and the
 * capability gates (Req 2.1, 2.7, 2.8, 2.9, 2.10, 4.2, 4.3, 44.2).
 *
 * These prove the unified {@link AIProvider} interface is implementable end to
 * end without any vendor SDK, and that the vision (Req 2.8) and
 * image-generation (Req 2.9) capability gates are enforced by an adapter.
 */

import { describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSIONS } from '../storage/index.js';

import {
  StubProvider,
  UnsupportedModelCapabilityError,
  assertChatCapability,
  requestHasImageInput,
} from './index.js';
import type { ChatChunk } from '@auxify/types';
import type { ModelInfo } from '@auxify/types';

function modelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'chat-model',
    provider: 'stub',
    providerModelId: 'stub-chat',
    displayName: 'Stub Chat',
    modality: 'chat',
    tier: 'standard',
    maxTokens: 128_000,
    supportsVision: false,
    supportsTools: true,
    supportsReasoning: false,
    cost: { per1kInputTokens: 0.001, per1kOutputTokens: 0.002 },
    available: true,
    ...overrides,
  };
}

function provider(): StubProvider {
  return new StubProvider({
    providerId: 'stub',
    now: () => 1_700_000_000_000,
    models: [
      modelInfo({ id: 'chat-model' }),
      modelInfo({ id: 'vision-model', supportsVision: true }),
      modelInfo({ id: 'embed-model', modality: 'embedding' }),
      modelInfo({ id: 'image-model', modality: 'image' }),
      modelInfo({ id: 'realtime-model', modality: 'realtime' }),
    ],
  });
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('StubProvider.chat (Req 4.2, 4.3)', () => {
  it('streams tokens incrementally and ends with a completion chunk carrying model and usage', async () => {
    const p = provider();
    const chunks = await collect(
      p.chat({ modelId: 'chat-model', messages: [{ role: 'user', content: 'hello world' }] }),
    );
    const terminal = chunks.at(-1)!;
    const intermediate = chunks.slice(0, -1);

    expect(intermediate.length).toBeGreaterThan(0);
    expect(intermediate.every((c) => c.done !== true)).toBe(true);
    expect(terminal.done).toBe(true);
    expect(terminal.model).toBe('chat-model');
    expect(terminal.finishReason).toBe('stop');
    expect(terminal.usage?.outputTokens).toBeGreaterThan(0);

    const text = intermediate.map((c) => c.delta).join('');
    expect(text).toContain('hello world');
  });

  it('accepts image input for a vision-capable model (Req 2.8)', async () => {
    const p = provider();
    const chunks = await collect(
      p.chat({
        modelId: 'vision-model',
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
    expect(chunks.at(-1)!.done).toBe(true);
  });

  it('rejects image input for a non-vision model (Req 2.8)', async () => {
    const p = provider();
    const stream = p.chat({
      modelId: 'chat-model',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', image: { mimeType: 'image/png', base64: 'AAAA' } }],
        },
      ],
    });
    await expect(collect(stream)).rejects.toBeInstanceOf(UnsupportedModelCapabilityError);
  });
});

describe('StubProvider.embed (Req 44.2)', () => {
  it('produces one 1536-dimension embedding per input', async () => {
    const p = provider();
    const res = await p.embed({ modelId: 'embed-model', input: ['a', 'b', 'c'] });
    expect(res.embeddings).toHaveLength(3);
    expect(res.embeddings.every((e) => e.length === EMBEDDING_DIMENSIONS)).toBe(true);
    expect(res.model).toBe('embed-model');
  });

  it('accepts a single string input', async () => {
    const p = provider();
    const res = await p.embed({ modelId: 'embed-model', input: 'solo' });
    expect(res.embeddings).toHaveLength(1);
    expect(res.embeddings[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('is deterministic for the same input', async () => {
    const p = provider();
    const a = await p.embed({ modelId: 'embed-model', input: 'same' });
    const b = await p.embed({ modelId: 'embed-model', input: 'same' });
    expect(a.embeddings[0]).toEqual(b.embeddings[0]);
  });
});

describe('StubProvider.generateImage (Req 2.9)', () => {
  it('returns image assets for an image-modality model', async () => {
    const p = provider();
    const res = await p.generateImage({ modelId: 'image-model', prompt: 'a cat', count: 2 });
    expect(res.images).toHaveLength(2);
    expect(res.images[0]!.mimeType).toBe('image/png');
    expect(res.images[0]!.base64).toBeTruthy();
  });

  it('rejects image generation on a non-image model (Req 2.9)', async () => {
    const p = provider();
    await expect(
      p.generateImage({ modelId: 'chat-model', prompt: 'nope' }),
    ).rejects.toBeInstanceOf(UnsupportedModelCapabilityError);
  });
});

describe('StubProvider.realtime (Req 2.1)', () => {
  it('opens a session that can be closed', async () => {
    const p = provider();
    const session = p.realtime({ modelId: 'realtime-model' });
    expect(session.status).toBe('open');
    expect(session.modelId).toBe('realtime-model');
    await session.close();
    expect(session.status).toBe('closed');
  });
});

describe('StubProvider.listModels / healthCheck (Req 2.7, 2.10)', () => {
  it('lists advertised models with capability metadata', async () => {
    const p = provider();
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toContain('vision-model');
    expect(models.find((m) => m.id === 'vision-model')!.supportsVision).toBe(true);
  });

  it('reports healthy by default and unhealthy after setHealthy(false)', async () => {
    const p = provider();
    expect((await p.healthCheck()).healthy).toBe(true);
    p.setHealthy(false);
    const status = await p.healthCheck();
    expect(status.healthy).toBe(false);
    expect(status.providerId).toBe('stub');
    expect(status.detail).toBeTruthy();
  });
});

describe('capability helpers', () => {
  it('requestHasImageInput detects image parts', () => {
    expect(
      requestHasImageInput({
        modelId: 'm',
        messages: [{ role: 'user', content: 'text only' }],
      }),
    ).toBe(false);
    expect(
      requestHasImageInput({
        modelId: 'm',
        messages: [
          { role: 'user', content: [{ type: 'image', image: { mimeType: 'image/png' } }] },
        ],
      }),
    ).toBe(true);
  });

  it('assertChatCapability passes for text-only requests on a non-vision model', () => {
    expect(() =>
      assertChatCapability(modelInfo(), {
        modelId: 'chat-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).not.toThrow();
  });
});
