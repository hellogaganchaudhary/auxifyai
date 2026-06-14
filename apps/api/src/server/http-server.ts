/**
 * The Node HTTP transport adapter for the {@link RestApi} dispatcher.
 *
 * This is the thin "transport adapter" the REST_API design calls for: it
 * normalizes a Node `IncomingMessage` into a {@link RestRequest}, calls
 * {@link RestApi.handle}, and serializes the returned buffered
 * {@link RestResponse} or streaming {@link SseResponse} back to the socket. It
 * couples the HTTP framework (Node `http`) to the otherwise framework-agnostic
 * core in exactly one place.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { RestApi, RestRequest, HttpMethod } from '../rest/index';
import { createRealtimeProxy } from './realtime-proxy';
import type { AzureRealtimeConfig } from './env';

/** The local path the browser opens its realtime WebSocket to. */
export const REALTIME_WS_PATH = '/v1/realtime/ws';

/** Options for {@link startHttpServer}. */
export interface HttpServerOptions {
  /** The wired dispatcher. */
  restApi: RestApi;
  /** Port to listen on. */
  port: number;
  /** Host/interface to bind. */
  host: string;
  /** Allowed CORS origins (comma-separated exact origins, or `*`). */
  corsOrigin: string;
  /** Hard cap on request body size in bytes (413 beyond this). */
  maxBodyBytes: number;
  /** Trust `X-Forwarded-For` only when running behind a trusted proxy. */
  trustProxy: boolean;
  /** The dev API key accepted for the extra (image/file) routes. */
  devApiKey: string;
  /** The dev bearer token accepted for the extra routes. */
  devToken: string;
  /** The single shared application login (server-side validated). */
  appAuth: { email: string; password: string; secret: string };
  /** Generate images (bound from the composition). */
  generateImage: (prompt: string, count?: number, size?: string, quality?: string) => Promise<
    { mimeType: string; base64?: string; url?: string }[]
  >;
  /** Extract text from uploads (bound from the composition). */
  extractFiles: (
    uploads: { name: string; mimeType: string; base64: string }[],
    deep?: boolean,
  ) => Promise<{ name: string; text: string; failed?: boolean }[]>;
  /** Create a Sora video job. */
  createVideo: (prompt: string, seconds?: number, size?: string) => Promise<unknown>;
  /** Poll a Sora video job. */
  getVideo: (id: string) => Promise<unknown>;
  /** Download a completed Sora video (base64). */
  getVideoContent: (id: string) => Promise<{ mimeType: string; base64: string }>;
  /** Mint an ephemeral realtime audio session. */
  createRealtimeSession: (voice?: string, instructions?: string) => Promise<unknown>;
  /** Generate a downloadable document from Markdown. */
  generateFile: (
    format: string,
    markdown: string,
    title?: string,
  ) => Promise<{ filename: string; mimeType: string; base64: string }>;
  /** Run a streamed deep-research session (yields SSE frames). */
  deepResearch: (
    query: string,
    modelId?: string,
    maxSources?: number,
    maxTokens?: number,
    depth?: 'standard' | 'exhaustive',
  ) => AsyncIterable<{ event: string; data: string }>;
  /** Run a streamed Gamma-like document-design session (yields SSE frames). */
  generateDocument: (input: {
    prompt: string;
    modelId?: string;
    format?: 'pptx' | 'pdf' | 'docx';
    themeId?: string;
    templateId?: string;
    brand?: { organization?: string; primaryColor?: string; accentColor?: string; footer?: string; watermark?: string };
    maxTokens?: number;
  }) => AsyncIterable<{ event: string; data: string }>;
  /** Deterministically render Markdown as a designed document (no model call). */
  renderDocument: (input: {
    markdown: string;
    title?: string;
    format?: 'pptx' | 'pdf' | 'docx';
    themeId?: string;
    brand?: { organization?: string; primaryColor?: string; accentColor?: string; footer?: string; watermark?: string };
  }) => Promise<{
    file: { filename: string; mimeType: string; base64: string };
    preview?: { filename: string; mimeType: string; base64: string };
    sectionCount: number;
    themeId: string;
    docType: string;
  }>;
  /** Which optional capabilities are configured (drives the web UI toggles). */
  capabilities: { image: boolean; video: boolean; realtime: boolean; webSearch: boolean; knowledge: boolean };
  /** Azure realtime config for the WebSocket proxy, or `null` when not configured. */
  realtimeConfig: AzureRealtimeConfig | null;
}

/** The HTTP methods the REST_API recognizes. */
const KNOWN_METHODS = new Set<HttpMethod>([
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/** Thrown when a request body exceeds the configured size cap. */
class PayloadTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'PayloadTooLargeError';
  }
}

/** Read and JSON-parse the request body (empty body → undefined; size-capped). */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += (chunk as Buffer).length;
    if (received > maxBytes) {
      // Do NOT destroy here — the caller still needs the socket to deliver a
      // clean 413 to the client; the top-level handler closes it afterwards.
      throw new PayloadTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Lower-cased single-value header map from Node's header bag. */
function normalizeHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/** The client IP for per-IP rate limiting (XFF honored only behind a proxy). */
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      return fwd.split(',')[0]!.trim();
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Constant-time string equality (inputs hashed first so length leaks nothing). */
function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** Mint an opaque session token for a validated login (HMAC over the email). */
function mintSessionToken(email: string, secret: string): string {
  const payload = Buffer.from(email, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** A minimal per-IP sliding-window rate limiter for the extra (expensive) routes. */
class IpRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Whether `ip` may proceed; records the hit when admitted. */
  allow(ip: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/**
 * A safe, client-facing error message. Short operator-authored messages pass
 * through; anything that looks like an upstream/internal detail (URLs, key
 * material, very long text) is replaced by the fallback. The full error is
 * always logged server-side.
 */
function publicMessage(error: unknown, fallback: string, route: string): string {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[api] ${route} failed: ${message}\n`);
  const looksInternal =
    message.length === 0 ||
    message.length > 200 ||
    /https?:\/\//i.test(message) ||
    /api[-_]?key|bearer|token|secret/i.test(message);
  return looksInternal ? fallback : message;
}

/** How long a one-time realtime WebSocket ticket stays valid. */
const REALTIME_TICKET_TTL_MS = 60_000;

/** Whether a handler outcome is a streaming SSE response. */
function isSse(value: unknown): value is { stream: AsyncIterable<{ event?: string; data: string; id?: string }> } {
  return typeof value === 'object' && value !== null && 'stream' in value;
}

/** Start the HTTP server and return the Node {@link Server} handle. */
export function startHttpServer(options: HttpServerOptions): Server {
  const { restApi, port, host, corsOrigin, devApiKey, devToken, generateImage, extractFiles } =
    options;
  const { createVideo, getVideo, getVideoContent, createRealtimeSession } = options;
  const { appAuth } = options;
  const { generateFile, deepResearch } = options;
  const { generateDocument, renderDocument } = options;
  const { capabilities } = options;
  const { realtimeConfig } = options;
  const { maxBodyBytes, trustProxy } = options;

  /** The exact origins allowed to call this API from a browser. */
  const allowedOrigins = corsOrigin
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);
  const allowAnyOrigin = allowedOrigins.includes('*');

  /** Per-request CORS + hardening headers (origin echoed only when allowed). */
  function corsFor(req: IncomingMessage): Record<string, string> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const allowed = allowAnyOrigin ? '*' : allowedOrigins.includes(origin) ? origin : '';
    return {
      ...(allowed.length > 0 ? { 'access-control-allow-origin': allowed } : {}),
      ...(allowed.length > 0 && allowed !== '*' ? { vary: 'origin' } : {}),
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type,x-api-key,x-correlation-id',
      'x-content-type-options': 'nosniff',
    };
  }

  /** Whether the request carries the dev API key or bearer token (constant-time). */
  function isAuthed(headers: Record<string, string>): boolean {
    const presentedKey = headers['x-api-key'] ?? '';
    if (presentedKey.length > 0 && safeEqual(presentedKey, devApiKey)) {
      return true;
    }
    const auth = headers['authorization'] ?? '';
    return auth.toLowerCase().startsWith('bearer ') && safeEqual(auth.slice(7).trim(), devToken);
  }

  /** Per-IP limiter for the expensive extra routes (images/videos/files/research). */
  const extraRouteLimiter = new IpRateLimiter(30, 60_000);

  /** Outstanding one-time realtime WebSocket tickets (ticket → expiry epoch ms). */
  const realtimeTickets = new Map<string, number>();

  /** Mint a single-use, short-lived ticket authorizing one WS proxy connection. */
  function mintRealtimeTicket(): string {
    const now = Date.now();
    for (const [ticket, expires] of realtimeTickets) {
      if (expires <= now) {
        realtimeTickets.delete(ticket);
      }
    }
    const ticket = randomBytes(24).toString('base64url');
    realtimeTickets.set(ticket, now + REALTIME_TICKET_TTL_MS);
    return ticket;
  }

  /** Validate and consume a realtime ticket (single use). */
  function consumeRealtimeTicket(ticket: string | null): boolean {
    if (ticket === null || ticket.length === 0) {
      return false;
    }
    const expires = realtimeTickets.get(ticket);
    realtimeTickets.delete(ticket);
    return expires !== undefined && expires > Date.now();
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((error: unknown) => {
      const tooLarge = error instanceof PayloadTooLargeError;
      if (!tooLarge) {
        process.stderr.write(
          `[api] unhandled: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
      }
      if (!res.headersSent) {
        res.writeHead(tooLarge ? 413 : 500, {
          'content-type': 'application/json',
          connection: 'close',
          ...corsFor(req),
        });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: tooLarge ? 'request body too large' : 'internal error' }));
      }
      // Stop receiving the rest of an oversized upload once the response is out.
      if (tooLarge) {
        if (res.writableFinished) {
          req.destroy();
        } else {
          res.once('finish', () => req.destroy());
        }
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cors = corsFor(req);

    /** Send a JSON response with CORS + hardening headers. */
    function sendJson(target: ServerResponse, status: number, body: unknown): void {
      target.writeHead(status, { 'content-type': 'application/json', ...cors });
      target.end(JSON.stringify(body));
    }

    /** Gate an expensive extra route behind the per-IP rate limit. */
    function rateLimited(): boolean {
      const verdict = extraRouteLimiter.allow(clientIp(req, trustProxy));
      if (!verdict.allowed) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(verdict.retryAfterSeconds),
          ...cors,
        });
        res.end(
          JSON.stringify({ error: 'rate limited', retryAfterSeconds: verdict.retryAfterSeconds }),
        );
        return true;
      }
      return false;
    }

    // CORS preflight.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // A simple unauthenticated health endpoint outside the versioned surface.
    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ status: 'ok', service: '@auxify/api' }));
      return;
    }

    // Capabilities the server has configured (drives the web UI's tool toggles).
    if (url.pathname === '/v1/capabilities') {
      sendJson(res, 200, capabilities);
      return;
    }

    // --- Single shared application login (public; password validated here so
    // it is never shipped to the browser). Returns an opaque session token. ---
    if (url.pathname === '/v1/auth/login') {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const body = (await readBody(req, maxBodyBytes)) as Record<string, unknown> | undefined;
      const email = (typeof body?.email === 'string' ? body.email : '').trim().toLowerCase();
      const password = typeof body?.password === 'string' ? body.password : '';
      if (appAuth.password.length === 0) {
        sendJson(res, 503, { error: 'login is not configured (set APP_AUTH_PASSWORD)' });
        return;
      }
      // Constant-time check of both fields before granting a token.
      const okEmail = safeEqual(email, appAuth.email);
      const okPassword = safeEqual(password, appAuth.password);
      if (!okEmail || !okPassword) {
        sendJson(res, 401, { error: 'invalid email or password' });
        return;
      }
      sendJson(res, 200, {
        token: mintSessionToken(appAuth.email, appAuth.secret),
        email: appAuth.email,
      });
      return;
    }

    // --- Extra multimodal routes (image generation + file text extraction) ---
    // These sit alongside the versioned REST surface; they require the dev
    // credential and accept JSON bodies.
    if (url.pathname === '/v1/images/generate' || url.pathname === '/v1/files/extract') {
      const headers = normalizeHeaders(req);
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!isAuthed(headers)) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (rateLimited()) {
        return;
      }
      const body = (await readBody(req, maxBodyBytes)) as Record<string, unknown> | undefined;
      try {
        if (url.pathname === '/v1/images/generate') {
          const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
          if (prompt.trim().length === 0) {
            sendJson(res, 400, { error: 'prompt is required' });
            return;
          }
          const count = typeof body?.count === 'number' ? body.count : 1;
          const size = typeof body?.size === 'string' ? body.size : undefined;
          const quality = typeof body?.quality === 'string' ? body.quality : undefined;
          const images = await generateImage(prompt, count, size, quality);
          sendJson(res, 200, { images });
          return;
        }
        // /v1/files/extract
        const rawFiles = Array.isArray(body?.files) ? body.files : [];
        const uploads = rawFiles
          .map((f) => {
            const r = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>;
            return {
              name: typeof r.name === 'string' ? r.name : 'file',
              mimeType: typeof r.mimeType === 'string' ? r.mimeType : '',
              base64: typeof r.base64 === 'string' ? r.base64 : '',
            };
          })
          .filter((f) => f.base64.length > 0);
        const deep = body?.deep === true;
        const results = await extractFiles(uploads, deep);
        sendJson(res, 200, { files: results });
        return;
      } catch (error) {
        sendJson(res, 500, { error: publicMessage(error, 'request failed', url.pathname) });
        return;
      }
    }

    // --- Sora video generation (async: create / status / content) ---
    if (url.pathname.startsWith('/v1/videos')) {
      const headers = normalizeHeaders(req);
      if (!isAuthed(headers)) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (rateLimited()) {
        return;
      }
      const method = (req.method ?? 'GET').toUpperCase();
      try {
        // POST /v1/videos — create a job.
        if (url.pathname === '/v1/videos' && method === 'POST') {
          const body = (await readBody(req, maxBodyBytes)) as Record<string, unknown> | undefined;
          const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
          if (prompt.trim().length === 0) {
            sendJson(res, 400, { error: 'prompt is required' });
            return;
          }
          const seconds = typeof body?.seconds === 'number' ? body.seconds : undefined;
          const size = typeof body?.size === 'string' ? body.size : undefined;
          const job = await createVideo(prompt, seconds, size);
          sendJson(res, 200, job);
          return;
        }
        // GET /v1/videos/{id} — status; GET /v1/videos/{id}/content — download.
        const match = /^\/v1\/videos\/([^/]+)(\/content)?$/.exec(url.pathname);
        if (match !== null && method === 'GET') {
          const id = decodeURIComponent(match[1]!);
          if (match[2] === '/content') {
            const content = await getVideoContent(id);
            sendJson(res, 200, content);
            return;
          }
          const job = await getVideo(id);
          sendJson(res, 200, job);
          return;
        }
        sendJson(res, 404, { error: 'not found' });
        return;
      } catch (error) {
        sendJson(res, 500, { error: publicMessage(error, 'request failed', url.pathname) });
        return;
      }
    }

    // --- Realtime audio: one-time ticket authorizing the WS proxy upgrade ---
    if (url.pathname === '/v1/realtime/ticket') {
      const headers = normalizeHeaders(req);
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!isAuthed(headers)) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (rateLimited()) {
        return;
      }
      if (realtimeConfig === null) {
        sendJson(res, 503, { error: 'realtime is not configured' });
        return;
      }
      sendJson(res, 200, {
        ticket: mintRealtimeTicket(),
        expiresInSeconds: REALTIME_TICKET_TTL_MS / 1000,
      });
      return;
    }

    // --- Realtime audio: mint an ephemeral session for the browser ---
    if (url.pathname === '/v1/realtime/session') {
      const headers = normalizeHeaders(req);
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!isAuthed(headers)) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (rateLimited()) {
        return;
      }
      const body = (await readBody(req, maxBodyBytes)) as Record<string, unknown> | undefined;
      try {
        const voice = typeof body?.voice === 'string' ? body.voice : undefined;
        const instructions = typeof body?.instructions === 'string' ? body.instructions : undefined;
        const session = await createRealtimeSession(voice, instructions);
        sendJson(res, 200, session);
        return;
      } catch (error) {
        sendJson(res, 500, { error: publicMessage(error, 'request failed', url.pathname) });
        return;
      }
    }

    // --- File generation: Markdown → PDF/DOCX/PPTX/XLSX/MD/HTML/TXT/CSV ---
    if (url.pathname === '/v1/files/generate') {
      const headers = normalizeHeaders(req);
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!isAuthed(headers)) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (rateLimited()) {
        return;
      }
      const body = (await readBody(req, maxBodyBytes)) as Record<string, unknown> | undefined;
      try {
        const format = typeof body?.format === 'string' ? body.format : '';
        const markdown = typeof body?.markdown === 'string' ? body.markdown : '';
        const title = typeof body?.title === 'string' ? body.title : undefined;
        if (format.length === 0 || markdown.trim().length === 0) {
          sendJson(res, 400, { error: 'format and markdown are required' });
          return;
        }
        const file = await generateFile(format, markdown, title);
        sendJson(res, 200, file);
        return;
      } catch (error) {
        sendJson(res, 500, { error: publicMessage(error, 'request failed', url.pathname) });
        return;
      }
    }

    // --- Deep research: streamed plan → search → read → cited report (SSE) ---
    if (url.pathname === '/v1/research') {
      const headers = normalizeHeaders(req);
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!isAuthed(headers)) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (rateLimited()) {
        return;
      }
      const body = (await readBody(req, maxBodyBytes)) as Record<string, unknown> | undefined;
      const queryText = typeof body?.query === 'string' ? body.query : '';
      if (queryText.trim().length === 0) {
        sendJson(res, 400, { error: 'query is required' });
        return;
      }
      const modelId = typeof body?.modelId === 'string' ? body.modelId : undefined;
      const maxSources = typeof body?.maxSources === 'number' ? body.maxSources : undefined;
      const maxTokens = typeof body?.maxTokens === 'number' ? body.maxTokens : undefined;
      const depth = body?.depth === 'exhaustive' ? 'exhaustive' : undefined;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...cors,
      });
      try {
        for await (const frame of deepResearch(queryText, modelId, maxSources, maxTokens, depth)) {
          res.write(`event: ${frame.event}\ndata: ${frame.data}\n\n`);
        }
      } catch (error) {
        const message = publicMessage(error, 'research failed', url.pathname);
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    // --- Designed documents: Gamma-like prompt → themed PPTX/PDF/DOCX (SSE) ---
    if (url.pathname === '/v1/documents/generate') {
      const headers = normalizeHeaders(req);
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!isAuthed(headers)) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (rateLimited()) {
        return;
      }
      const body = (await readBody(req, maxBodyBytes)) as Record<string, unknown> | undefined;
      const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
      if (prompt.trim().length === 0) {
        sendJson(res, 400, { error: 'prompt is required' });
        return;
      }
      const fmt = body?.format;
      const format = fmt === 'pptx' || fmt === 'pdf' || fmt === 'docx' ? fmt : undefined;
      const brandRaw = (body?.brand ?? undefined) as Record<string, unknown> | undefined;
      const brand =
        brandRaw !== undefined
          ? {
              ...(typeof brandRaw.organization === 'string' ? { organization: brandRaw.organization } : {}),
              ...(typeof brandRaw.primaryColor === 'string' ? { primaryColor: brandRaw.primaryColor } : {}),
              ...(typeof brandRaw.accentColor === 'string' ? { accentColor: brandRaw.accentColor } : {}),
              ...(typeof brandRaw.footer === 'string' ? { footer: brandRaw.footer } : {}),
              ...(typeof brandRaw.watermark === 'string' ? { watermark: brandRaw.watermark } : {}),
            }
          : undefined;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...cors,
      });
      try {
        for await (const frame of generateDocument({
          prompt,
          ...(typeof body?.modelId === 'string' ? { modelId: body.modelId } : {}),
          ...(format !== undefined ? { format } : {}),
          ...(typeof body?.themeId === 'string' ? { themeId: body.themeId } : {}),
          ...(typeof body?.templateId === 'string' ? { templateId: body.templateId } : {}),
          ...(brand !== undefined ? { brand } : {}),
          ...(typeof body?.maxTokens === 'number' ? { maxTokens: body.maxTokens } : {}),
        })) {
          res.write(`event: ${frame.event}\ndata: ${frame.data}\n\n`);
        }
      } catch (error) {
        const message = publicMessage(error, 'document generation failed', url.pathname);
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    // --- Designed render: existing Markdown → themed PDF/PPTX/DOCX (no LLM) ---
    if (url.pathname === '/v1/documents/render') {
      const headers = normalizeHeaders(req);
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!isAuthed(headers)) {
        sendJson(res, 401, { error: 'authentication required' });
        return;
      }
      if (rateLimited()) {
        return;
      }
      const body = (await readBody(req, maxBodyBytes)) as Record<string, unknown> | undefined;
      try {
        const markdown = typeof body?.markdown === 'string' ? body.markdown : '';
        if (markdown.trim().length === 0) {
          sendJson(res, 400, { error: 'markdown is required' });
          return;
        }
        const fmt = body?.format;
        const format = fmt === 'pptx' || fmt === 'pdf' || fmt === 'docx' ? fmt : undefined;
        const brandRaw = (body?.brand ?? undefined) as Record<string, unknown> | undefined;
        const brand =
          brandRaw !== undefined
            ? {
                ...(typeof brandRaw.organization === 'string' ? { organization: brandRaw.organization } : {}),
                ...(typeof brandRaw.primaryColor === 'string' ? { primaryColor: brandRaw.primaryColor } : {}),
                ...(typeof brandRaw.accentColor === 'string' ? { accentColor: brandRaw.accentColor } : {}),
                ...(typeof brandRaw.footer === 'string' ? { footer: brandRaw.footer } : {}),
                ...(typeof brandRaw.watermark === 'string' ? { watermark: brandRaw.watermark } : {}),
              }
            : undefined;
        const result = await renderDocument({
          markdown,
          ...(typeof body?.title === 'string' ? { title: body.title } : {}),
          ...(format !== undefined ? { format } : {}),
          ...(typeof body?.themeId === 'string' ? { themeId: body.themeId } : {}),
          ...(brand !== undefined ? { brand } : {}),
        });
        sendJson(res, 200, result);
        return;
      } catch (error) {
        sendJson(res, 500, { error: publicMessage(error, 'render failed', url.pathname) });
        return;
      }
    }

    const method = (req.method ?? 'GET').toUpperCase();
    if (!KNOWN_METHODS.has(method as HttpMethod)) {
      res.writeHead(405, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: 'method not supported' }));
      return;
    }

    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      query[key] = value;
    }

    const restRequest: RestRequest = {
      method: method as HttpMethod,
      // NOT pre-decoded: the router decodes each path segment itself, and
      // pre-decoding here would let %2F smuggle slashes into route segments
      // (and double-decode legitimate encoded params).
      path: url.pathname,
      headers: normalizeHeaders(req),
      query,
      body: await readBody(req, maxBodyBytes),
      ip: clientIp(req, trustProxy),
    };

    const result = await restApi.handle(restRequest);

    if (isSse(result)) {
      const sse = result as {
        status: number;
        headers: Record<string, string>;
        stream: AsyncIterable<{ event?: string; data: string; id?: string }>;
      };
      res.writeHead(sse.status, { ...sse.headers, ...cors });
      try {
        for await (const event of sse.stream) {
          let frame = '';
          if (event.id !== undefined) {
            frame += `id: ${event.id}\n`;
          }
          if (event.event !== undefined) {
            frame += `event: ${event.event}\n`;
          }
          frame += `data: ${event.data}\n\n`;
          res.write(frame);
        }
      } finally {
        res.end();
      }
      return;
    }

    const buffered = result as { status: number; headers: Record<string, string>; body: unknown };
    res.writeHead(buffered.status, { ...buffered.headers, ...cors });
    res.end(typeof buffered.body === 'string' ? buffered.body : JSON.stringify(buffered.body));
  }

  // Wire the realtime audio WebSocket proxy (browser ⇄ server ⇄ Azure) when
  // realtime is configured. The browser connects to REALTIME_WS_PATH; the proxy
  // bridges to Azure with the api-key header the browser cannot set itself.
  if (realtimeConfig !== null) {
    const proxy = createRealtimeProxy({ config: realtimeConfig, path: REALTIME_WS_PATH });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== REALTIME_WS_PATH) {
        socket.destroy();
        return;
      }
      // The proxy spends the operator's Azure quota — require a valid
      // single-use ticket minted by the authenticated /v1/realtime/ticket
      // route. WebSockets are not subject to CORS, so without this ANY page
      // could open the bridge.
      if (!consumeRealtimeTicket(url.searchParams.get('ticket'))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      proxy.handleUpgrade(req, socket, head);
    });
  }

  server.listen(port, host);
  return server;
}
