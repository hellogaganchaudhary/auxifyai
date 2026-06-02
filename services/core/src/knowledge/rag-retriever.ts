/**
 * RAG_Retriever (Req 24.1-24.7).
 *
 * The RAG_Retriever answers a user's question with knowledge grounded in the
 * `knowledge_chunk` records the
 * {@link import('./knowledge-ingestion-service.js').KnowledgeIngestionService}
 * indexed in the shared {@link VectorStore}. {@link RagRetriever.retrieve}:
 *
 *   1. embeds the query through the injectable {@link Embedder} and queries the
 *      organization-scoped {@link VectorStore} for `knowledge_chunk` neighbours,
 *      then combines each neighbour's vector similarity with a keyword-overlap
 *      score into a hybrid relevance score (Req 24.1);
 *   2. excludes any candidate that lacks complete source attribution (Req 24.6)
 *      and any chunk the requesting {@link Principal} is not authorized to
 *      access through the injectable {@link ChunkAuthorizer} (Req 24.3);
 *   3. re-ranks the survivors by non-increasing hybrid score and keeps the
 *      top-ranked chunks up to the configured limit (Req 24.2), attaching the
 *      complete {@link import('@auxify/types').SourceAttribution} to each
 *      (Req 24.4);
 *   4. if no surviving chunk meets the relevance threshold, returns no context
 *      and the explicit "no relevant knowledge found" signal (Req 24.7).
 *
 * The query embedder, the Vector_Store, and the chunk authorizer are injected
 * ports, so the retriever is pure ranking orchestration and fully unit-testable
 * with the in-memory fakes in `./fakes.js`. Tenant isolation (Req 1.2) is
 * enforced first by the organization-scoped Vector_Store query — a query can
 * never return another Organization's chunks — and the {@link ChunkAuthorizer}
 * adds the finer-grained collection/source access on top (Req 24.3, 25.2).
 */

import type { Principal } from '@auxify/types';

import type { Embedder } from '../file-processor/index.js';
import type { VectorMatch, VectorStore } from '../storage/index.js';

import { hasCompleteAttribution, hybridScore, keywordScore } from './rag-ranking.js';
import {
  DEFAULT_CANDIDATE_LIMIT,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_TOP_K,
  DEFAULT_VECTOR_WEIGHT,
  NO_RELEVANT_KNOWLEDGE_MESSAGE,
  type ChunkAuthorizer,
  type RetrievableChunk,
  type RetrievedChunk,
  type RetrievedContext,
  type RetrieveOptions,
} from './rag-types.js';

/**
 * Construction-time dependencies for the {@link RagRetriever}.
 *
 * The {@link embedder}, {@link vectorStore}, and {@link authorizer} are required
 * ports; the weights, top-K, threshold, and candidate limit have defaults.
 * Requiring the ports keeps the retriever honest — it never silently skips
 * embedding, the organization-scoped read, or the authorization filter — while
 * letting tests inject fakes.
 */
export interface RagRetrieverOptions {
  /** Embeds the query into a vector (Req 24.1); reused from the File_Processor. */
  embedder: Embedder;
  /** The organization-scoped vector index of `knowledge_chunk` records (Req 24.1). */
  vectorStore: VectorStore;
  /** Decides whether the requesting principal may see each candidate chunk (Req 24.3). */
  authorizer: ChunkAuthorizer;
  /** The default top-K limit when a call omits it (defaults to {@link DEFAULT_TOP_K}). */
  defaultTopK?: number;
  /** The default relevance threshold when a call omits it (defaults to {@link DEFAULT_RELEVANCE_THRESHOLD}). */
  defaultRelevanceThreshold?: number;
  /** The default candidate pool size (defaults to {@link DEFAULT_CANDIDATE_LIMIT}). */
  defaultCandidateLimit?: number;
  /** The weight applied to the vector-similarity score (defaults to {@link DEFAULT_VECTOR_WEIGHT}). */
  vectorWeight?: number;
  /** The weight applied to the keyword-overlap score (defaults to {@link DEFAULT_KEYWORD_WEIGHT}). */
  keywordWeight?: number;
}

/**
 * The concrete RAG_Retriever. Construct it with the query embedder, the
 * organization-scoped Vector_Store, and the chunk authorizer;
 * {@link RagRetriever.retrieve} returns the top-ranked, authorized,
 * fully-attributed chunks for a query, or an explicit "no relevant knowledge
 * found" result when nothing meets the threshold.
 */
export class RagRetriever {
  private readonly embedder: Embedder;
  private readonly vectors: VectorStore;
  private readonly authorizer: ChunkAuthorizer;
  private readonly defaultTopK: number;
  private readonly defaultThreshold: number;
  private readonly defaultCandidateLimit: number;
  private readonly vectorWeight: number;
  private readonly keywordWeight: number;

  constructor(options: RagRetrieverOptions) {
    this.embedder = options.embedder;
    this.vectors = options.vectorStore;
    this.authorizer = options.authorizer;
    this.defaultTopK = options.defaultTopK ?? DEFAULT_TOP_K;
    this.defaultThreshold = options.defaultRelevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
    this.defaultCandidateLimit = options.defaultCandidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
    this.vectorWeight = options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
    this.keywordWeight = options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT;
  }

  /**
   * Retrieve the knowledge most relevant to `query` for `principal` (Req 24.1-24.7).
   *
   * Embeds the query and runs hybrid (vector + keyword) retrieval over the
   * principal's Organization (Req 24.1, 1.2), excludes chunks lacking complete
   * attribution (Req 24.6) and chunks the principal cannot access (Req 24.3),
   * re-ranks the survivors and keeps the top-K (Req 24.2) with complete
   * attribution attached (Req 24.4). If no surviving chunk meets the relevance
   * threshold, returns no context plus the explicit no-knowledge signal
   * (Req 24.7).
   *
   * @param query The user's natural-language question.
   * @param principal The authenticated actor; scopes the search to their
   *   Organization (Req 1.2) and gates each chunk by their access (Req 24.3).
   * @param opts Optional per-query top-K, threshold, and candidate-pool tuning.
   * @returns The ranked, attributed {@link RetrievedContext}, or an explicit
   *   not-found result (Req 24.7).
   */
  async retrieve(
    query: string,
    principal: Principal,
    opts: RetrieveOptions = {},
  ): Promise<RetrievedContext> {
    const topK = Math.max(0, opts.topK ?? this.defaultTopK);
    const threshold = opts.minRelevanceScore ?? this.defaultThreshold;
    const candidateLimit = Math.max(topK, opts.candidateLimit ?? this.defaultCandidateLimit);

    // (Req 24.1) Embed the query. The Embedder returns one vector per input.
    const [queryEmbedding] = await this.embedder.embed([query]);
    if (queryEmbedding === undefined) {
      return notFound();
    }

    // (Req 24.1 / Req 1.2) Vector neighbours, scoped to the principal's
    // Organization so a query can never cross a tenant boundary.
    const matches = await this.vectors.query(
      queryEmbedding,
      { organizationId: principal.organizationId, ownerType: 'knowledge_chunk' },
      candidateLimit,
    );

    // (Req 24.1, 24.6) Build candidates, dropping any chunk that lacks complete
    // source attribution before it can ever be considered for the context.
    const scored: RetrievedChunk[] = [];
    const authorizationChecks: Promise<{ chunk: RetrievedChunk; allowed: boolean }>[] = [];
    for (const match of matches) {
      const chunk = toRetrievableChunk(match, principal.organizationId);
      if (chunk === null || !hasCompleteAttribution(chunk.attribution)) {
        continue;
      }
      const vectorScore = match.score;
      const kwScore = keywordScore(query, chunk.text);
      const score = hybridScore(vectorScore, kwScore, this.vectorWeight, this.keywordWeight);
      const retrieved: RetrievedChunk = {
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        sourceId: chunk.sourceId,
        ordinal: chunk.ordinal,
        text: chunk.text,
        score,
        vectorScore,
        keywordScore: kwScore,
        attribution: chunk.attribution,
      };
      // (Req 24.3) Authorize the chunk for the requesting principal.
      authorizationChecks.push(
        Promise.resolve(this.authorizer.authorize(principal, chunk)).then((allowed) => ({
          chunk: retrieved,
          allowed,
        })),
      );
    }

    for (const { chunk, allowed } of await Promise.all(authorizationChecks)) {
      if (allowed) {
        scored.push(chunk);
      }
    }

    // (Req 24.7) Drop chunks below the relevance threshold; if none remain the
    // query found no relevant knowledge.
    const relevant = scored.filter((chunk) => chunk.score >= threshold);
    if (relevant.length === 0) {
      return notFound();
    }

    // (Req 24.2) Re-rank by non-increasing score and keep the top-K. The tie
    // break on chunk id keeps ordering deterministic across equal scores.
    relevant.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
    const chunks = relevant.slice(0, topK);

    return { found: true, chunks };
  }
}

/**
 * Project a {@link VectorMatch} into a {@link RetrievableChunk}, or `null` when
 * the record's metadata is not a well-formed `knowledge_chunk` payload.
 *
 * The Knowledge_Ingestion_Service writes `sourceId`, `documentId`, `ordinal`,
 * `text`, and `attribution` into each `knowledge_chunk` record's metadata; this
 * reads them back defensively so a malformed or foreign record is skipped
 * rather than surfaced. The owning Organization is supplied by the caller (the
 * Vector_Store query already scoped the read to it, Req 1.2).
 */
function toRetrievableChunk(match: VectorMatch, organizationId: string): RetrievableChunk | null {
  const metadata = match.metadata;
  const sourceId = metadata['sourceId'];
  const documentId = metadata['documentId'];
  const ordinal = metadata['ordinal'];
  const text = metadata['text'];
  const attribution = metadata['attribution'];

  if (
    typeof sourceId !== 'string' ||
    typeof documentId !== 'string' ||
    typeof ordinal !== 'number' ||
    typeof text !== 'string' ||
    typeof attribution !== 'object' ||
    attribution === null
  ) {
    return null;
  }

  const attr = attribution as Record<string, unknown>;
  return {
    chunkId: match.id,
    organizationId,
    sourceId,
    documentId,
    ordinal,
    text,
    attribution: {
      sourceId: typeof attr['sourceId'] === 'string' ? (attr['sourceId'] as string) : '',
      sourceTitle:
        typeof attr['sourceTitle'] === 'string' ? (attr['sourceTitle'] as string) : '',
      location: typeof attr['location'] === 'string' ? (attr['location'] as string) : '',
      link: typeof attr['link'] === 'string' ? (attr['link'] as string) : '',
    },
  };
}

/** The canonical "no relevant knowledge found" result (Req 24.7). */
function notFound(): RetrievedContext {
  return { found: false, chunks: [], message: NO_RELEVANT_KNOWLEDGE_MESSAGE };
}
