/**
 * A concrete {@link BedrockClientPort} over the AWS Bedrock Runtime HTTP API
 * using a Bedrock API key (bearer token, `AWS_BEARER_TOKEN_BEDROCK`).
 *
 * The {@link BedrockProvider} in `@auxify/core` owns all request shaping and
 * response mapping; this adapter is the single boundary that performs the
 * network call. For streaming it calls Bedrock's real
 * `invoke-with-response-stream` endpoint and decodes AWS's binary
 * `application/vnd.amazon.eventstream` framing, so the Anthropic Messages chunk
 * events (`message_start` → `content_block_delta`* → `message_delta`) are
 * surfaced as the model produces them — tokens reach the client immediately
 * instead of after the whole response is generated.
 */

import type {
  BedrockClientPort,
  BedrockInvokeModelInput,
  BedrockInvokeModelResult,
  BedrockStreamEvent,
} from '@auxify/core';

import { decodeEventStream } from './eventstream';

/** Construction options for the {@link HttpBedrockClient}. */
export interface HttpBedrockClientOptions {
  /** The Bedrock API key / bearer token. */
  token: string;
}

/** Build the Bedrock Runtime base URL for a region. */
function baseUrl(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * Calls AWS Bedrock Runtime with a Bedrock API key (bearer auth). Talks the
 * Anthropic Messages wire shape the {@link BedrockProvider} produces/expects.
 */
export class HttpBedrockClient implements BedrockClientPort {
  private readonly token: string;

  constructor(options: HttpBedrockClientOptions) {
    this.token = options.token;
  }

  /** Invoke a model and return the full (non-streamed) response body. */
  async invokeModel(input: BedrockInvokeModelInput): Promise<BedrockInvokeModelResult> {
    const url = `${baseUrl(input.region)}/model/${encodeURIComponent(input.modelId)}/invoke`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': input.contentType ?? 'application/json',
        accept: input.accept ?? 'application/json',
      },
      body: input.body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Bedrock invoke failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return { body: text };
  }

  /**
   * Stream a model invocation using Bedrock's real streaming endpoint, decoding
   * AWS's eventstream framing into the Anthropic Messages chunk events the
   * provider maps. Tokens are yielded as they arrive, so the client sees output
   * immediately rather than after the full response is generated.
   */
  async *invokeModelWithResponseStream(
    input: BedrockInvokeModelInput,
  ): AsyncIterable<BedrockStreamEvent> {
    const url = `${baseUrl(input.region)}/model/${encodeURIComponent(input.modelId)}/invoke-with-response-stream`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': input.contentType ?? 'application/json',
        accept: input.accept ?? 'application/vnd.amazon.eventstream',
      },
      body: input.body,
    });

    if (!response.ok || response.body === null) {
      const text = response.body === null ? '' : await response.text();
      throw new Error(`Bedrock stream failed (${response.status}): ${text.slice(0, 500)}`);
    }

    for await (const event of decodeEventStream(response.body)) {
      yield event as BedrockStreamEvent;
    }
  }

  /** Lightweight reachability probe — resolve the regional endpoint host. */
  async healthProbe(region: string): Promise<void> {
    // A HEAD to the runtime root returns 4xx (no model) but proves reachability
    // and that the credential header is accepted at the transport layer.
    await fetch(`${baseUrl(region)}/`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}` },
    });
  }
}
