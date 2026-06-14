/**
 * A concrete {@link AzureClientPort} over the Azure OpenAI / Azure AI Foundry
 * REST API.
 *
 * The {@link AzureProvider} in `@auxify/core` owns all request shaping and
 * response mapping; this adapter is the single boundary that performs the
 * network call, building the
 * `/openai/deployments/{deployment}/{operation}?api-version=...` URL and
 * decoding the SSE `data:` lines the streaming Chat Completions API emits.
 */

import type {
  AzureClientPort,
  AzureRequestInput,
  AzureResponseResult,
  AzureStreamEvent,
} from '@auxify/core';

/** Construction options for the {@link HttpAzureClient}. */
export interface HttpAzureClientOptions {
  /** The Azure resource endpoint, e.g. `https://my-resource.openai.azure.com`. */
  endpoint: string;
  /** The Azure API key (sent as the `api-key` header). */
  apiKey: string;
}

/** Calls Azure OpenAI / Azure AI Foundry over HTTPS. */
export class HttpAzureClient implements AzureClientPort {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(options: HttpAzureClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  private url(input: Pick<AzureRequestInput, 'deployment' | 'operation' | 'apiVersion'>): string {
    return (
      `${this.endpoint}/openai/deployments/${encodeURIComponent(input.deployment)}` +
      `/${input.operation}?api-version=${encodeURIComponent(input.apiVersion)}`
    );
  }

  /** Send a non-streaming request to a deployment and return the response body. */
  async send(input: AzureRequestInput): Promise<AzureResponseResult> {
    const response = await fetch(this.url(input), {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json' },
      body: input.body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Azure ${input.operation} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return { body: text };
  }

  /** Send a streaming chat request and yield decoded SSE chunks as they arrive. */
  async *sendStream(input: AzureRequestInput): AsyncIterable<AzureStreamEvent> {
    const response = await fetch(this.url(input), {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: input.body,
    });
    if (!response.ok || response.body === null) {
      const text = response.body === null ? '' : await response.text();
      throw new Error(
        `Azure chat stream failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = extractData(rawEvent);
          if (data !== null && data !== '[DONE]') {
            try {
              yield JSON.parse(data) as AzureStreamEvent;
            } catch {
              // Ignore a malformed/partial JSON frame.
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Open a realtime session against a deployment (best-effort; not used by chat). */
  async openRealtime(input: {
    deployment: string;
    apiVersion: string;
  }): Promise<{ sessionId: string; close(): Promise<void> }> {
    return {
      sessionId: `azure-rt-${input.deployment}-${Date.now()}`,
      close: async () => {
        /* no persistent socket opened in this minimal adapter */
      },
    };
  }

  /** Lightweight reachability probe for the configured endpoint. */
  async healthProbe(_apiVersion: string): Promise<void> {
    await fetch(`${this.endpoint}/openai/models?api-version=${encodeURIComponent(_apiVersion)}`, {
      method: 'GET',
      headers: { 'api-key': this.apiKey },
    });
  }
}

/** Pull the joined `data:` payload out of one SSE event block. */
function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split('\n');
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      let value = line.slice(5);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      dataLines.push(value);
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}
