/**
 * A minimal Azure image-generation client (Azure OpenAI `images/generations`).
 *
 * Used for the chat product's image-generation output. Returns base64 PNG(s).
 * Kept separate from the chat {@link HttpAzureClient} because image generation
 * commonly lives on a different Azure resource/region and preview api-version.
 */

import type { AzureImageConfig } from './env';

/** One generated image. */
export interface GeneratedImageResult {
  /** Image MIME type (always image/png from these deployments). */
  mimeType: string;
  /** Base64-encoded image bytes, when returned inline. */
  base64?: string;
  /** A resolvable URL, when the deployment returns a link instead. */
  url?: string;
}

/** Generate one or more images from a text prompt via Azure. */
export async function generateImages(
  config: AzureImageConfig,
  prompt: string,
  options: { count?: number; size?: string; quality?: string; style?: string } = {},
): Promise<GeneratedImageResult[]> {
  const url =
    `${config.endpoint.replace(/\/+$/, '')}/openai/deployments/` +
    `${encodeURIComponent(config.deployment)}/images/generations` +
    `?api-version=${encodeURIComponent(config.apiVersion)}`;

  // Default to the highest-fidelity settings the modern image models accept.
  // `quality: 'high'` (gpt-image-1) yields markedly sharper, more detailed
  // renders; callers may override per request.
  const body: Record<string, unknown> = {
    prompt,
    n: options.count ?? 1,
    size: options.size ?? '1024x1024',
    quality: options.quality ?? 'high',
  };
  if (options.style !== undefined) {
    body.style = options.style;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': config.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Azure image generation failed (${response.status}): ${text.slice(0, 400)}`);
  }

  const parsed = JSON.parse(text) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  return (parsed.data ?? []).map((item) => ({
    mimeType: 'image/png',
    ...(item.b64_json !== undefined ? { base64: item.b64_json } : {}),
    ...(item.url !== undefined ? { url: item.url } : {}),
  }));
}
