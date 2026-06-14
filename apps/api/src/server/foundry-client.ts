/**
 * Azure AI Foundry model-inference client for partner / MaaS chat models.
 *
 * Foundry's `/models` endpoint is OpenAI-compatible: the deployment/model name
 * is sent as `model` in the JSON body, and streaming responses use SSE frames.
 * The core AzureProvider already owns chat request shaping and stream mapping,
 * so this adapter only maps that port onto Foundry's URL shape.
 */

import type {
  AzureClientPort,
  AzureRequestInput,
  AzureResponseResult,
  AzureStreamEvent,
} from '@auxify/core';

/** Construction options for the {@link HttpFoundryClient}. */
export interface HttpFoundryClientOptions {
  /** The Foundry inference endpoint, usually `https://...services.ai.azure.com/models`. */
  endpoint: string;
  /** The Azure AI Foundry API key. */
  apiKey: string;
}

/** Calls Azure AI Foundry model inference over HTTPS. */
export class HttpFoundryClient implements AzureClientPort {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(options: HttpFoundryClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  /** Send a non-streaming request to Foundry. */
  async send(input: AzureRequestInput): Promise<AzureResponseResult> {
    if (input.operation !== 'chat/completions') {
      throw new Error(`Azure Foundry does not support ${input.operation} through this adapter`);
    }
    const response = await fetch(this.url(input.apiVersion, 'chat/completions'), {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json' },
      body: this.bodyWithModel(input),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Azure Foundry chat failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return { body: text };
  }

  /** Send a streaming chat request and yield decoded SSE chunks as they arrive. */
  async *sendStream(input: AzureRequestInput): AsyncIterable<AzureStreamEvent> {
    if (input.operation !== 'chat/completions') {
      throw new Error(`Azure Foundry does not support ${input.operation} through this adapter`);
    }
    const response = await fetch(this.url(input.apiVersion, 'chat/completions'), {
      method: 'POST',
      headers: {
        'api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: this.bodyWithModel(input),
    });
    if (!response.ok || response.body === null) {
      const text = response.body === null ? '' : await response.text();
      throw new Error(`Azure Foundry chat stream failed (${response.status}): ${text.slice(0, 500)}`);
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
              // Ignore malformed/partial JSON frames.
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Foundry realtime sessions are not exposed through this chat adapter. */
  async openRealtime(input: { deployment: string }): Promise<{ sessionId: string; close(): Promise<void> }> {
    return {
      sessionId: `foundry-rt-unavailable-${input.deployment}-${Date.now()}`,
      close: async () => {
        /* no realtime transport opened */
      },
    };
  }

  /** Lightweight reachability probe for the configured endpoint. */
  async healthProbe(apiVersion: string): Promise<void> {
    const response = await fetch(`${this.endpoint}?api-version=${encodeURIComponent(apiVersion)}`, {
      headers: { 'api-key': this.apiKey },
    });
    if (!response.ok) {
      throw new Error(`Azure Foundry health probe failed (${response.status})`);
    }
  }

  private url(apiVersion: string, operation: string): string {
    return `${this.endpoint}/${operation}?api-version=${encodeURIComponent(apiVersion)}`;
  }

  private bodyWithModel(input: AzureRequestInput): string {
    const parsed = JSON.parse(input.body) as unknown;
    const body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
    return JSON.stringify({ ...body, model: input.deployment });
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