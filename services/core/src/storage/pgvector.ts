/**
 * pgvector-backed {@link VectorStore} (PostgreSQL 16 + pgvector, HNSW index).
 *
 * This backend talks to PostgreSQL through a narrow {@link SqlClient} port
 * rather than a concrete driver, so it can be wired to `pg`, a pooled client,
 * or a fake in tests — and so the platform's dependency on a specific vector
 * backend stays at this one boundary (Req 44.3). The 1536-dimension invariant
 * (Req 44.2) is enforced before any SQL is issued.
 */

import type { VectorStore } from './interfaces.js';
import {
  assertRecordsValid,
  EMBEDDING_DIMENSIONS,
  type VectorFilter,
  type VectorMatch,
  type VectorOwnerType,
  type VectorRecord,
} from './types.js';

/** A single SQL row returned by the underlying driver. */
export type SqlRow = Record<string, unknown>;

/** Result shape returned by {@link SqlClient.query}. */
export interface SqlQueryResult {
  rows: SqlRow[];
}

/**
 * Minimal parameterized-SQL port. Compatible with `pg`'s `Pool`/`Client`
 * `query(text, params)` signature, so a real client can be passed directly.
 */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<SqlQueryResult>;
}

/** Configuration for {@link PgVectorStore}. */
export interface PgVectorStoreOptions {
  /** Table holding the vector records. Defaults to `vector_records`. */
  table?: string;
  /** Number of dimensions to provision. Defaults to {@link EMBEDDING_DIMENSIONS}. */
  dimensions?: number;
}

/** Render a JS number[] as a pgvector literal: `[0.1,0.2,...]`. */
function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

function ownerTypeList(
  ownerType: VectorFilter['ownerType'],
): VectorOwnerType[] | undefined {
  if (ownerType === undefined) return undefined;
  return Array.isArray(ownerType) ? ownerType : [ownerType];
}

/**
 * Production {@link VectorStore} backed by pgvector with an HNSW index using
 * cosine distance (`vector_cosine_ops`).
 */
export class PgVectorStore implements VectorStore {
  private readonly table: string;

  constructor(
    private readonly sql: SqlClient,
    options: PgVectorStoreOptions = {},
  ) {
    this.table = options.table ?? 'vector_records';
  }

  /**
   * DDL that provisions the vector table and the HNSW index (Req 44.2).
   * Idempotent; intended to run from a migration or bootstrap step.
   */
  static migrationSql(options: PgVectorStoreOptions = {}): string {
    const table = options.table ?? 'vector_records';
    const dims = options.dimensions ?? EMBEDDING_DIMENSIONS;
    return [
      'CREATE EXTENSION IF NOT EXISTS vector;',
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      '  id TEXT PRIMARY KEY,',
      '  organization_id TEXT NOT NULL,',
      '  owner_type TEXT NOT NULL,',
      '  owner_id TEXT NOT NULL,',
      `  embedding vector(${dims}) NOT NULL,`,
      "  metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
      ');',
      // HNSW index on cosine distance for approximate nearest-neighbor search.
      `CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw`,
      `  ON ${table} USING hnsw (embedding vector_cosine_ops);`,
      // Tenant-scoped filtering support.
      `CREATE INDEX IF NOT EXISTS ${table}_org_idx ON ${table} (organization_id);`,
    ].join('\n');
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    // Enforce the dimensionality invariant before any write (Req 44.2).
    assertRecordsValid(records);
    if (records.length === 0) return;

    for (const record of records) {
      await this.sql.query(
        `INSERT INTO ${this.table} (id, organization_id, owner_type, owner_id, embedding, metadata)
         VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           organization_id = EXCLUDED.organization_id,
           owner_type = EXCLUDED.owner_type,
           owner_id = EXCLUDED.owner_id,
           embedding = EXCLUDED.embedding,
           metadata = EXCLUDED.metadata`,
        [
          record.id,
          record.organizationId,
          record.ownerType,
          record.ownerId,
          toVectorLiteral(record.embedding),
          JSON.stringify(record.metadata ?? {}),
        ],
      );
    }
  }

  async query(
    embedding: number[],
    filter: VectorFilter,
    k: number,
  ): Promise<VectorMatch[]> {
    const params: unknown[] = [toVectorLiteral(embedding), filter.organizationId];
    const conditions: string[] = ['organization_id = $2'];

    const ownerTypes = ownerTypeList(filter.ownerType);
    if (ownerTypes) {
      params.push(ownerTypes);
      conditions.push(`owner_type = ANY($${params.length})`);
    }
    if (filter.ownerId !== undefined) {
      params.push(filter.ownerId);
      conditions.push(`owner_id = $${params.length}`);
    }
    if (filter.metadata) {
      params.push(JSON.stringify(filter.metadata));
      conditions.push(`metadata @> $${params.length}::jsonb`);
    }

    params.push(Math.max(0, k));
    const limitParam = `$${params.length}`;

    // `<=>` is pgvector's cosine-distance operator (0 = identical). We convert
    // distance to a [0, 1] similarity score (1 = identical) for callers.
    const result = await this.sql.query(
      `SELECT id, owner_type, owner_id, metadata,
              1 - (embedding <=> $1::vector) AS score
       FROM ${this.table}
       WHERE ${conditions.join(' AND ')}
       ORDER BY embedding <=> $1::vector ASC
       LIMIT ${limitParam}`,
      params,
    );

    return result.rows.map((row) => this.rowToMatch(row));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.sql.query(`DELETE FROM ${this.table} WHERE id = ANY($1)`, [ids]);
  }

  private rowToMatch(row: SqlRow): VectorMatch {
    const rawMetadata = row.metadata;
    const metadata: Record<string, unknown> =
      typeof rawMetadata === 'string'
        ? (JSON.parse(rawMetadata) as Record<string, unknown>)
        : ((rawMetadata as Record<string, unknown> | null) ?? {});
    return {
      id: String(row.id),
      ownerType: row.owner_type as VectorOwnerType,
      ownerId: String(row.owner_id),
      score: Number(row.score),
      metadata,
    };
  }
}
