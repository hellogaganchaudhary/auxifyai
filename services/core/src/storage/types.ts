/**
 * Shared types and invariants for the replaceable storage layer.
 *
 * The platform persists data across three swappable backends behind stable
 * interfaces (the "replaceable provider abstractions" principle):
 *   - Vector_Store  → pgvector + HNSW today, migratable later (Req 44.2, 44.3)
 *   - Object_Store  → S3 / MinIO (Req 44.5)
 *   - Cache_Store   → Redis (Req 44.4)
 *
 * Consuming services (RAG_Retriever, File_Processor, Knowledge_*, etc.) depend
 * only on the interfaces in this module, never on a concrete backend, so the
 * underlying vendor can be replaced without redesigning the embedding schema
 * or the callers (Req 44.3).
 */

/**
 * The fixed embedding dimensionality used everywhere in the platform.
 *
 * Every embedding persisted to the Vector_Store has exactly this many
 * dimensions (Req 44.2). This is a hard invariant enforced at the storage
 * boundary so no downstream component can index a mismatched vector.
 */
export const EMBEDDING_DIMENSIONS = 1536 as const;

/**
 * The kinds of records that own an embedding in the Vector_Store.
 * Mirrors the `VectorRecord.ownerType` union in the design data model.
 */
export type VectorOwnerType =
  | 'knowledge_chunk'
  | 'file_chunk'
  | 'knowledge_page'
  | 'document'
  | 'message';

/**
 * A single vector-store record (design "VectorRecord").
 *
 * `embedding` MUST contain exactly {@link EMBEDDING_DIMENSIONS} numbers; the
 * {@link VectorStore.upsert} contract rejects anything else (Req 44.2).
 */
export interface VectorRecord {
  /** Stable unique id for the record (typically a UUID). */
  id: string;
  /** Owning organization — every record is tenant-scoped. */
  organizationId: string;
  /** What this embedding represents. */
  ownerType: VectorOwnerType;
  /** The id of the owning domain entity (chunk, page, document, message). */
  ownerId: string;
  /** The embedding vector — exactly {@link EMBEDDING_DIMENSIONS} dimensions. */
  embedding: number[];
  /** Arbitrary structured metadata stored alongside the vector. */
  metadata: Record<string, unknown>;
}

/**
 * Filter applied to a similarity {@link VectorStore.query}.
 *
 * `organizationId` is required so a query can never cross an Organization
 * boundary at the storage layer (defense in depth for tenant isolation).
 */
export interface VectorFilter {
  /** Restrict the search to a single organization (required). */
  organizationId: string;
  /** Optionally restrict to one or more owner types. */
  ownerType?: VectorOwnerType | VectorOwnerType[];
  /** Optionally restrict to a single owning entity. */
  ownerId?: string;
  /** Optional exact-match metadata constraints (all must match). */
  metadata?: Record<string, unknown>;
}

/** A single similarity-search hit returned by {@link VectorStore.query}. */
export interface VectorMatch {
  /** The matched record id. */
  id: string;
  /** The matched record's owner type. */
  ownerType: VectorOwnerType;
  /** The matched record's owning entity id. */
  ownerId: string;
  /**
   * Similarity score in `[0, 1]`, higher is more similar
   * (derived from cosine distance: `score = 1 - distance`).
   */
  score: number;
  /** The metadata stored with the matched record. */
  metadata: Record<string, unknown>;
}

/**
 * Thrown when a {@link VectorRecord} is submitted with an embedding whose
 * dimensionality is not exactly {@link EMBEDDING_DIMENSIONS} (Req 44.2).
 */
export class InvalidEmbeddingDimensionError extends Error {
  constructor(
    /** The offending record id, when known. */
    public readonly recordId: string | undefined,
    /** The dimensionality that was supplied. */
    public readonly actualDimensions: number,
    /** The dimensionality that was required. */
    public readonly expectedDimensions: number = EMBEDDING_DIMENSIONS,
  ) {
    super(
      `Embedding for record ${recordId ?? '<unknown>'} has ${actualDimensions} ` +
        `dimensions; exactly ${expectedDimensions} are required.`,
    );
    this.name = 'InvalidEmbeddingDimensionError';
  }
}

/**
 * Validate that an embedding has exactly {@link EMBEDDING_DIMENSIONS}
 * dimensions, throwing {@link InvalidEmbeddingDimensionError} otherwise.
 *
 * This is the single source of truth for the dimensionality invariant so that
 * every backend (pgvector, in-memory, and any future migration target) accepts
 * a record if and only if its embedding has exactly 1536 dimensions (Req 44.2).
 */
export function assertEmbeddingDimensions(
  embedding: readonly number[],
  recordId?: string,
): void {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new InvalidEmbeddingDimensionError(recordId, embedding.length);
  }
}

/**
 * Validate every record in a batch before any of it is persisted, so an
 * {@link VectorStore.upsert} is all-or-nothing with respect to the
 * dimensionality invariant.
 */
export function assertRecordsValid(records: readonly VectorRecord[]): void {
  for (const record of records) {
    assertEmbeddingDimensions(record.embedding, record.id);
  }
}
