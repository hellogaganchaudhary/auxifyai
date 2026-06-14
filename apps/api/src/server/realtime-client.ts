/**
 * Azure realtime (audio) session client.
 *
 * The realtime API works over a persistent socket (WebSocket/WebRTC). The
 * browser cannot safely hold the resource API key, so this client mints a
 * short-lived session via `POST /openai/realtimeapi/sessions`, which returns an
 * ephemeral client secret the browser uses to connect directly. This keeps the
 * long-lived key server-side.
 */

import type { AzureRealtimeConfig } from './env';

/** The ephemeral session details handed to the browser to connect. */
export interface RealtimeSessionInfo {
  /** The session id. */
  id: string;
  /** The model serving the session. */
  model: string;
  /** The WebSocket URL the browser connects to. */
  websocketUrl: string;
  /** The ephemeral client secret (short-lived), when the API issued one. */
  clientSecret?: string;
  /** Expiry (epoch seconds) of the client secret, when provided. */
  expiresAt?: number;
  /** The raw session object for any extra fields the client needs. */
  raw: Record<string, unknown>;
}

/** Create a realtime session and return the connection info for the browser. */
export async function createRealtimeSession(
  config: AzureRealtimeConfig,
  options: { voice?: string; instructions?: string } = {},
): Promise<RealtimeSessionInfo> {
  const base = config.endpoint.replace(/\/+$/, '');
  const url = `${base}/openai/realtimeapi/sessions?api-version=${encodeURIComponent(config.apiVersion)}`;

  const body: Record<string, unknown> = { model: config.deployment };
  if (options.voice !== undefined) {
    body.voice = options.voice;
  }
  if (options.instructions !== undefined) {
    body.instructions = options.instructions;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': config.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Realtime session failed (${response.status}): ${text.slice(0, 400)}`);
  }
  const session = JSON.parse(text) as Record<string, unknown>;

  // The browser connects to the realtime WebSocket using the ephemeral secret.
  const wsBase = base.replace(/^https:/, 'wss:');
  const websocketUrl =
    `${wsBase}/openai/realtimeapi?api-version=${encodeURIComponent(config.apiVersion)}` +
    `&deployment=${encodeURIComponent(config.deployment)}`;

  const clientSecretObj =
    typeof session.client_secret === 'object' && session.client_secret !== null
      ? (session.client_secret as Record<string, unknown>)
      : undefined;

  return {
    id: typeof session.id === 'string' ? session.id : '',
    model: typeof session.model === 'string' ? session.model : config.deployment,
    websocketUrl,
    ...(typeof clientSecretObj?.value === 'string' ? { clientSecret: clientSecretObj.value } : {}),
    ...(typeof clientSecretObj?.expires_at === 'number'
      ? { expiresAt: clientSecretObj.expires_at }
      : {}),
    raw: session,
  };
}
