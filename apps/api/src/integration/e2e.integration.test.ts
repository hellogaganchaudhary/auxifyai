/**
 * End-to-end integration tests at the PUBLIC-API layer for the two wired flows
 * (Req 4.1, 29.1).
 *
 * These prove the two flows tasks 27.1 and 27.2 wired are reachable through the
 * REST_API / SDK boundary: the production {@link AuxifyClient} drives the
 * production {@link RestApi} over the in-memory {@link RestApiTransport} bridge
 * (no network, no sockets), exactly as a third-party consumer would.
 *
 *   1. STREAMING-CHAT path (Req 4.1): `streamChat` over the bridge yields token
 *      {@link ChatEvent}s ending in a `completion` carrying model + usage,
 *      relayed by the real {@link StreamingEngine} from the chat stream port.
 *      (The deep streaming-with-RAG composition is covered in the services/core
 *      e2e suite; here we assert the public boundary relays it.)
 *   2. UNIFIED-SEARCH path (Req 29.1): `unifiedSearch(query)` over the bridge
 *      returns grouped results from a `unified-search` controller wired to a
 *      REAL {@link createUnifiedSearchService} over a pre-seeded shared
 *      `knowledge_chunk` index holding content from each native module, mapped
 *      into the SDK {@link GroupedResults} shape. (The deep cross-module
 *      ingestion assertion lives in the services/core e2e suite.)
 */

import {
  EMBEDDING_DIMENSIONS,
  InMemoryVectorStore,
  StreamingEngine,
  createUnifiedSearchService,
  type Embedder,
  type UnifiedSearchService,
  type VectorRecord,
} from '@auxify/core';
import { AuxifyClient } from '@auxify/sdk';
import type { GroupedResults } from '@auxify/sdk';
import { describe, expect, it } from 'vitest';

import { RestAuthenticator } from '../rest/authentication';
import { RestApi } from '../rest/rest-api';
import { createRouter } from '../rest/router';
import {
  makeMaskedKey,
  makeSessionIdentity,
  StubApiKeyAuthenticator,
  StubChatStreamPort,
  StubJwtAuthenticator,
} from '../rest/rest-api.fixtures';
import type { ResourceController, RestServices, RouteHandlerContext } from '../rest/types';
import { RestApiTransport } from './rest-api-transport';

const BASE_URL = 'https://api.auxify.test';
const VALID_TOKEN = 'valid-jwt-token';
const VALID_API_KEY = 'sk_test_valid';

/** The Organization the seeded content and the authenticated principal both belong to. */
const ORG = 'org-1';

/** A search term carried by content from every native module in the seeded index. */
const TERM = 'quarterly';

/**
 * A constant {@link Embedder} for the public-API test: every text embeds to the
 * same fixed-dimension vector, so the in-memory Vector_Store returns every
 * org-scoped `knowledge_chunk` for any query (the unified-search wiring then
 * groups them by content type). The deep relevance behaviour is covered by the
 * services/core suite; here we only need the records to be reachable.
 */
class ConstantEmbedder implements Embedder {
  // eslint-disable-next-line @typescript-eslint/require-await -- deterministic in-memory embedder
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array<number>(EMBEDDING_DIMENSIONS).fill(0.5));
  }
}

/**
 * Build a `knowledge_chunk` {@link VectorRecord} whose attribution link scheme
 * routes it to a native-module content type in unified search (the default
 * classifier keys on the link prefix: `knowledge-hub://`, `messaging://`,
 * `document-management://`).
 */
function makeChunk(options: {
  id: string;
  title: string;
  text: string;
  link: string;
}): VectorRecord {
  return {
    id: options.id,
    organizationId: ORG,
    ownerType: 'knowledge_chunk',
    ownerId: options.id,
    embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(0.5),
    metadata: {
      sourceId: `src-${options.id}`,
      documentId: `doc-${options.id}`,
      ordinal: 0,
      text: options.text,
      attribution: {
        sourceId: `src-${options.id}`,
        sourceTitle: options.title,
        location: 'page 1',
        link: options.link,
      },
    },
  };
}

/** Seed a shared `knowledge_chunk` index with content from each native module. */
async function makeSeededSearchService(): Promise<UnifiedSearchService> {
  const vectorStore = new InMemoryVectorStore();
  await vectorStore.upsert([
    makeChunk({
      id: 'page-1',
      title: 'Quarterly Plan',
      text: `${TERM} planning roadmap for the platform team`,
      link: 'knowledge-hub://pages/page-1',
    }),
    makeChunk({
      id: 'message-1',
      title: 'Message in channel chan-1',
      text: `${TERM} planning sync notes and action items`,
      link: 'messaging://channels/chan-1/messages/message-1',
    }),
    makeChunk({
      id: 'document-1',
      title: 'plan.txt',
      text: `${TERM} planning report contents for review`,
      link: 'document-management://documents/document-1',
    }),
  ]);
  return createUnifiedSearchService({ embedder: new ConstantEmbedder(), vectorStore });
}

/**
 * A `unified-search` controller whose `search` op calls the REAL
 * {@link UnifiedSearchService} with the authenticated principal and maps the
 * grouped {@link import('@auxify/core').UnifiedSearchResult} into the SDK
 * {@link GroupedResults} shape the client decodes.
 */
function unifiedSearchController(service: UnifiedSearchService): ResourceController {
  return {
    search: async (ctx: RouteHandlerContext) => {
      const principal = ctx.auth?.principal;
      if (principal === undefined) {
        return {
          ok: false as const,
          error: {
            category: 'authentication' as const,
            code: 'NO_PRINCIPAL',
            message: 'a principal is required',
            correlationId: ctx.correlationId,
            retriable: false,
          },
        };
      }
      const body = ctx.request.body as { query?: unknown } | undefined;
      const query = typeof body?.query === 'string' ? body.query : '';
      const result = await service.search(query, principal);
      const grouped: GroupedResults = {
        groups: result.groups.map((group) => ({
          source: group.type,
          results: group.items.map((item) => ({
            title: item.title,
            url: item.location.url,
            snippet: item.snippet,
            score: item.score,
          })),
        })),
      };
      return { ok: true as const, value: { body: grouped } };
    },
  };
}

/** Build a REST_API wiring the real unified-search controller + the stub chat stream port. */
function makeRestApi(service: UnifiedSearchService): RestApi {
  const services: RestServices = {
    controllers: { 'unified-search': unifiedSearchController(service) },
    chatStream: new StubChatStreamPort(['Hello', ', ', 'world']),
  };
  return new RestApi({
    router: createRouter(services),
    authenticator: new RestAuthenticator({
      jwt: new StubJwtAuthenticator(VALID_TOKEN, makeSessionIdentity({ organizationId: ORG })),
      apiKey: new StubApiKeyAuthenticator(VALID_API_KEY, makeMaskedKey({ organizationId: ORG })),
    }),
    services,
    streaming: new StreamingEngine({ persister: { persist: () => undefined } }),
  });
}

/** Build an {@link AuxifyClient} wired to a REST_API through the in-memory bridge. */
function makeClient(restApi: RestApi): AuxifyClient {
  return new AuxifyClient({
    baseUrl: BASE_URL,
    token: VALID_TOKEN,
    transport: new RestApiTransport(restApi),
  });
}

describe('Public API e2e — streaming-chat path reachable through REST_API/SDK (Req 4.1)', () => {
  it('streamChat over the bridge yields token events ending in a completion carrying model + usage', async () => {
    const restApi = makeRestApi(await makeSeededSearchService());
    const client = makeClient(restApi);

    const events = [];
    for await (const event of client.streamChat({ modelId: 'gpt-test', prompt: 'hi' })) {
      events.push(event);
    }

    // (Req 4.1) Token deltas arrived in order before the completion.
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.map((t) => (t.type === 'token' ? t.delta : ''))).toEqual(['Hello', ', ', 'world']);

    const last = events.at(-1);
    expect(last?.type).toBe('completion');
    if (last?.type === 'completion') {
      expect(last.model).toBe('gpt-test');
      expect(last.usage).toEqual({ inputTokens: 3, outputTokens: 3 });
    }
  });
});

describe('Public API e2e — unified-search path reachable through REST_API/SDK (Req 29.1)', () => {
  it('unifiedSearch over the bridge returns grouped results from a controller backed by the real UnifiedSearchService', async () => {
    const restApi = makeRestApi(await makeSeededSearchService());
    const client = makeClient(restApi);

    const grouped = await client.unifiedSearch(TERM);

    // (Req 29.1) The SDK round-trips grouped results sourced from every native
    // module's content type, mapped from the real service's grouped result.
    const sources = new Set(grouped.groups.map((g) => g.source));
    expect(sources.has('knowledge_page')).toBe(true);
    expect(sources.has('message')).toBe(true);
    expect(sources.has('document')).toBe(true);

    // Each group carries decoded SDK results with a resolvable deep-link URL.
    for (const group of grouped.groups) {
      expect(group.results.length).toBeGreaterThan(0);
      for (const result of group.results) {
        expect(result.title.length).toBeGreaterThan(0);
        expect(result.url.length).toBeGreaterThan(0);
      }
    }

    // The knowledge page and document surface under their own content types.
    const pageGroup = grouped.groups.find((g) => g.source === 'knowledge_page');
    expect(pageGroup?.results.some((r) => r.title === 'Quarterly Plan')).toBe(true);
    const documentGroup = grouped.groups.find((g) => g.source === 'document');
    expect(documentGroup?.results.some((r) => r.title === 'plan.txt')).toBe(true);
  });
});
