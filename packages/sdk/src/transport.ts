/**
 * The Client_SDK wire transport (Req 45.6).
 *
 * The SDK is transport-agnostic: it depends on the narrow {@link HttpTransport}
 * port (defined in `./types`) rather than any concrete HTTP client, so it has no
 * hard dependency on `fetch`/`undici`/`axios` and stays trivially testable with
 * an injected fake.
 *
 * This module provides:
 *   - {@link parseSseChunk} — a pure server-sent-events line parser that turns a
 *     decoded text chunk into complete {@link TransportFrame}s plus a remainder
 *     to carry into the next chunk. It is exported so it can be unit-tested in
 *     isolation.
 *   - {@link FetchHttpTransport} — the default transport, implemented over the
 *     global `fetch` (available in Node 22 and modern browsers). It is used only
 *     when the consumer does not inject their own transport.
 */

import type { HttpTransport, TransportFrame, TransportRequest, TransportResponse } from './types';

/** The result of feeding one text chunk to the SSE parser. */
export interface SseParseResult {
  /** The complete frames decoded from the chunk (plus any buffered remainder). */
  frames: TransportFrame[];
  /** The trailing partial-event text to prepend to the next chunk. */
  remainder: string;
}

/**
 * Parse a chunk of server-sent-events text into complete {@link TransportFrame}s.
 *
 * SSE events are separated by a blank line; within an event, `event:`, `data:`,
 * and `id:` fields are collected (multiple `data:` lines are joined with `\n`,
 * per the SSE spec) and lines beginning with `:` are comments that are ignored.
 * Because a network chunk may split an event mid-way, the parser returns the
 * trailing unterminated text as {@link SseParseResult.remainder} so the caller
 * can prepend it to the following chunk.
 *
 * @param chunk The newly decoded text (already concatenated with any prior remainder).
 * @returns The complete frames and the unterminated remainder.
 */
export function parseSseChunk(chunk: string): SseParseResult {
  const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lastBoundary = normalized.lastIndexOf('\n\n');
  if (lastBoundary === -1) {
    return { frames: [], remainder: normalized };
  }

  const complete = normalized.slice(0, lastBoundary);
  const remainder = normalized.slice(lastBoundary + 2);
  const frames: TransportFrame[] = [];

  for (const rawEvent of complete.split('\n\n')) {
    const frame = parseSseEvent(rawEvent);
    if (frame !== null) {
      frames.push(frame);
    }
  }

  return { frames, remainder };
}

/** Parse a single SSE event block (its lines) into a frame, or `null` when empty. */
function parseSseEvent(rawEvent: string): TransportFrame | null {
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of rawEvent.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is stripped, per the SSE spec.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'id') {
      id = value;
    }
  }

  if (event === undefined && id === undefined && dataLines.length === 0) {
    return null;
  }

  const frame: TransportFrame = { data: dataLines.join('\n') };
  if (event !== undefined) {
    frame.event = event;
  }
  if (id !== undefined) {
    frame.id = id;
  }
  return frame;
}

/**
 * The default {@link HttpTransport}, implemented over the global `fetch`.
 *
 * Node 22 and modern browsers expose `fetch`, `ReadableStream`, and
 * `TextDecoder` globally, so this transport needs no dependency. It is used only
 * when the consumer does not inject their own transport; tests always inject a
 * fake instead, so this class is never exercised against the network in CI.
 */
export class FetchHttpTransport implements HttpTransport {
  private readonly fetchImpl: typeof fetch;

  /**
   * @param fetchImpl An optional `fetch` override; defaults to the global
   *   `fetch`. Supplying it keeps the transport itself injectable (e.g. for a
   *   custom-agent or a polyfill) without reaching for a global.
   *
   * NOTE: the browser `fetch` is a method of `window` and throws an "Illegal
   * invocation" `TypeError` when called as a method of any other object (e.g.
   * `this.fetchImpl(...)`). We therefore bind the global `fetch` to its global
   * `this` so it can be safely invoked through this instance property. An
   * explicitly injected `fetchImpl` is used as-is (callers bind their own).
   */
  constructor(fetchImpl?: typeof fetch) {
    if (fetchImpl !== undefined) {
      if (typeof fetchImpl !== 'function') {
        throw new Error(
          'FetchHttpTransport requires a global fetch or an injected fetch implementation',
        );
      }
      this.fetchImpl = fetchImpl;
      return;
    }
    if (typeof globalThis.fetch !== 'function') {
      throw new Error(
        'FetchHttpTransport requires a global fetch or an injected fetch implementation',
      );
    }
    // Bind to the global so the browser's `fetch` keeps its required `this`.
    this.fetchImpl = globalThis.fetch.bind(globalThis);
  }

  /** Perform a buffered request and read the full response body as text. */
  async request(req: TransportRequest): Promise<TransportResponse> {
    const response = await this.fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    const body = await response.text();
    return {
      status: response.status,
      headers: headersToRecord(response.headers),
      body,
    };
  }

  /** Perform a streaming (SSE) request, decoding the byte stream into frames. */
  async *stream(req: TransportRequest): AsyncIterable<TransportFrame> {
    const response = await this.fetchImpl(req.url, {
      method: req.method,
      headers: { accept: 'text/event-stream', ...req.headers },
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    const body = response.body;
    if (body === null) {
      return;
    }

    const decoder = new TextDecoder();
    let remainder = '';
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        remainder += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(remainder);
        remainder = parsed.remainder;
        for (const frame of parsed.frames) {
          yield frame;
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Flush any final, newline-terminated remainder once the stream closes.
    const tail = parseSseChunk(remainder.endsWith('\n\n') ? remainder : `${remainder}\n\n`);
    for (const frame of tail.frames) {
      yield frame;
    }
  }
}

/** Convert a `fetch` {@link Headers} into a plain record with lower-cased keys. */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}
