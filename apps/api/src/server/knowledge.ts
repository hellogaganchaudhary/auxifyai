/**
 * The knowledge / collaboration layer wired onto the live server.
 *
 * This turns the previously-unwired REST groups into working features backed by
 * PostgreSQL + pgvector:
 *   - knowledge-base : connect text sources, embed them, semantic search (RAG)
 *   - knowledge-hub  : author pages that become searchable knowledge
 *   - documents      : store documents, embed them, manage them
 *   - messaging      : team channels + messages
 *   - unified-search : one query across knowledge + conversations
 *   - analytics      : token/cost usage aggregated per model
 *   - administration : activity feed + key/model governance views
 *
 * Ingested text is chunked, embedded (1536-dim, Azure), and upserted into the
 * Vector_Store with the chunk text in metadata, so retrieval needs no second
 * round-trip. A {@link KnowledgeRetriever} exposes the same search to the chat
 * path so answers can be grounded in the organization's own knowledge.
 */

import { PgVectorStore, type SqlClient, type VectorOwnerType, type VectorRecord } from '@auxify/core';
import type { Result } from '@auxify/types';
import { randomUUID } from 'node:crypto';

import type { ResourceController, RouteHandlerContext } from '../rest/index';
import type { EmbedTexts } from './embeddings-client';

/** A retrieved knowledge snippet (for RAG grounding and search results). */
export interface KnowledgeHit {
  /** The chunk text. */
  text: string;
  /** The human-readable source title. */
  title: string;
  /** The kind of source (document, knowledge_chunk, knowledge_page, …). */
  kind: string;
  /** Similarity score in [0,1]. */
  score: number;
}

/** Retrieve organization knowledge relevant to a query (for chat grounding). */
export interface KnowledgeRetriever {
  retrieve(organizationId: string, query: string, k?: number): Promise<KnowledgeHit[]>;
}

/** Dependencies the knowledge layer needs. */
export interface KnowledgeDeps {
  sql: SqlClient;
  /** The pgvector store, or `null` when pgvector is unavailable (RAG disabled). */
  vectors: PgVectorStore | null;
  /** Embeds text into 1536-dim vectors, or `null` when embeddings aren't configured. */
  embed: EmbedTexts | null;
}

/** A success result for a resource handler. */
function ok(body: unknown, status = 200): Result<{ body: unknown; status?: number }> {
  return { ok: true, value: { body, status } };
}

/** A short, unique id with a prefix (CSPRNG-backed; not guessable). */
function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** The org id for a request (dev default when unauthenticated). */
function orgOf(ctx: RouteHandlerContext): string {
  return ctx.auth?.tenant.organizationId ?? 'dev-org';
}

/** The user id for a request (dev default when unauthenticated). */
function userOf(ctx: RouteHandlerContext): string {
  return ctx.auth?.principal.userId ?? 'dev-user';
}

/** A plain record view of a request body. */
function bodyOf(ctx: RouteHandlerContext): Record<string, unknown> {
  return (typeof ctx.request.body === 'object' && ctx.request.body !== null
    ? ctx.request.body
    : {}) as Record<string, unknown>;
}

/**
 * Split text into embedding-friendly chunks (~1,200 chars, paragraph-aware,
 * hard-capped, and bounded in count so a huge upload can't run away on cost).
 */
function chunkText(text: string, maxChunks = 60): string[] {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) chunks.push(trimmed);
    current = '';
  };
  for (const para of paragraphs) {
    const p = para.trim();
    if (p.length === 0) continue;
    if (p.length > 2000) {
      flush();
      for (let i = 0; i < p.length; i += 1800) {
        chunks.push(p.slice(i, i + 1800));
        if (chunks.length >= maxChunks) return chunks.slice(0, maxChunks);
      }
      continue;
    }
    if (current.length + p.length > 1200) flush();
    current += (current.length > 0 ? '\n\n' : '') + p;
    if (chunks.length >= maxChunks) break;
  }
  flush();
  return chunks.slice(0, maxChunks);
}

/** Embed + upsert chunks of one entity into the Vector_Store. */
async function ingest(
  deps: KnowledgeDeps,
  args: {
    organizationId: string;
    ownerType: VectorOwnerType;
    ownerId: string;
    title: string;
    text: string;
    kind: string;
  },
): Promise<number> {
  if (deps.embed === null || deps.vectors === null) return 0;
  const chunks = chunkText(args.text);
  if (chunks.length === 0) return 0;
  const embeddings = await deps.embed(chunks);
  const records: VectorRecord[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const embedding = embeddings[i];
    if (embedding === undefined || embedding.length === 0) continue;
    records.push({
      id: `${args.ownerId}::${i}`,
      organizationId: args.organizationId,
      ownerType: args.ownerType,
      ownerId: args.ownerId,
      embedding,
      metadata: {
        text: chunks[i],
        title: args.title,
        kind: args.kind,
        sourceId: args.ownerId,
        chunkIndex: i,
      },
    });
  }
  if (records.length > 0) {
    await deps.vectors.upsert(records);
  }
  return records.length;
}

/** Run a tenant-scoped semantic search and map matches to {@link KnowledgeHit}s. */
async function semanticSearch(
  deps: KnowledgeDeps,
  organizationId: string,
  query: string,
  k: number,
  ownerType?: VectorOwnerType | VectorOwnerType[],
): Promise<KnowledgeHit[]> {
  if (deps.embed === null || deps.vectors === null || query.trim().length === 0) return [];
  const [embedding] = await deps.embed([query]);
  if (embedding === undefined || embedding.length === 0) return [];
  const matches = await deps.vectors.query(
    embedding,
    { organizationId, ...(ownerType !== undefined ? { ownerType } : {}) },
    k,
  );
  return matches.map((m) => ({
    text: typeof m.metadata.text === 'string' ? m.metadata.text : '',
    title: typeof m.metadata.title === 'string' ? m.metadata.title : 'Untitled',
    kind: typeof m.metadata.kind === 'string' ? m.metadata.kind : m.ownerType,
    score: m.score,
  }));
}

/** Build the {@link KnowledgeRetriever} the chat path uses for RAG grounding. */
export function buildKnowledgeRetriever(deps: KnowledgeDeps): KnowledgeRetriever {
  return {
    async retrieve(organizationId, query, k = 5): Promise<KnowledgeHit[]> {
      try {
        const hits = await semanticSearch(deps, organizationId, query, k, [
          'knowledge_chunk',
          'knowledge_page',
          'document',
          'file_chunk',
        ]);
        // Keep only reasonably relevant hits so weak matches don't add noise.
        return hits.filter((h) => h.score >= 0.2 && h.text.length > 0);
      } catch {
        return [];
      }
    },
  };
}

/** The message shown when a feature needs embeddings that aren't configured. */
const NO_EMBED =
  'Knowledge features need an embedding deployment. Set AZURE_OPENAI_DEPLOYMENT_EMBEDDING ' +
  '(text-embedding-3-large) with the Azure endpoint/key.';

/**
 * Build every knowledge / collaboration controller, keyed by REST resource
 * group. Wired into the composition only when a database + vector store exist.
 */
export function buildKnowledgeControllers(
  deps: KnowledgeDeps,
): Partial<Record<string, ResourceController>> {
  const { sql } = deps;

  // --- knowledge-base -------------------------------------------------------
  const knowledgeBase: ResourceController = {
    listSources: async (ctx) => {
      const org = orgOf(ctx);
      const { rows } = await sql.query(
        `SELECT id, name, kind, status, chunk_count, created_at
         FROM knowledge_sources WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [org],
      );
      return ok({ sources: rows });
    },
    connectSource: async (ctx) => {
      if (deps.embed === null || deps.vectors === null) return ok({ error: NO_EMBED }, 503);
      const body = bodyOf(ctx);
      const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : 'Untitled source';
      const text = typeof body.text === 'string' ? body.text : typeof body.content === 'string' ? body.content : '';
      if (text.trim().length === 0) return ok({ error: 'text is required' }, 400);
      const org = orgOf(ctx);
      const id = newId('src');
      const chunks = await ingest(deps, {
        organizationId: org,
        ownerType: 'knowledge_chunk',
        ownerId: id,
        title: name,
        text,
        kind: 'knowledge',
      });
      await sql.query(
        `INSERT INTO knowledge_sources (id, organization_id, owner_id, name, kind, status, chunk_count)
         VALUES ($1, $2, $3, $4, 'text', 'ready', $5)`,
        [id, org, userOf(ctx), name, chunks],
      );
      return ok({ id, name, chunkCount: chunks }, 201);
    },
    search: async (ctx) => {
      const body = bodyOf(ctx);
      const query = typeof body.query === 'string' ? body.query : '';
      if (query.trim().length === 0) return ok({ error: 'query is required' }, 400);
      if (deps.embed === null || deps.vectors === null) return ok({ error: NO_EMBED, results: [] }, 503);
      const limit = typeof body.limit === 'number' ? Math.min(body.limit, 20) : 8;
      const results = await semanticSearch(deps, orgOf(ctx), query, limit);
      return ok({ results });
    },
    // Return the ENTIRE knowledge base — every source's full text, reconstructed
    // from its chunks in order — so a caller can feed all of it to the model
    // (bounded by a character budget so it can fit the target context window).
    fetchAll: async (ctx) => {
      if (deps.vectors === null) return ok({ error: NO_EMBED, sources: [] }, 503);
      const body = bodyOf(ctx);
      const maxChars =
        typeof body.maxChars === 'number' && body.maxChars > 0
          ? Math.min(body.maxChars, 4_000_000)
          : 400_000;
      const org = orgOf(ctx);
      const { rows } = await sql.query(
        `SELECT owner_id,
                metadata->>'title' AS title,
                metadata->>'kind'  AS kind,
                metadata->>'text'  AS text,
                COALESCE((metadata->>'chunkIndex')::int, 0) AS chunk_index
         FROM vector_records
         WHERE organization_id = $1
           AND owner_type = ANY($2)
         ORDER BY owner_id, chunk_index`,
        [org, ['knowledge_chunk', 'knowledge_page', 'document', 'file_chunk']],
      );

      // Reconstruct each source by concatenating its chunks in order, stopping
      // once the character budget is exhausted (so the result fits the context).
      const bySource = new Map<string, { title: string; kind: string; text: string }>();
      let totalChars = 0;
      let truncated = false;
      let chunkCount = 0;
      for (const row of rows) {
        const ownerId = String(row.owner_id);
        const text = typeof row.text === 'string' ? row.text : '';
        if (text.length === 0) continue;
        chunkCount += 1;
        if (totalChars >= maxChars) {
          truncated = true;
          continue;
        }
        const slice = text.slice(0, Math.max(0, maxChars - totalChars));
        if (slice.length < text.length) truncated = true;
        totalChars += slice.length;
        const existing = bySource.get(ownerId);
        if (existing === undefined) {
          bySource.set(ownerId, {
            title: typeof row.title === 'string' && row.title.length > 0 ? row.title : 'Untitled',
            kind: typeof row.kind === 'string' ? row.kind : 'knowledge',
            text: slice,
          });
        } else {
          existing.text += `\n\n${slice}`;
        }
      }

      const sources = [...bySource.values()];
      return ok({ sources, sourceCount: sources.length, chunkCount, totalChars, truncated });
    },
  };

  // --- knowledge-hub --------------------------------------------------------
  const knowledgeHub: ResourceController = {
    listPages: async (ctx) => {
      const { rows } = await sql.query(
        `SELECT id, title, created_at, updated_at FROM knowledge_pages
         WHERE organization_id = $1 ORDER BY updated_at DESC LIMIT 200`,
        [orgOf(ctx)],
      );
      return ok({ pages: rows });
    },
    createPage: async (ctx) => {
      const body = bodyOf(ctx);
      const title = typeof body.title === 'string' && body.title.length > 0 ? body.title : 'Untitled page';
      const pageBody = typeof body.body === 'string' ? body.body : typeof body.content === 'string' ? body.content : '';
      const org = orgOf(ctx);
      const id = newId('page');
      await sql.query(
        `INSERT INTO knowledge_pages (id, organization_id, owner_id, title, body)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, org, userOf(ctx), title, pageBody],
      );
      if (deps.embed !== null && pageBody.trim().length > 0) {
        await ingest(deps, {
          organizationId: org,
          ownerType: 'knowledge_page',
          ownerId: id,
          title,
          text: pageBody,
          kind: 'page',
        });
      }
      return ok({ id, title }, 201);
    },
    getPage: async (ctx) => {
      const id = ctx.params.pageId ?? '';
      const { rows } = await sql.query(
        `SELECT id, title, body, created_at, updated_at FROM knowledge_pages
         WHERE organization_id = $1 AND id = $2`,
        [orgOf(ctx), id],
      );
      if (rows.length === 0) return ok({ error: 'page not found' }, 404);
      return ok(rows[0]);
    },
  };

  // --- documents ------------------------------------------------------------
  const documents: ResourceController = {
    list: async (ctx) => {
      const { rows } = await sql.query(
        `SELECT id, title, mime_type, chunk_count, created_at, updated_at FROM documents
         WHERE organization_id = $1 ORDER BY updated_at DESC LIMIT 200`,
        [orgOf(ctx)],
      );
      return ok({ documents: rows });
    },
    create: async (ctx) => {
      const body = bodyOf(ctx);
      const title = typeof body.title === 'string' && body.title.length > 0 ? body.title : 'Untitled document';
      const content = typeof body.content === 'string' ? body.content : typeof body.text === 'string' ? body.text : '';
      const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'text/plain';
      const org = orgOf(ctx);
      const id = newId('doc');
      let chunks = 0;
      if (deps.embed !== null && content.trim().length > 0) {
        chunks = await ingest(deps, {
          organizationId: org,
          ownerType: 'document',
          ownerId: id,
          title,
          text: content,
          kind: 'document',
        });
      }
      await sql.query(
        `INSERT INTO documents (id, organization_id, owner_id, title, content, mime_type, chunk_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, org, userOf(ctx), title, content, mimeType, chunks],
      );
      return ok({ id, title, chunkCount: chunks }, 201);
    },
    get: async (ctx) => {
      const id = ctx.params.documentId ?? '';
      const { rows } = await sql.query(
        `SELECT id, title, content, mime_type, chunk_count, created_at, updated_at FROM documents
         WHERE organization_id = $1 AND id = $2`,
        [orgOf(ctx), id],
      );
      if (rows.length === 0) return ok({ error: 'document not found' }, 404);
      return ok(rows[0]);
    },
    update: async (ctx) => {
      const id = ctx.params.documentId ?? '';
      const body = bodyOf(ctx);
      const title = typeof body.title === 'string' ? body.title : undefined;
      const content = typeof body.content === 'string' ? body.content : undefined;
      const org = orgOf(ctx);
      const { rows } = await sql.query(
        `UPDATE documents SET
           title = COALESCE($3, title),
           content = COALESCE($4, content),
           updated_at = now()
         WHERE organization_id = $1 AND id = $2 RETURNING id, title`,
        [org, id, title ?? null, content ?? null],
      );
      if (rows.length === 0) return ok({ error: 'document not found' }, 404);
      // Re-embed when the content changed.
      if (deps.embed !== null && deps.vectors !== null && content !== undefined && content.trim().length > 0) {
        await deps.vectors.delete([...Array(60).keys()].map((i) => `${id}::${i}`));
        await ingest(deps, {
          organizationId: org,
          ownerType: 'document',
          ownerId: id,
          title: title ?? String((rows[0] as Record<string, unknown>).title ?? ''),
          text: content,
          kind: 'document',
        });
      }
      return ok(rows[0]);
    },
    delete: async (ctx) => {
      const id = ctx.params.documentId ?? '';
      const org = orgOf(ctx);
      const { rows } = await sql.query(
        `DELETE FROM documents WHERE organization_id = $1 AND id = $2 RETURNING id`,
        [org, id],
      );
      if (deps.vectors !== null) {
        await deps.vectors.delete([...Array(60).keys()].map((i) => `${id}::${i}`));
      }
      return ok({ deleted: rows.length > 0 }, rows.length > 0 ? 200 : 404);
    },
  };

  // --- messaging ------------------------------------------------------------
  const messaging: ResourceController = {
    listChannels: async (ctx) => {
      const { rows } = await sql.query(
        `SELECT id, name, topic, created_at FROM channels
         WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [orgOf(ctx)],
      );
      return ok({ channels: rows });
    },
    createChannel: async (ctx) => {
      const body = bodyOf(ctx);
      const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : 'general';
      const topic = typeof body.topic === 'string' ? body.topic : '';
      const id = newId('chan');
      await sql.query(
        `INSERT INTO channels (id, organization_id, owner_id, name, topic) VALUES ($1, $2, $3, $4, $5)`,
        [id, orgOf(ctx), userOf(ctx), name, topic],
      );
      return ok({ id, name, topic }, 201);
    },
    listMessages: async (ctx) => {
      const channelId = ctx.params.channelId ?? '';
      const { rows } = await sql.query(
        `SELECT id, channel_id, author_id, body, created_at FROM channel_messages
         WHERE organization_id = $1 AND channel_id = $2 ORDER BY created_at ASC LIMIT 500`,
        [orgOf(ctx), channelId],
      );
      return ok({ messages: rows });
    },
    postMessage: async (ctx) => {
      const channelId = ctx.params.channelId ?? '';
      const body = bodyOf(ctx);
      const text = typeof body.body === 'string' ? body.body : typeof body.text === 'string' ? body.text : '';
      if (text.trim().length === 0) return ok({ error: 'body is required' }, 400);
      const id = newId('cmsg');
      const { rows } = await sql.query(
        `INSERT INTO channel_messages (id, channel_id, organization_id, author_id, body)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, channel_id, author_id, body, created_at`,
        [id, channelId, orgOf(ctx), userOf(ctx), text],
      );
      return ok(rows[0], 201);
    },
  };

  // --- unified-search -------------------------------------------------------
  const unifiedSearch: ResourceController = {
    search: async (ctx) => {
      const body = bodyOf(ctx);
      const query = typeof body.query === 'string' ? body.query : '';
      if (query.trim().length === 0) return ok({ error: 'query is required' }, 400);
      const org = orgOf(ctx);
      const knowledge = deps.embed !== null ? await semanticSearch(deps, org, query, 8) : [];
      // Keyword match across conversation titles (cheap, always available).
      const { rows: convs } = await sql.query(
        `SELECT id, title, updated_at FROM conversations
         WHERE organization_id = $1 AND title ILIKE $2 ORDER BY updated_at DESC LIMIT 10`,
        [org, `%${query}%`],
      );
      return ok({ knowledge, conversations: convs });
    },
  };

  // --- analytics ------------------------------------------------------------
  const analytics: ResourceController = {
    usage: async (ctx) => {
      const org = orgOf(ctx);
      const { rows } = await sql.query(
        `SELECT m.model AS model,
                COUNT(*) AS requests,
                COALESCE(SUM(m.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(m.cost), 0) AS cost
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.organization_id = $1 AND m.role = 'assistant' AND m.model IS NOT NULL
         GROUP BY m.model ORDER BY cost DESC`,
        [org],
      );
      const byModel = rows.map((r) => ({
        model: String(r.model ?? ''),
        requests: Number(r.requests ?? 0),
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        cost: Number(r.cost ?? 0),
      }));
      const totals = byModel.reduce(
        (acc, r) => ({
          requests: acc.requests + r.requests,
          inputTokens: acc.inputTokens + r.inputTokens,
          outputTokens: acc.outputTokens + r.outputTokens,
          cost: acc.cost + r.cost,
        }),
        { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
      );
      return ok({ totals, byModel });
    },
    report: async (ctx) => {
      const org = orgOf(ctx);
      const { rows: counts } = await sql.query(
        `SELECT
           (SELECT COUNT(*) FROM conversations WHERE organization_id = $1) AS conversations,
           (SELECT COUNT(*) FROM documents WHERE organization_id = $1) AS documents,
           (SELECT COUNT(*) FROM knowledge_pages WHERE organization_id = $1) AS pages,
           (SELECT COUNT(*) FROM knowledge_sources WHERE organization_id = $1) AS sources,
           (SELECT COUNT(*) FROM channels WHERE organization_id = $1) AS channels`,
        [org],
      );
      return ok({ generatedAt: new Date().toISOString(), counts: counts[0] ?? {} });
    },
  };

  // --- administration -------------------------------------------------------
  const administration: ResourceController = {
    auditLogs: async (ctx) => {
      const org = orgOf(ctx);
      const { rows } = await sql.query(
        `SELECT m.id, m.model, m.cost, m.created_at, c.owner_id
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.organization_id = $1 AND m.role = 'assistant'
         ORDER BY m.created_at DESC LIMIT 100`,
        [org],
      );
      const logs = rows.map((r) => ({
        id: String(r.id ?? ''),
        actor: String(r.owner_id ?? 'dev-user'),
        action: 'chat.completion',
        model: String(r.model ?? ''),
        cost: Number(r.cost ?? 0),
        at: r.created_at,
      }));
      return ok({ logs });
    },
    listApiKeys: async () =>
      ok({
        keys: [
          {
            id: 'dev-key',
            name: 'Local dev key',
            prefix: 'dev',
            masked: 'dev…',
            active: true,
          },
        ],
        note: 'Per-user API key issuance is disabled in this deployment.',
      }),
    createApiKey: async () =>
      ok({ error: 'API key issuance is disabled in this deployment.' }, 501),
  };

  return {
    'knowledge-base': knowledgeBase,
    'knowledge-hub': knowledgeHub,
    documents,
    messaging,
    'unified-search': unifiedSearch,
    analytics,
    administration,
  };
}
