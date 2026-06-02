/**
 * Domain types and injectable ports for the RAG_Retriever (Req 24.1-24.7).
 *
 * The RAG_Retriever answers a user's question with knowledge grounded in the
 * `knowledge_chunk` records the {@link import('./knowledge-ingestion-service.js').KnowledgeIngestionService}
 * indexed in the shared {@link import('../storage/index.js').VectorStore}. Given
 * a natural-language query it generates a query embedding and performs hybrid
 * retrieval — combining vector similarity with keyword search (Req 24.1) — then
 * re-ranks the candidates and keeps the top-ranked chunks up to a configured
 * limit (Req 24.2), excludes any chunk the requesting user is not authorized to
 * access (Req 24.3), attaches complete {@link SourceAttribution} to every
 * surviving chunk (Req 24.4), drops any chunk that lacks complete attribution
 * (Req 24.6), and — when no chunk meets the relevance threshold — returns no
 * context with an explicit "no relevant knowledge found" signal (Req 24.7).
 *
 * Every external capability the retriever cannot perform purely — embedding the
 * query and authorizing a chunk for a principal — is modelled here as a narrow
 * port, and the durable read goes through the shared
 * {@link import('../storage/index.js').VectorStore} interface. The query
 * embedder contract is deliberately reused from the File_Processor
 * ({@link import('../file-processor/index.js').Embedder}) so the platform embeds
 * queries and chunks with one pipeline. The retriever is therefore pure ranking
 * orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`, with no hard dependency on an embedding model, a database, or an
 * authorization service.
 */

import type { Principal, SourceAttribution } from '@auxify/types';

/** The default number of top-ranked chunks {@link RagRetriever.retrieve} returns (Req 24.2). */
export const DEFAULT_TOP_K = 5 as const;

/**
 * The default minimum hybrid relevance score (in `[0, 1]`) a chunk must reach to
 * be considered relevant; below it the query returns no context (Req 24.7).
 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.5 as const;

/** The default weight applied to the vector-similarity score in the hybrid score (Req 24.1). */
export const DEFAULT_VECTOR_WEIGHT = 0.5 as const;

/** The default weight applied to the keyword-overlap score in the hybrid score (Req 24.1). */
export const DEFAULT_KEYWORD_WEIGHT = 0.5 as const;

/**
 * The default number of nearest-neighbour candidates pulled from the
 * Vector_Store before re-ranking.
 *
 * The pool is intentionally larger than the top-K so the keyword component of
 * the hybrid score (Req 24.1) can promote a chunk whose pure vector rank was
 * lower, before the final top-K cut (Req 24.2).
 */
export const DEFAULT_CANDIDATE_LIMIT = 100 as const;

/** The explicit signal returned when no chunk meets the relevance threshold (Req 24.7). */
export const NO_RELEVANT_KNOWLEDGE_MESSAGE = 'No relevant knowledge found.' as const;

/**
 * A `knowledge_chunk` candidate considered for an authorization decision
 * (Req 24.3).
 *
 * Carries exactly the tenant-qualified facts the {@link ChunkAuthorizer} needs
 * to decide whether the requesting {@link Principal} may see the chunk — the
 * owning Organization (already enforced at the Vector_Store boundary, Req 1.2),
 * the originating source and document, and the chunk's complete
 * {@link SourceAttribution}.
 */
export interface RetrievableChunk {
  /** The chunk's stable id (also its Vector_Store record id). */
  chunkId: string;
  /** The Organization that owns the chunk (defense-in-depth for Req 1.2). */
  organizationId: string;
  /** The knowledge source the chunk was ingested from. */
  sourceId: string;
  /** The knowledge document the chunk belongs to. */
  documentId: string;
  /** The chunk's zero-based position within its document. */
  ordinal: number;
  /** The chunk text. */
  text: string;
  /** The chunk's complete source attribution (Req 24.4). */
  attribution: SourceAttribution;
}

/**
 * The port that decides whether a {@link Principal} may retrieve a given
 * {@link RetrievableChunk} (Req 24.3).
 *
 * The retriever excludes any chunk the authorizer rejects, so it never surfaces
 * knowledge outside the user's access — collections restricted to specific
 * teams/projects (Req 25.2), private sources, and so on. Modelling
 * authorization as a port keeps the retriever independent of the
 * Knowledge_Manager's access model and Access_Control, and lets tests inject a
 * deterministic decision. Tenant isolation (Req 1.2) is enforced separately and
 * earlier by the organization-scoped Vector_Store query; this port adds the
 * finer-grained collection/source access on top.
 */
export interface ChunkAuthorizer {
  /**
   * Decide whether `principal` may retrieve `chunk`.
   *
   * @param principal The authenticated actor issuing the query.
   * @param chunk The candidate chunk under consideration.
   * @returns `true` to keep the chunk, `false` to exclude it (Req 24.3).
   */
  authorize(principal: Principal, chunk: RetrievableChunk): boolean | Promise<boolean>;
}

/**
 * Per-query tuning for {@link RagRetriever.retrieve}.
 *
 * All fields are optional; omitted fields fall back to the retriever's
 * construction-time defaults. {@link topK} bounds the returned set (Req 24.2)
 * and {@link minRelevanceScore} is the threshold below which a query yields no
 * context (Req 24.7).
 */
export interface RetrieveOptions {
  /** The maximum number of chunks to return (top-K, Req 24.2). */
  topK?: number;
  /** The minimum hybrid relevance score a chunk must reach to be returned (Req 24.7). */
  minRelevanceScore?: number;
  /** How many nearest-neighbour candidates to pull before re-ranking. */
  candidateLimit?: number;
}

/**
 * A single retrieved chunk, ranked and ready to be injected into the model
 * context with complete attribution (Req 24.2, 24.4).
 */
export interface RetrievedChunk {
  /** The chunk's stable id (its Vector_Store record id). */
  chunkId: string;
  /** The knowledge document the chunk belongs to. */
  documentId: string;
  /** The knowledge source the chunk was ingested from. */
  sourceId: string;
  /** The chunk's zero-based position within its document. */
  ordinal: number;
  /** The chunk text injected into the model context. */
  text: string;
  /** The combined hybrid relevance score in `[0, 1]` (Req 24.1, 24.2). */
  score: number;
  /** The vector-similarity component of {@link score} (Req 24.1). */
  vectorScore: number;
  /** The keyword-overlap component of {@link score} (Req 24.1). */
  keywordScore: number;
  /** The chunk's complete source attribution: id, title, location, link (Req 24.4). */
  attribution: SourceAttribution;
}

/**
 * The result of a retrieval (Req 24.2, 24.7).
 *
 * When {@link found} is `true`, {@link chunks} holds the top-ranked, authorized,
 * fully-attributed chunks ordered by non-increasing {@link RetrievedChunk.score}
 * and never exceeding the configured top-K (Req 24.2). When no chunk meets the
 * relevance threshold, {@link found} is `false`, {@link chunks} is empty, and
 * {@link message} carries the explicit "no relevant knowledge found" signal
 * (Req 24.7).
 */
export interface RetrievedContext {
  /** Whether any relevant, authorized, fully-attributed knowledge was found (Req 24.7). */
  found: boolean;
  /** The retrieved chunks, ranked best-first and bounded by top-K (Req 24.2). */
  chunks: RetrievedChunk[];
  /** The explicit no-knowledge signal when {@link found} is `false` (Req 24.7). */
  message?: string;
}
