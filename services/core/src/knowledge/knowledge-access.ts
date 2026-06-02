/**
 * The collection access model and the production {@link ChunkAuthorizer} that
 * composes it (Req 25.2, 24.3).
 *
 * Req 25.2 requires retrieval from a collection to be restricted to members of
 * the Teams and Projects permitted to access it. The RAG_Retriever enforces
 * that restriction through the injectable
 * {@link import('./rag-types.js').ChunkAuthorizer} port (Req 24.3); this module
 * supplies the concrete authorizer the platform wires in, built from the
 * Knowledge_Manager's access lists:
 *
 *  - {@link principalCanAccessCollection} is the pure access predicate — a
 *    {@link Principal} may retrieve from a collection iff it is in the same
 *    Organization (Req 1.2) and is a member of one of the collection's permitted
 *    Teams/Projects *or* of the collection's owning Team/Project (the owner
 *    always retains access);
 *  - {@link CollectionScopedChunkAuthorizer} maps a candidate
 *    {@link import('./rag-types.js').RetrievableChunk} to its owning collection
 *    through the tenant-scoped {@link KnowledgeCollectionStore} and applies that
 *    predicate, so a chunk from a collection the principal cannot access is
 *    excluded from the retrieved context (Req 24.3, 25.2). A chunk whose source
 *    or collection cannot be resolved is denied (fail-closed).
 *
 * The pure predicate is independently unit-testable, and the authorizer depends
 * only on the narrow store port so it composes cleanly with the in-memory fakes.
 */

import type { Principal } from '@auxify/types';

import { tenantContextFromPrincipal } from '@auxify/types';

import type { KnowledgeCollection, KnowledgeCollectionStore } from './knowledge-manager-types.js';
import type { ChunkAuthorizer, RetrievableChunk } from './rag-types.js';

/**
 * True iff `principal` may retrieve from `collection` (Req 25.2).
 *
 * The decision is fail-closed and composes three checks:
 *
 *  1. tenant isolation (Req 1.2) — the principal and collection must belong to
 *     the same Organization; a cross-tenant principal is always denied;
 *  2. explicit access lists (Req 25.2) — the principal is a member of one of the
 *     collection's {@link KnowledgeCollection.allowedTeams} or
 *     {@link KnowledgeCollection.allowedProjects};
 *  3. ownership — the principal is a member of the collection's owning Team or
 *     Project, so the owner always retains access even with empty access lists.
 *
 * @param principal The authenticated actor issuing the query.
 * @param collection The collection under consideration.
 * @returns `true` to grant access, `false` to deny.
 */
export function principalCanAccessCollection(
  principal: Principal,
  collection: KnowledgeCollection,
): boolean {
  // (Req 1.2) Tenant isolation: never grant across an Organization boundary.
  if (principal.organizationId !== collection.organizationId) {
    return false;
  }

  const teamIds = new Set(principal.teamIds);
  const projectIds = new Set(principal.projectIds);

  // (Req 25.2) Explicit access lists.
  if (collection.allowedTeams.some((teamId) => teamIds.has(teamId))) {
    return true;
  }
  if (collection.allowedProjects.some((projectId) => projectIds.has(projectId))) {
    return true;
  }

  // Ownership: the owning Team/Project always retains access.
  if (collection.ownerScope === 'team' && teamIds.has(collection.ownerScopeId)) {
    return true;
  }
  if (collection.ownerScope === 'project' && projectIds.has(collection.ownerScopeId)) {
    return true;
  }

  return false;
}

/**
 * The production {@link ChunkAuthorizer} that gates each retrieved chunk by the
 * Knowledge_Manager's collection access model (Req 24.3, 25.2).
 *
 * For each candidate chunk it resolves the chunk's source to its owning
 * collection through the tenant-scoped {@link KnowledgeCollectionStore} and
 * applies {@link principalCanAccessCollection}. A chunk whose source or
 * collection cannot be resolved — or that belongs to a collection the principal
 * may not access — is excluded (fail-closed). Per-query lookups are memoized by
 * source id so a collection is resolved at most once per retrieval.
 */
export class CollectionScopedChunkAuthorizer implements ChunkAuthorizer {
  private readonly store: KnowledgeCollectionStore;
  private readonly cache = new Map<string, KnowledgeCollection | null>();

  /** @param store The tenant-scoped collection store used to resolve a chunk's collection. */
  constructor(store: KnowledgeCollectionStore) {
    this.store = store;
  }

  /**
   * Decide whether `principal` may retrieve `chunk` (Req 24.3, 25.2).
   *
   * @param principal The authenticated actor issuing the query.
   * @param chunk The candidate chunk under consideration.
   * @returns `true` to keep the chunk, `false` to exclude it (fail-closed).
   */
  async authorize(principal: Principal, chunk: RetrievableChunk): Promise<boolean> {
    const collection = await this.resolveCollection(principal, chunk.sourceId);
    if (collection === null) {
      return false;
    }
    return principalCanAccessCollection(principal, collection);
  }

  /** Resolve (and memoize) the collection that owns `sourceId`, scoped to the principal. */
  private async resolveCollection(
    principal: Principal,
    sourceId: string,
  ): Promise<KnowledgeCollection | null> {
    const cached = this.cache.get(sourceId);
    if (cached !== undefined) {
      return cached;
    }
    const ctx = tenantContextFromPrincipal(principal);
    const collection = await this.store.getCollectionForSource(ctx, sourceId);
    this.cache.set(sourceId, collection);
    return collection;
  }
}
