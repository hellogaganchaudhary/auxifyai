/**
 * Knowledge_Ingestion_Service (Req 23.1-23.9).
 *
 * The Knowledge_Ingestion_Service is the pipeline that turns a connected
 * knowledge source into retrievable, attributed knowledge. Its entry points on
 * {@link KnowledgeIngestionService}:
 *
 *   - {@link KnowledgeIngestionService.connectSource} registers a primary native
 *     source — direct file upload, Knowledge_Hub_Service pages,
 *     Document_Management_Service documents, Messaging_Service content, GitHub,
 *     email, or web URL (Req 23.1) — or, where an Organization enables one, an
 *     optional interoperability connector (Notion, Confluence, Google Drive,
 *     SharePoint) that is never required for platform operation (Req 23.2);
 *   - {@link KnowledgeIngestionService.ingest} fetches the source's documents
 *     through the injectable {@link SourceFetcher} and runs parse → chunk →
 *     embed → index for each new or changed document (Req 23.3), reusing the
 *     File_Processor's {@link import('../file-processor/index.js').chunkText} and
 *     {@link import('../file-processor/index.js').Embedder} and indexing each
 *     chunk as a `knowledge_chunk` record through the shared
 *     {@link import('../storage/index.js').VectorStore} with complete
 *     {@link import('@auxify/types').SourceAttribution} (Req 24.4);
 *   - content-hash change detection via the injectable {@link ContentHasher}
 *     re-indexes only changed documents (Req 23.4), exposed without mutation as
 *     {@link KnowledgeIngestionService.detectChanges};
 *   - {@link KnowledgeIngestionService.onChangeNotification} ingests on a
 *     real-time source's change notification (Req 23.5), and
 *     {@link KnowledgeIngestionService.reindex} re-processes every document for a
 *     scheduled (Req 23.6) or manual (Req 23.7) re-index;
 *   - per-document failures are recorded as {@link FailedDocument} outcomes while
 *     the remaining documents continue (Req 23.8), and an unavailable optional
 *     connector short-circuits to a `connector_unavailable`
 *     {@link KnowledgeIngestReport} so native sources keep serving uninterrupted
 *     (Req 23.9, via {@link ConnectorUnavailableError}).
 *
 * Every external capability is a narrow injectable port — the tenant-scoped
 * {@link KnowledgeStore}, the {@link SourceFetcherResolver}, the
 * {@link ContentHasher}, the embedder, and the Vector_Store — so the service is
 * pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`. The RAG_Retriever, Knowledge_Manager, and ingestion-on-write
 * for the native modules (Req 24, 25, 26.8, 27.9, 28.5) build on the indexed
 * `knowledge_chunk` records produced here.
 *
 * The RAG_Retriever (Req 24.1-24.7) is the retrieval side of this module:
 * {@link RagRetriever.retrieve} embeds a query, runs hybrid (vector + keyword)
 * retrieval over the principal's Organization-scoped `knowledge_chunk` index
 * (Req 24.1, 1.2), excludes chunks lacking complete attribution (Req 24.6) and
 * chunks the principal cannot access via the injectable {@link ChunkAuthorizer}
 * (Req 24.3), re-ranks the survivors and returns the top-ranked chunks with
 * complete {@link import('@auxify/types').SourceAttribution} (Req 24.2, 24.4),
 * and signals "no relevant knowledge found" when nothing meets the relevance
 * threshold (Req 24.7).
 *
 * The Knowledge_Manager (Req 25.1-25.5) is the administration side of this
 * module: {@link KnowledgeManager} creates collections with a name, owning
 * Team/Project, and access list (Req 25.1), sets the Teams/Projects permitted to
 * retrieve from a collection (Req 25.2), reports each source's sync status, last
 * sync time, and document count (Req 25.3), flags content duplicated within a
 * collection (Req 25.4), and marks documents outside the freshness window stale
 * (Req 25.5) — recording every mutation through the {@link AuditRecorder} port.
 * The collection access lists are the model the RAG_Retriever's
 * {@link ChunkAuthorizer} composes via the production
 * {@link CollectionScopedChunkAuthorizer} (Req 24.3, 25.2).
 */

export {
  RagRetriever,
  type RagRetrieverOptions,
} from './rag-retriever.js';

export {
  tokenize,
  keywordScore,
  hybridScore,
  hasCompleteAttribution,
} from './rag-ranking.js';

export {
  DEFAULT_TOP_K,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_VECTOR_WEIGHT,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_CANDIDATE_LIMIT,
  NO_RELEVANT_KNOWLEDGE_MESSAGE,
  type ChunkAuthorizer,
  type RetrievableChunk,
  type RetrieveOptions,
  type RetrievedChunk,
  type RetrievedContext,
} from './rag-types.js';

export {
  KnowledgeIngestionService,
  type KnowledgeIngestionServiceOptions,
  type KnowledgeIdGenerator,
  type KnowledgeClock,
} from './knowledge-ingestion-service.js';

export {
  Sha256ContentHasher,
  sha256ContentHasher,
} from './content-hash.js';

export {
  UnknownSourceError,
  MissingSourceFetcherError,
  ConnectorUnavailableError,
  UNKNOWN_SOURCE_CODE,
  MISSING_SOURCE_FETCHER_CODE,
  CONNECTOR_UNAVAILABLE_CODE,
} from './errors.js';

export {
  NATIVE_SOURCE_TYPES,
  CONNECTOR_SOURCE_TYPES,
  SYNC_MODES,
  isNativeSourceType,
  isConnectorSourceType,
  type NativeSourceType,
  type ConnectorSourceType,
  type KnowledgeSourceType,
  type SyncMode,
  type SyncStatus,
  type KnowledgeSource,
  type KnowledgeSourceConfig,
  type FetchedDocument,
  type SourceFetcher,
  type SourceFetcherResolver,
  type ContentHasher,
  type KnowledgeDocumentRecord,
  type SaveDocumentInput,
  type KnowledgeChunkRecord,
  type SourceSyncPatch,
  type KnowledgeStore,
  type DocumentIngestStatus,
  type IndexedDocument,
  type UnchangedDocument,
  type FailedDocument,
  type DocumentIngestOutcome,
  type IngestRunStatus,
  type KnowledgeIngestReport,
  type KnowledgeChangeSet,
} from './types.js';

export {
  KnowledgeManager,
  type KnowledgeManagerOptions,
} from './knowledge-manager.js';

export {
  COLLECTION_OWNER_SCOPES,
  DEFAULT_FRESHNESS_WINDOW_MS,
  type CollectionOwnerScope,
  type KnowledgeCollection,
  type CreateCollectionInput,
  type SourceStatus,
  type DuplicateFlag,
  type StaleDocument,
  type KnowledgeCollectionStore,
  type CollectionIdGenerator,
  type KnowledgeManagerClock,
  type MarkStaleOptions,
} from './knowledge-manager-types.js';

export {
  principalCanAccessCollection,
  CollectionScopedChunkAuthorizer,
} from './knowledge-access.js';

export {
  UnknownCollectionError,
  InvalidCollectionInputError,
  UNKNOWN_COLLECTION_CODE,
  INVALID_COLLECTION_INPUT_CODE,
} from './manager-errors.js';
