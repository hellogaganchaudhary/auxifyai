/**
 * Native-module ingestion + unified-search wiring types and ports
 * (Req 26.8, 27.9, 28.5, 29.1).
 *
 * This module is pure composition: it connects the three native content modules'
 * ingestion-on-write seams — the Knowledge_Hub_Service's
 * {@link import('../knowledge-hub/index.js').PageIngestionEmitter}, the
 * Messaging_Service's {@link import('../messaging/index.js').MessageIngestionEmitter},
 * and the Document_Management_Service's
 * {@link import('../document-management/index.js').DocumentIngestionEmitter} — to
 * the {@link import('../knowledge/index.js').KnowledgeIngestionService} (so every
 * write is parsed, chunked, embedded, and indexed as a retrievable
 * `knowledge_chunk` record with complete
 * {@link import('@auxify/types').SourceAttribution}, Req 26.8/27.9/28.5), and
 * registers each content type with the
 * {@link import('../unified-search/index.js').UnifiedSearchService} so the
 * indexed content is retrievable through unified search (Req 29.1).
 *
 * The Knowledge_Ingestion_Service ingests through a *pull* model
 * ({@link import('../knowledge/index.js').KnowledgeIngestionService.ingest}
 * fetches a source's documents through a
 * {@link import('../knowledge/index.js').SourceFetcher}), while the native
 * modules *push* an event on every write. The wiring bridges the two by mapping
 * each emitted event onto a {@link import('../knowledge/index.js').FetchedDocument}
 * staged for the source's type, then driving an ingest of that source. The pure
 * mappers — {@link pageIngestionToDocument}, {@link messageIngestionToDocument},
 * and {@link documentIngestionToDocument} — are the canonical "event → ingest
 * path" projections, and {@link defaultNativeModuleSourceType} names which native
 * source type each emitter feeds.
 *
 * Everything the wiring cannot do purely is a narrow injectable port — a
 * {@link NativeSourceResolver} (which knowledge source each native type ingests
 * into), a {@link DocumentContentReader} (the document bytes → indexable text
 * seam), and an {@link IngestionFailureRecorder} (so an indexing failure is
 * recorded, never thrown back to the originating write) — so the bridge stays
 * pure orchestration and fully fake-able.
 */

import type { SourceAttribution, TenantContext } from '@auxify/types';

import type { DocumentIngestionEvent } from '../document-management/index.js';
import type { FetchedDocument, NativeSourceType } from '../knowledge/index.js';
import type { PageIngestionEvent } from '../knowledge-hub/index.js';
import type { MessageIngestionItem } from '../messaging/index.js';
import type { UnifiedSearchType } from '../unified-search/index.js';

/**
 * The native source types this wiring connects to the
 * Knowledge_Ingestion_Service (a subset of
 * {@link import('../knowledge/index.js').NativeSourceType}): the
 * Knowledge_Hub_Service's pages, the Messaging_Service's messages, and the
 * Document_Management_Service's documents (Req 26.8, 27.9, 28.5).
 */
export type NativeIngestionSourceType = 'knowledge_hub' | 'messaging' | 'dms';

/**
 * All {@link NativeIngestionSourceType} values, for iteration, validation, and
 * the {@link NativeSourceResolver} default. Typed as a subset of
 * {@link NativeSourceType} so it stays in lock-step with the ingestion service's
 * native source vocabulary.
 */
export const NATIVE_INGESTION_SOURCE_TYPES: readonly NativeIngestionSourceType[] = [
  'knowledge_hub',
  'messaging',
  'dms',
] as const;

/** Narrow runtime guard that a value is a supported {@link NativeIngestionSourceType}. */
export function isNativeIngestionSourceType(value: unknown): value is NativeIngestionSourceType {
  return (
    typeof value === 'string' &&
    (NATIVE_INGESTION_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The deep-link URI schemes each native module stamps onto its content's
 * {@link SourceAttribution.link} (Req 24.4) — the signal the default
 * {@link import('./unified-search-wiring.js').defaultNativeModuleClassifier}
 * uses to route an indexed `knowledge_chunk` back to the
 * {@link UnifiedSearchType} of the module that produced it.
 */
export const NATIVE_MODULE_LINK_SCHEMES: Readonly<
  Record<NativeIngestionSourceType, string>
> = {
  knowledge_hub: 'knowledge-hub://',
  messaging: 'messaging://',
  dms: 'document-management://',
} as const;

/**
 * Resolves the Knowledge_Ingestion_Service source a given native content type
 * ingests into, within the caller's Organization (Req 26.8, 27.9, 28.5).
 *
 * The {@link NativeIngestionBridge} forwards each write to the source this
 * resolves, so the resolver owns the policy of *which* knowledge source backs a
 * native module's content (one per Organization + type). Modelling it as a port
 * keeps the bridge decoupled from how sources are provisioned: production can
 * resolve a pre-provisioned source from the Knowledge_Manager, while the default
 * {@link import('./ingestion-bridge.js').ConnectingNativeSourceResolver}
 * connects one lazily.
 */
export interface NativeSourceResolver {
  /**
   * Resolve (provisioning if necessary) the knowledge source id that the given
   * native content {@link type} ingests into for the caller's Organization.
   *
   * @param ctx The tenant scope the content belongs to.
   * @param type The native content type being ingested.
   * @returns The knowledge source id to ingest into.
   */
  resolveSourceId(ctx: TenantContext, type: NativeIngestionSourceType): Promise<string>;
}

/**
 * Reads a Document_Management_Service document's indexable text from its stored
 * bytes (Req 28.5).
 *
 * A {@link DocumentIngestionEvent} carries only a reference to the stored bytes
 * (an Object_Store key + content type), not the text, so the bridge resolves the
 * text through this seam before staging the document for ingestion. The default
 * {@link import('./ingestion-bridge.js').ObjectStoreDocumentContentReader} reads
 * the bytes from the shared Object_Store and decodes them as UTF-8; production
 * can inject a reader backed by the File_Processor's text extraction.
 */
export interface DocumentContentReader {
  /**
   * Read a document's indexable text for the given ingestion event.
   *
   * @param ctx The tenant scope the document belongs to.
   * @param event The document write event referencing the stored bytes.
   * @returns The document's indexable text.
   */
  read(ctx: TenantContext, event: DocumentIngestionEvent): Promise<string>;
}

/**
 * A recorded ingestion failure (Req 23.8 resilience, applied at the wiring
 * boundary).
 *
 * Indexing a native write must never break the originating write, so when the
 * forward to the Knowledge_Ingestion_Service fails the bridge records this
 * structured, secret-free outcome instead of throwing it back to the writer.
 */
export interface NativeIngestionFailure {
  /** The native content type whose ingestion failed. */
  type: NativeIngestionSourceType;
  /** The originating content's stable id within its module (page/message/document id). */
  externalId: string;
  /** The Organization the failed write belonged to. */
  organizationId: string;
  /** A safe, human-readable description of the failure (never a secret). */
  error: string;
}

/**
 * The buffer that bridges the native modules' *push* writes to the
 * Knowledge_Ingestion_Service's *pull* ingest model (Req 26.8, 27.9, 28.5).
 *
 * The Knowledge_Ingestion_Service ingests a source by fetching its current
 * documents through a {@link import('../knowledge/index.js').SourceFetcher},
 * whereas a native module emits one event per write. The
 * {@link NativeIngestionBridge} reconciles the two: on each write it
 * {@link stage}s the content's {@link FetchedDocument} projection under the
 * source it ingests into, then drives an ingest; the
 * {@link import('./ingestion-bridge.js').StagingSourceFetcher} the
 * Knowledge_Ingestion_Service resolves reads exactly the staged documents back
 * via {@link list}. Staging is keyed by `(organizationId, sourceId, externalId)`
 * and upserts by `externalId`, so a re-write replaces its prior staged copy and
 * the source's full document set is always fetchable — letting content-hash
 * change detection (Req 23.4) re-index only what actually changed. Modelling it
 * as a narrow port keeps the bridge decoupled from the buffer's backing (the
 * default is the in-memory
 * {@link import('./ingestion-bridge.js').InMemoryNativeIngestionStagingStore};
 * production wires the native modules' own repositories as the real pull).
 */
export interface NativeIngestionStagingStore {
  /**
   * Stage (insert or replace by `externalId`) a document for a source, within
   * the caller's Organization.
   *
   * @param ctx The tenant scope the content belongs to.
   * @param sourceId The knowledge source the content ingests into.
   * @param document The fetched-document projection of the written content.
   */
  stage(ctx: TenantContext, sourceId: string, document: FetchedDocument): Promise<void>;
  /**
   * List the documents currently staged for a source within the caller's
   * Organization (the {@link import('./ingestion-bridge.js').StagingSourceFetcher}'s
   * read side).
   *
   * @param ctx The tenant scope.
   * @param sourceId The knowledge source whose staged documents to read.
   * @returns The staged documents, in stage order.
   */
  list(ctx: TenantContext, sourceId: string): Promise<FetchedDocument[]>;
}

/**
 * Records an ingestion failure that occurred while forwarding a native write to
 * the Knowledge_Ingestion_Service (Req 23.8).
 *
 * The {@link NativeIngestionBridge} calls this instead of throwing, so a failure
 * to index is observable (for monitoring / retry) yet never propagates to — and
 * breaks — the originating module write. The default is a no-op; tests inject a
 * capturing recorder to assert resilience.
 */
export interface IngestionFailureRecorder {
  /**
   * Record an ingestion failure.
   *
   * @param failure The structured, secret-free failure outcome.
   */
  record(failure: NativeIngestionFailure): void | Promise<void>;
}

/**
 * Classifies an indexed `knowledge_chunk`'s {@link SourceAttribution} into the
 * {@link UnifiedSearchType} of the native module (or knowledge base) that
 * produced it (Req 29.1).
 *
 * The {@link import('./unified-search-wiring.js').KnowledgeBaseContentSearcher}
 * fans the same org-scoped `knowledge_chunk` index out to one searcher per type,
 * each keeping only the chunks this classifier routes to its type — so the
 * unified search groups native content under its content type while the
 * non-native knowledge base lands under `knowledge_chunk`.
 */
export type NativeModuleClassifier = (attribution: SourceAttribution) => UnifiedSearchType;

/**
 * The native source type each native ingestion emitter feeds (Req 26.8, 27.9,
 * 28.5): Knowledge_Hub pages → `knowledge_hub`, messaging content → `messaging`,
 * Document_Management documents → `dms`.
 */
export const defaultNativeModuleSourceType: Readonly<
  Record<'page' | 'message' | 'document', NativeIngestionSourceType>
> = {
  page: 'knowledge_hub',
  message: 'messaging',
  document: 'dms',
} as const;

/**
 * Project a Knowledge_Hub {@link PageIngestionEvent} onto the
 * Knowledge_Ingestion_Service's {@link FetchedDocument} ingest unit (Req 26.8).
 *
 * The page's id is the stable change-detection key, its title and indexable text
 * become the document's title and content, and the page's complete attribution
 * supplies the source location and deep link so the indexed chunk can always be
 * cited and routed back to the Knowledge_Hub_Service (Req 24.4, 29.5).
 *
 * @param event The page write event emitted by the Knowledge_Hub_Service.
 * @returns The fetched-document projection to ingest.
 */
export function pageIngestionToDocument(event: PageIngestionEvent): FetchedDocument {
  return {
    externalId: event.pageId,
    title: event.title,
    content: event.text,
    location: event.attribution.location,
    link: event.attribution.link,
  };
}

/**
 * Project a Messaging {@link MessageIngestionItem} onto the
 * Knowledge_Ingestion_Service's {@link FetchedDocument} ingest unit (Req 27.9).
 *
 * The message's id is the change-detection key and its body is the indexable
 * content; since a message carries no attribution of its own, a stable
 * channel-scoped location and a `messaging://` deep link are synthesized so the
 * indexed chunk is cited and routed back to the Messaging_Service (Req 24.4,
 * 29.5).
 *
 * @param item The message write item emitted by the Messaging_Service.
 * @returns The fetched-document projection to ingest.
 */
export function messageIngestionToDocument(item: MessageIngestionItem): FetchedDocument {
  return {
    externalId: item.messageId,
    title: `Message in channel ${item.channelId}`,
    content: item.body,
    location: `channel:${item.channelId}`,
    link: `${NATIVE_MODULE_LINK_SCHEMES.messaging}channels/${item.channelId}/messages/${item.messageId}`,
  };
}

/**
 * Project a Document_Management {@link DocumentIngestionEvent} (with its
 * already-resolved text) onto the Knowledge_Ingestion_Service's
 * {@link FetchedDocument} ingest unit (Req 28.5).
 *
 * The document's id is the change-detection key, its name and resolved text
 * become the document's title and content, and the document's complete
 * attribution supplies the source location and deep link so the indexed chunk
 * can always be cited and routed back to the Document_Management_Service
 * (Req 24.4, 29.5).
 *
 * @param event The document write event emitted by the Document_Management_Service.
 * @param content The document's indexable text (resolved via a {@link DocumentContentReader}).
 * @returns The fetched-document projection to ingest.
 */
export function documentIngestionToDocument(
  event: DocumentIngestionEvent,
  content: string,
): FetchedDocument {
  return {
    externalId: event.documentId,
    title: event.name,
    content,
    location: event.attribution.location,
    link: event.attribution.link,
  };
}
