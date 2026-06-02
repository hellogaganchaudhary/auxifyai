/**
 * Unified-search wiring across the native modules + the indexed knowledge base
 * (Req 29.1, 29.2).
 *
 * The Unified_Search_Service searches across every native content type a user is
 * authorized to reach by fanning a query out to one
 * {@link ContentTypeSearcher} per {@link UnifiedSearchType} (Req 29.1) and
 * gating each candidate through a {@link UnifiedSearchAuthorizer} (Req 29.2).
 * This module supplies the concrete searcher set: every native write the
 * {@link import('./ingestion-bridge.js').NativeIngestionBridge} indexed lands in
 * the SAME organization-scoped `knowledge_chunk` Vector_Store index, so a single
 * {@link KnowledgeBaseContentSearcher} per content type — all reading that one
 * index — covers Knowledge_Hub pages, messaging content, documents, AND the
 * non-native knowledge base at once.
 *
 * Each searcher embeds the query, queries the org-scoped index, keeps only
 * chunks with complete {@link import('@auxify/types').SourceAttribution}
 * (Req 24.6 discipline), classifies each chunk back to the
 * {@link UnifiedSearchType} of the module that produced it (via the injectable
 * {@link NativeModuleClassifier}, defaulting to the attribution-link scheme),
 * keeps the ones routed to its own type, fuses keyword + vector relevance, and
 * deduplicates to one best-scoring candidate per source resource — so a page /
 * message / document appears once under its content type. Authorization (Req
 * 29.2) and tenant scoping (Req 1.2) are the Unified_Search_Service's job, layered
 * over the org-scoped Vector_Store read.
 *
 * Surface:
 *   - {@link createUnifiedSearchService} — the factory: builds one searcher per
 *     content type over the shared index and returns a ready
 *     {@link UnifiedSearchService}.
 *   - {@link buildNativeContentTypeSearchers} — the searcher set alone, for a
 *     caller assembling its own {@link UnifiedSearchService}.
 *   - {@link KnowledgeBaseContentSearcher} — the per-type searcher over the
 *     `knowledge_chunk` index.
 *   - {@link defaultNativeModuleClassifier} / {@link DEFAULT_UNIFIED_SEARCH_TYPES} —
 *     the default attribution→type routing and the default content-type set.
 *   - {@link allowAllUnifiedSearchAuthorizer} — a permit-everything authorizer
 *     for tests / deployments that gate access elsewhere.
 */

import type { Principal, SourceAttribution } from '@auxify/types';

import type { Embedder } from '../file-processor/index.js';
import { hasCompleteAttribution, keywordScore } from '../knowledge/index.js';
import type { VectorMatch, VectorStore } from '../storage/index.js';
import {
  UnifiedSearchService,
  type ContentLocation,
  type ContentTypeSearcher,
  type UnifiedSearchAuthorizer,
  type UnifiedSearchCandidate,
  type UnifiedSearchType,
} from '../unified-search/index.js';

import { NATIVE_MODULE_LINK_SCHEMES, type NativeModuleClassifier } from './types.js';

/**
 * The content types the native wiring searches across by default (Req 29.1):
 * Knowledge_Hub pages, messaging content, documents, and the non-native
 * knowledge base. The Conversation_Manager's `conversation` type is intentionally
 * NOT included — it is wired by the conversation flow, not this module.
 */
export const DEFAULT_UNIFIED_SEARCH_TYPES: readonly UnifiedSearchType[] = [
  'knowledge_page',
  'message',
  'document',
  'knowledge_chunk',
] as const;

/** The owning native module name for each searched {@link UnifiedSearchType} (Req 29.5). */
const MODULE_FOR_TYPE: Readonly<Record<UnifiedSearchType, string>> = {
  conversation: 'conversations',
  message: 'messaging',
  knowledge_page: 'knowledge_hub',
  document: 'document_management',
  knowledge_chunk: 'knowledge',
} as const;

/** The default snippet length (characters) projected from a matched chunk's text. */
const DEFAULT_SNIPPET_LENGTH = 240 as const;

/** The default number of nearest-neighbour chunks pulled from the index before filtering. */
const DEFAULT_CANDIDATE_LIMIT = 200 as const;

/**
 * The default {@link NativeModuleClassifier}: routes an indexed chunk to a
 * {@link UnifiedSearchType} by its attribution-link scheme (Req 29.1).
 *
 * The {@link import('./ingestion-bridge.js').NativeIngestionBridge} stamps each
 * native module's deep-link scheme onto the content it forwards
 * (`knowledge-hub://`, `messaging://`, `document-management://`), so a chunk's
 * {@link SourceAttribution.link} prefix identifies its origin. Anything else is
 * the non-native knowledge base and lands under `knowledge_chunk`.
 *
 * @param attribution The indexed chunk's complete attribution.
 * @returns The content type the chunk belongs to.
 */
export function defaultNativeModuleClassifier(attribution: SourceAttribution): UnifiedSearchType {
  const link = attribution.link;
  if (link.startsWith(NATIVE_MODULE_LINK_SCHEMES.knowledge_hub)) {
    return 'knowledge_page';
  }
  if (link.startsWith(NATIVE_MODULE_LINK_SCHEMES.messaging)) {
    return 'message';
  }
  if (link.startsWith(NATIVE_MODULE_LINK_SCHEMES.dms)) {
    return 'document';
  }
  return 'knowledge_chunk';
}

/**
 * A {@link UnifiedSearchAuthorizer} that authorizes every candidate (Req 29.2).
 *
 * The convenience default for deployments that enforce access elsewhere (or for
 * tests focusing on grouping/ranking); a real deployment injects an authorizer
 * backed by the per-module permission models and Access_Control.
 */
export const allowAllUnifiedSearchAuthorizer: UnifiedSearchAuthorizer = {
  authorize: () => true,
};

/** The chunk facts read back from a `knowledge_chunk` Vector_Store record's metadata. */
interface ChunkFacts {
  /** The owning knowledge document id (the dedup key for a result). */
  documentId: string;
  /** The chunk text projected into the result snippet. */
  text: string;
  /** The chunk's complete source attribution (Req 24.4). */
  attribution: SourceAttribution;
}

/**
 * Read the `knowledge_chunk` facts from a {@link VectorMatch}'s metadata, or
 * `null` when the record is not a well-formed knowledge chunk.
 *
 * Mirrors the RAG_Retriever's defensive metadata read so a malformed or foreign
 * record is skipped rather than surfaced. The owning Organization is already
 * enforced by the org-scoped Vector_Store query (Req 1.2).
 */
function readChunkFacts(match: VectorMatch): ChunkFacts | null {
  const metadata = match.metadata;
  const documentId = metadata['documentId'];
  const text = metadata['text'];
  const attribution = metadata['attribution'];
  if (
    typeof documentId !== 'string' ||
    typeof text !== 'string' ||
    typeof attribution !== 'object' ||
    attribution === null
  ) {
    return null;
  }
  const attr = attribution as Record<string, unknown>;
  return {
    documentId,
    text,
    attribution: {
      sourceId: typeof attr['sourceId'] === 'string' ? attr['sourceId'] : '',
      sourceTitle: typeof attr['sourceTitle'] === 'string' ? attr['sourceTitle'] : '',
      location: typeof attr['location'] === 'string' ? attr['location'] : '',
      link: typeof attr['link'] === 'string' ? attr['link'] : '',
    },
  };
}

/** Project a chunk's attribution into the {@link ContentLocation} a client opens (Req 29.5). */
function locationFor(type: UnifiedSearchType, attribution: SourceAttribution): ContentLocation {
  const link = attribution.link;
  const resourceId = lastPathSegment(link) ?? attribution.sourceId;
  return {
    module: MODULE_FOR_TYPE[type],
    resourceType: type,
    resourceId,
    url: link,
  };
}

/** The last non-empty path segment of a deep link, or `null` when there is none. */
function lastPathSegment(link: string): string | null {
  const withoutScheme = link.replace(/^[a-z-]+:\/\//i, '');
  const segments = withoutScheme.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last ?? null;
}

/** Truncate `text` to at most `max` characters, appending an ellipsis when cut. */
function snippetOf(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}…`;
}

/** Construction options for a {@link KnowledgeBaseContentSearcher}. */
export interface KnowledgeBaseContentSearcherOptions {
  /** The content type this searcher serves; only chunks classified to it are returned. */
  type: UnifiedSearchType;
  /** Embeds the query into a vector (Req 29.6); reused from the File_Processor. */
  embedder: Embedder;
  /** The organization-scoped `knowledge_chunk` Vector_Store index (Req 29.1). */
  vectorStore: VectorStore;
  /** Routes each indexed chunk to a content type (defaults to {@link defaultNativeModuleClassifier}). */
  classifier?: NativeModuleClassifier;
  /** Nearest-neighbour pool size pulled before filtering (defaults to {@link DEFAULT_CANDIDATE_LIMIT}). */
  candidateLimit?: number;
  /** Snippet length in characters (defaults to {@link DEFAULT_SNIPPET_LENGTH}). */
  snippetLength?: number;
}

/**
 * A {@link ContentTypeSearcher} over the shared `knowledge_chunk` Vector_Store
 * index, serving exactly the chunks the {@link NativeModuleClassifier} routes to
 * its {@link KnowledgeBaseContentSearcher.type} (Req 29.1).
 *
 * One instance per content type, all reading the same org-scoped index, lets a
 * single index back every native module's unified-search results: each searcher
 * embeds the query, pulls the org-scoped neighbours (so a query can never cross
 * a tenant boundary, Req 1.2), drops chunks lacking complete attribution, keeps
 * those classified to its type, fuses keyword + vector relevance into the
 * candidate scores the service combines (Req 29.6), and deduplicates to the
 * best-scoring chunk per source resource so each page / message / document is a
 * single result. A Vector_Store read failure propagates so the service reports
 * the type as unavailable (Req 29.7).
 */
export class KnowledgeBaseContentSearcher implements ContentTypeSearcher {
  readonly type: UnifiedSearchType;
  private readonly embedder: Embedder;
  private readonly vectors: VectorStore;
  private readonly classifier: NativeModuleClassifier;
  private readonly candidateLimit: number;
  private readonly snippetLength: number;

  constructor(options: KnowledgeBaseContentSearcherOptions) {
    this.type = options.type;
    this.embedder = options.embedder;
    this.vectors = options.vectorStore;
    this.classifier = options.classifier ?? defaultNativeModuleClassifier;
    this.candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
    this.snippetLength = options.snippetLength ?? DEFAULT_SNIPPET_LENGTH;
  }

  async search(query: string, principal: Principal): Promise<UnifiedSearchCandidate[]> {
    const [queryEmbedding] = await this.embedder.embed([query]);
    if (queryEmbedding === undefined) {
      return [];
    }
    const matches = await this.vectors.query(
      queryEmbedding,
      { organizationId: principal.organizationId, ownerType: 'knowledge_chunk' },
      this.candidateLimit,
    );

    // Deduplicate to the best-scoring chunk per source resource, so a page /
    // message / document surfaces once under its content type.
    const bestByResource = new Map<string, UnifiedSearchCandidate>();
    for (const match of matches) {
      const facts = readChunkFacts(match);
      if (facts === null || !hasCompleteAttribution(facts.attribution)) {
        continue;
      }
      if (this.classifier(facts.attribution) !== this.type) {
        continue;
      }
      const candidate: UnifiedSearchCandidate = {
        id: match.id,
        organizationId: principal.organizationId,
        title: facts.attribution.sourceTitle,
        snippet: snippetOf(facts.text, this.snippetLength),
        keywordScore: keywordScore(query, facts.text),
        vectorScore: match.score,
        location: locationFor(this.type, facts.attribution),
      };
      const existing = bestByResource.get(facts.documentId);
      if (existing === undefined || candidateScore(candidate) > candidateScore(existing)) {
        bestByResource.set(facts.documentId, candidate);
      }
    }
    return [...bestByResource.values()];
  }
}

/** The provisional relevance of a candidate used only to pick the best chunk per resource. */
function candidateScore(candidate: UnifiedSearchCandidate): number {
  return (candidate.vectorScore ?? 0) + (candidate.keywordScore ?? 0);
}

/** Construction options for {@link buildNativeContentTypeSearchers} / {@link createUnifiedSearchService}. */
export interface UnifiedSearchWiringOptions {
  /** Embeds the query into a vector (Req 29.6); reused from the File_Processor. */
  embedder: Embedder;
  /** The organization-scoped `knowledge_chunk` Vector_Store index every searcher reads (Req 29.1). */
  vectorStore: VectorStore;
  /**
   * The content types to build searchers for (defaults to
   * {@link DEFAULT_UNIFIED_SEARCH_TYPES}: knowledge pages, messaging, documents,
   * and the knowledge base).
   */
  types?: readonly UnifiedSearchType[];
  /** Routes each indexed chunk to a content type (defaults to {@link defaultNativeModuleClassifier}). */
  classifier?: NativeModuleClassifier;
  /** Nearest-neighbour pool size pulled per searcher (defaults to {@link DEFAULT_CANDIDATE_LIMIT}). */
  candidateLimit?: number;
  /** Snippet length in characters (defaults to {@link DEFAULT_SNIPPET_LENGTH}). */
  snippetLength?: number;
}

/**
 * Build one {@link KnowledgeBaseContentSearcher} per content type over the shared
 * `knowledge_chunk` index (Req 29.1).
 *
 * For a caller assembling its own {@link UnifiedSearchService} (e.g. to add the
 * Conversation_Manager's `conversation` searcher alongside these). The returned
 * searchers all read the same org-scoped index and classify chunks back to their
 * own content type.
 *
 * @param options The embedder, index, and optional type/classifier/tuning.
 * @returns One searcher per requested content type.
 */
export function buildNativeContentTypeSearchers(
  options: UnifiedSearchWiringOptions,
): ContentTypeSearcher[] {
  const types = options.types ?? DEFAULT_UNIFIED_SEARCH_TYPES;
  const classifier = options.classifier ?? defaultNativeModuleClassifier;
  return [...new Set(types)].map(
    (type) =>
      new KnowledgeBaseContentSearcher({
        type,
        embedder: options.embedder,
        vectorStore: options.vectorStore,
        classifier,
        ...(options.candidateLimit !== undefined ? { candidateLimit: options.candidateLimit } : {}),
        ...(options.snippetLength !== undefined ? { snippetLength: options.snippetLength } : {}),
      }),
  );
}

/** Construction options for {@link createUnifiedSearchService}. */
export interface CreateUnifiedSearchServiceOptions extends UnifiedSearchWiringOptions {
  /**
   * Decides whether the requesting principal may see each candidate (Req 29.2).
   * Defaults to {@link allowAllUnifiedSearchAuthorizer}; a real deployment injects
   * one backed by the per-module permission models and Access_Control.
   */
  authorizer?: UnifiedSearchAuthorizer;
  /** The default per-group top-K (forwarded to the {@link UnifiedSearchService}). */
  defaultGroupLimit?: number;
  /** The weight applied to the vector-similarity score (forwarded to the service). */
  vectorWeight?: number;
  /** The weight applied to the keyword-overlap score (forwarded to the service). */
  keywordWeight?: number;
}

/**
 * Build a {@link UnifiedSearchService} that searches across Knowledge_Hub pages,
 * messaging content, documents, AND the indexed knowledge base — all from the
 * shared `knowledge_chunk` index the {@link NativeIngestionBridge} writes
 * (Req 29.1, 29.2).
 *
 * Wires one {@link KnowledgeBaseContentSearcher} per content type into a
 * {@link UnifiedSearchService} with the supplied (or permit-everything)
 * authorizer, so native content indexed on write is immediately retrievable
 * through unified search, grouped by content type and gated per principal.
 *
 * @param options The embedder, the `knowledge_chunk` index, and optional
 *   authorizer / type set / classifier / ranking tuning.
 * @returns A ready {@link UnifiedSearchService}.
 */
export function createUnifiedSearchService(
  options: CreateUnifiedSearchServiceOptions,
): UnifiedSearchService {
  const searchers = buildNativeContentTypeSearchers(options);
  return new UnifiedSearchService({
    searchers,
    authorizer: options.authorizer ?? allowAllUnifiedSearchAuthorizer,
    ...(options.defaultGroupLimit !== undefined
      ? { defaultGroupLimit: options.defaultGroupLimit }
      : {}),
    ...(options.vectorWeight !== undefined ? { vectorWeight: options.vectorWeight } : {}),
    ...(options.keywordWeight !== undefined ? { keywordWeight: options.keywordWeight } : {}),
  });
}
