/**
 * Azure Sora video-generation client.
 *
 * Sora is asynchronous: you create a job (`POST /openai/v1/videos`), poll its
 * status (`GET /openai/v1/videos/{id}`), then download the rendered MP4
 * (`GET /openai/v1/videos/{id}/content`). All calls use `api-version=preview`.
 * This client exposes create/status/content so the HTTP layer can drive the
 * job lifecycle (the web app polls through our API).
 */

import type { AzureVideoConfig } from './env';

/** A Sora video job as returned by the API. */
export interface VideoJob {
  /** The job id (begins with `video_`). */
  id: string;
  /** Lifecycle: `queued` | `in_progress` | `completed` | `failed`. */
  status: string;
  /** 0-100 progress, when reported. */
  progress?: number;
  /** The model that produced it (e.g. `sora-2`). */
  model?: string;
  /** Error detail when `status === 'failed'`. */
  error?: unknown;
  /** Requested duration (seconds, string). */
  seconds?: string;
  /** Requested size (e.g. `720x1280`). */
  size?: string;
}

/** Build the base videos URL for the resource. */
function videosUrl(config: AzureVideoConfig, suffix = ''): string {
  return (
    `${config.endpoint.replace(/\/+$/, '')}/openai/v1/videos${suffix}` +
    `?api-version=${encodeURIComponent(config.apiVersion)}`
  );
}

/** Create a Sora video-generation job. */
export async function createVideoJob(
  config: AzureVideoConfig,
  prompt: string,
  options: { seconds?: number; size?: string } = {},
): Promise<VideoJob> {
  const response = await fetch(videosUrl(config), {
    method: 'POST',
    headers: { 'api-key': config.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.deployment,
      prompt,
      seconds: String(options.seconds ?? 4),
      size: options.size ?? '720x1280',
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Sora create failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as VideoJob;
}

/** Get the current status of a Sora job. */
export async function getVideoJob(config: AzureVideoConfig, id: string): Promise<VideoJob> {
  const response = await fetch(videosUrl(config, `/${encodeURIComponent(id)}`), {
    headers: { 'api-key': config.apiKey },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Sora status failed (${response.status}): ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as VideoJob;
}

/** Download a completed Sora video's MP4 bytes (base64-encoded for transport). */
export async function getVideoContent(
  config: AzureVideoConfig,
  id: string,
): Promise<{ mimeType: string; base64: string }> {
  const response = await fetch(videosUrl(config, `/${encodeURIComponent(id)}/content`), {
    headers: { 'api-key': config.apiKey },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sora content failed (${response.status}): ${text.slice(0, 400)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    mimeType: response.headers.get('content-type') ?? 'video/mp4',
    base64: buffer.toString('base64'),
  };
}
