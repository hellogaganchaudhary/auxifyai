/**
 * Azure OpenAI embeddings client for the RAG / knowledge layer.
 *
 * Calls the configured embedding deployment (e.g. `text-embedding-3-large`) and
 * requests exactly {@link EMBEDDING_DIMENSIONS} (1536) dimensions so every
 * vector matches the platform-wide invariant enforced by the Vector_Store. The
 * model owns request shaping here; the rest of the platform consumes the
 * narrow {@link EmbedTexts} port.
 */

import { EMBEDDING_DIMENSIONS } from '@auxify/core';

import type { AzureEmbeddingConfig } from './env';

/** A function that turns texts into 1536-dim embedding vectors. */
export type EmbedTexts = (texts: string[]) => Promise<number[][]>;

/** Build an {@link EmbedTexts} bound to the configured Azure deployment. */
export function createEmbedder(config: AzureEmbeddingConfig): EmbedTexts {
  const base = config.endpoint.replace(/\/+$/, '');
  const url =
    `${base}/openai/deployments/${encodeURIComponent(config.deployment)}/embeddings` +
    `?api-version=${encodeURIComponent(config.apiVersion)}`;

  return async (texts: string[]): Promise<number[][]> => {
    const input = texts.map((t) => (t.length > 0 ? t : ' '));
    if (input.length === 0) {
      return [];
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': config.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ input, dimensions: EMBEDDING_DIMENSIONS }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Azure embeddings failed (${response.status}): ${text.slice(0, 400)}`);
    }
    const parsed = JSON.parse(text) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const data = parsed.data ?? [];
    // The API returns results in `index` order; sort defensively before mapping.
    return [...data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((d) => d.embedding ?? []);
  };
}
