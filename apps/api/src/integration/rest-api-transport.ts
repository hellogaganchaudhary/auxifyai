/**
 * In-memory transport bridge wiring the Client_SDK onto the REAL REST_API
 * (Req 45.2, 45.3, 45.7).
 *
 * {@link RestApiTransport} implements the SDK's narrow {@link HttpTransport} port
 * by adapting each {@link TransportRequest} onto {@link RestApi.handle} with NO
 * network or sockets: it parses the SDK's serialized request into a normalized
 * {@link RestRequest} (path + query extracted from the URL, headers passed
 * through, JSON body parsed, originating IP stamped for the per-IP rate limiter),
 * calls the dispatcher, and converts the buffered {@link RestResponse} back into
 * a {@link TransportResponse} the SDK decodes. For a streaming call it relays the
 * dispatcher's {@link SseResponse} stream, yielding each {@link SseEvent} as a
 * {@link TransportFrame} so the SDK's `streamChat`/`runAgent` see the same SSE
 * frames they would over the wire (Req 45.3).
 *
 * This lets the integration tests drive the production SDK against the
 * production REST_API end to end, in process.
 */

import type { HttpTransport, TransportFrame, TransportRequest, TransportResponse } from '@auxify/sdk';

import type { RestApi } from '../rest/rest-api';
import type { HttpMethod, RestRequest, RestResponse, SseResponse } from '../rest/types';

/** Options controlling how the bridge stamps requests onto the REST_API. */
export interface RestApiTransportOptions {
  /**
   * The originating client IP stamped onto every {@link RestRequest} so the
   * REST_API's per-IP rate limiter meters the SDK's calls (Req 45.7). A single
   * stable IP makes a burst of SDK calls share one rate-limit counter.
   */
  ip?: string;
}

/** The default originating IP stamped onto bridged requests. */
const DEFAULT_CLIENT_IP = '203.0.113.7';

/**
 * The in-memory {@link HttpTransport} that bridges the SDK onto {@link RestApi}.
 *
 * Construct it with the REST_API instance the SDK should drive, then inject it
 * via `new AuxifyClient({ baseUrl, token, transport })`.
 */
export class RestApiTransport implements HttpTransport {
  private readonly restApi: RestApi;
  private readonly ip: string;

  constructor(restApi: RestApi, options: RestApiTransportOptions = {}) {
    this.restApi = restApi;
    this.ip = options.ip ?? DEFAULT_CLIENT_IP;
  }

  /**
   * Perform a buffered request: adapt the SDK request onto {@link RestApi.handle}
   * and convert the buffered {@link RestResponse} back into a
   * {@link TransportResponse} (`status`, lower-cased headers, JSON-string body).
   *
   * @param req The SDK's normalized request.
   * @returns The buffered response for the SDK to decode.
   */
  async request(req: TransportRequest): Promise<TransportResponse> {
    const response = await this.restApi.handle(this.toRestRequest(req));
    if (isSse(response)) {
      // A non-streaming call should never resolve to an SSE response; drain and
      // surface it as an empty buffered body so the SDK can still decode a value.
      return { status: response.status, headers: lowerCaseHeaders(response.headers), body: '' };
    }
    return {
      status: response.status,
      headers: lowerCaseHeaders(response.headers),
      body: JSON.stringify(response.body),
    };
  }

  /**
   * Perform a streaming (SSE) request: call {@link RestApi.handle} and, when it
   * returns an {@link SseResponse}, relay each {@link SseEvent} as a
   * {@link TransportFrame} so the SDK sees the same frames it would on the wire
   * (Req 45.3). A buffered response (e.g. an auth/rate-limit rejection) is
   * surfaced as a single terminal `error` frame carrying the JSON body.
   *
   * @param req The SDK's normalized streaming request.
   */
  async *stream(req: TransportRequest): AsyncIterable<TransportFrame> {
    const response = await this.restApi.handle(this.toRestRequest(req));
    if (!isSse(response)) {
      // The request was rejected before streaming (401/404/429/...). Relay the
      // PlatformError body as a terminal `error` frame the SDK decodes.
      yield { event: 'error', data: JSON.stringify(response.body) };
      return;
    }
    for await (const event of response.stream) {
      const frame: TransportFrame = { data: event.data };
      if (event.event !== undefined) {
        frame.event = event.event;
      }
      if (event.id !== undefined) {
        frame.id = event.id;
      }
      yield frame;
    }
  }

  /** Parse a serialized SDK request into a normalized {@link RestRequest}. */
  private toRestRequest(req: TransportRequest): RestRequest {
    const url = new URL(req.url);
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      query[key] = value;
    }
    const rest: RestRequest = {
      method: req.method as HttpMethod,
      path: url.pathname,
      headers: { ...req.headers },
      query,
      ip: this.ip,
    };
    if (req.body !== undefined) {
      rest.body = parseJsonBody(req.body);
    }
    return rest;
  }
}

/** Whether a dispatcher response is the streaming (SSE) variant. */
function isSse(response: RestResponse | SseResponse): response is SseResponse {
  return 'stream' in response;
}

/** Lower-case every header key so the SDK can read `x-correlation-id` uniformly. */
function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    record[key.toLowerCase()] = value;
  }
  return record;
}

/** Parse a serialized JSON body string into a value, tolerating an empty/invalid body. */
function parseJsonBody(body: string): unknown {
  if (body.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
