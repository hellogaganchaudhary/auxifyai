/**
 * Native-module ingestion + unified-search wiring (Req 26.8, 27.9, 28.5, 29.1).
 *
 * This is a pure *composition* module: it connects the three native content
 * modules' ingestion-on-write seams to the
 * {@link import('../knowledge/index.js').KnowledgeIngestionService} so authorized
 * content written in any module is indexed as a retrievable `knowledge_chunk`
 * record, and it registers each content type with the
 * {@link import('../unified-search/index.js').UnifiedSearchService} so that
 * content is retrievable through unified search. It owns no new persistence,
 * embedding, or vector capability — only the adapters and factories that wire the
 * existing services together.
 *
 * Ingestion-on-write (Req 26.8, 27.9, 28.5):
 *   - {@link NativeIngestionBridge} provides the concrete
 *     {@link import('../knowledge-hub/index.js').PageIngestionEmitter},
 *     {@link import('../messaging/index.js').MessageIngestionEmitter}, and
 *     {@link import('../document-management/index.js').DocumentIngestionEmitter}
 *     adapters: on each page/message/document write it stages the content's
 *     {@link import('../knowledge/index.js').FetchedDocument} projection in a
 *     shared {@link NativeIngestionStagingStore} and drives an ingest, so the
 *     content is parsed → chunked → embedded → indexed with complete
 *     {@link import('@auxify/types').SourceAttribution}. Every adapter is
 *     fire-and-forget: a failure is recorded through an
 *     {@link IngestionFailureRecorder} and never thrown back to the originating
 *     write (Req 23.8).
 *   - {@link createNativeIngestionBridge} is the convenience factory that builds
 *     the staging store, the {@link StagingSourceFetcher}, the
 *     Knowledge_Ingestion_Service, and the bridge as one consistent unit; the
 *     pure {@link pageIngestionToDocument} / {@link messageIngestionToDocument} /
 *     {@link documentIngestionToDocument} mappers are the canonical event→ingest
 *     projections.
 *
 * Unified search across all sources (Req 29.1, 29.2):
 *   - {@link createUnifiedSearchService} builds a
 *     {@link import('../unified-search/index.js').UnifiedSearchService} with one
 *     {@link KnowledgeBaseContentSearcher} per content type over the SAME shared
 *     `knowledge_chunk` index, so Knowledge_Hub pages, messaging content,
 *     documents, AND the non-native knowledge base are all retrievable, grouped
 *     by content type and gated per principal; {@link buildNativeContentTypeSearchers}
 *     exposes the searcher set for a caller assembling its own service. The
 *     {@link defaultNativeModuleClassifier} routes each indexed chunk back to its
 *     content type by attribution-link scheme.
 *
 * The in-memory test fakes (the capturing failure recorder plus the re-exported
 * component-module fakes) live in `./fakes.js` and are intentionally NOT
 * re-exported from this barrel — they would collide with the equally-named
 * storage / embedder fakes of sibling modules. Following the established
 * convention, the tests import them directly from `./fakes.js`.
 *
 * Names are chosen to be unique across the `@auxify/core` package barrel
 * (`NativeIngestion*`, `createNativeIngestionBridge`, `createUnifiedSearchService`,
 * `KnowledgeBaseContentSearcher`), and this module deliberately does NOT
 * re-export any type already exported by the component modules it composes (the
 * emitter ports, `FetchedDocument`, `UnifiedSearchType`, …); it consumes those by
 * import.
 */

export {
  NativeIngestionBridge,
  StagingSourceFetcher,
  InMemoryNativeIngestionStagingStore,
  ConnectingNativeSourceResolver,
  ObjectStoreDocumentContentReader,
  createNativeIngestionBridge,
  noopIngestionFailureRecorder,
  type NativeIngestionBridgeOptions,
  type ConnectingNativeSourceResolverOptions,
  type CreateNativeIngestionBridgeOptions,
  type NativeIngestionWiring,
} from './ingestion-bridge.js';

export {
  KnowledgeBaseContentSearcher,
  buildNativeContentTypeSearchers,
  createUnifiedSearchService,
  defaultNativeModuleClassifier,
  allowAllUnifiedSearchAuthorizer,
  DEFAULT_UNIFIED_SEARCH_TYPES,
  type KnowledgeBaseContentSearcherOptions,
  type UnifiedSearchWiringOptions,
  type CreateUnifiedSearchServiceOptions,
} from './unified-search-wiring.js';

export {
  UnknownNativeSourceError,
  UNKNOWN_NATIVE_SOURCE_CODE,
} from './errors.js';

export {
  NATIVE_INGESTION_SOURCE_TYPES,
  NATIVE_MODULE_LINK_SCHEMES,
  defaultNativeModuleSourceType,
  isNativeIngestionSourceType,
  pageIngestionToDocument,
  messageIngestionToDocument,
  documentIngestionToDocument,
  type NativeIngestionSourceType,
  type NativeSourceResolver,
  type NativeIngestionStagingStore,
  type DocumentContentReader,
  type IngestionFailureRecorder,
  type NativeIngestionFailure,
  type NativeModuleClassifier,
} from './types.js';
