/**
 * Realtime audio WebSocket proxy.
 *
 * Azure's realtime API is a WebSocket at `wss://{resource}/openai/realtime`
 * authenticated with an `api-key` HEADER. Browsers cannot set custom headers on
 * a WebSocket, so the browser cannot connect to Azure directly. This proxy
 * bridges the gap: the browser opens a plain WebSocket to our own server, and
 * the server opens the authenticated upstream connection to Azure and relays
 * frames in both directions. The Azure key never leaves the server.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import type { AzureRealtimeConfig } from './env';

/** Options for wiring the realtime proxy onto an HTTP server. */
export interface RealtimeProxyOptions {
  /** Azure realtime connection facts (endpoint/key/version/deployment). */
  config: AzureRealtimeConfig;
  /** The local path browsers connect to (e.g. `/v1/realtime/ws`). */
  path: string;
}

/** Build the authenticated upstream Azure realtime WebSocket URL. */
function upstreamUrl(config: AzureRealtimeConfig): string {
  const wsBase = config.endpoint.replace(/^https:/, 'wss:').replace(/\/+$/, '');
  return (
    `${wsBase}/openai/realtime` +
    `?api-version=${encodeURIComponent(config.apiVersion)}` +
    `&deployment=${encodeURIComponent(config.deployment)}`
  );
}

/**
 * Create a {@link WebSocketServer} (in `noServer` mode) that bridges each
 * browser connection to Azure. Returns the server plus an `upgrade` handler to
 * register on the Node HTTP server's `upgrade` event for the proxy path.
 */
export function createRealtimeProxy(options: RealtimeProxyOptions): {
  wss: WebSocketServer;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
} {
  const { config, path } = options;
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (client: WebSocket) => {
    // Open the authenticated upstream connection to Azure.
    const upstream = new WebSocket(upstreamUrl(config), {
      headers: { 'api-key': config.apiKey },
    });

    // Buffer browser→Azure frames until upstream is open.
    const pending: Array<string | Buffer> = [];
    let upstreamOpen = false;

    upstream.on('open', () => {
      upstreamOpen = true;
      for (const frame of pending) {
        upstream.send(frame);
      }
      pending.length = 0;
    });

    // Azure → browser.
    upstream.on('message', (data: Buffer, isBinary: boolean) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    upstream.on('close', (code: number, reason: Buffer) => {
      if (client.readyState === WebSocket.OPEN) {
        // 1000-1015 + 3000-4999 are valid close codes to forward; clamp others.
        const safeCode = code >= 1000 && code <= 4999 ? code : 1011;
        client.close(safeCode, reason.toString().slice(0, 120));
      }
    });
    upstream.on('error', () => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, 'upstream error');
      }
    });

    // Browser → Azure.
    client.on('message', (data: Buffer, isBinary: boolean) => {
      const frame = isBinary ? data : data.toString();
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        upstream.send(frame);
      } else {
        pending.push(frame);
      }
    });
    client.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
    client.on('error', () => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.close();
      }
    });
  });

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      wss.emit('connection', client, req);
    });
  };

  return { wss, handleUpgrade };
}
