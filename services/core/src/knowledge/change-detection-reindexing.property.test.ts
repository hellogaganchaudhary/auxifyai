/**
 * Property-based test for the Knowledge_Ingestion_Service's content-hash change
 * detection (Req 23.4, Property 29).
 *
 * Property 29 states: _for any_ source re-ingested after a subset of its
 * documents changed, the set of documents re-indexed equals exactly the set
 * whose content hash changed (plus any new documents); unchanged documents are
 * not re-indexed.
 *
 * The test ingests an arbitrary initial document set, then ingests an arbitrary
 * second set of edits (documents changed, unchanged, added, and removed), and
 * checks the run against an independent, content-based oracle:
 *
 *  - exactly the changed + added documents are re-indexed;
 *  - exactly the byte-identical documents are reported `unchanged` and are NOT
 *    re-embedded (the embedder records one batch per re-indexed document only);
 *  - the Vector_Store ends holding exactly the chunks of the documents now in
 *    the store — a changed document's prior-version vectors are replaced with no
 *    orphans left behind;
 *  - {@link KnowledgeIngestionService.detectChanges} partitions
 *    added/changed/unchanged/removed correctly without mutating any state.
 *
 * The oracle classifies purely by content equality (the same signal the SHA-256
 * {@link import('./content-hash.js').sha256ContentHasher} derives), so a random
 * "change" that happens to reproduce identical bytes is treated as unchanged by
 * both the oracle and the service — the property holds either way.
 *
 * The test is self-contained to the ingestion service + storage layer: it wires
 * the in-memory fakes and the spec-faithful {@link InMemoryVectorStore} only.
 */

import type { TenantContext } from '@auxify/types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DeterministicEmbedder } from '../file-processor/fakes.js';
import { EMBEDDING_DIMENSIONS, InMemoryVectorStore } from '../storage/index.js';

import {
  FakeSourceFetcher,
  InMemoryKnowledgeStore,
  MapSourceFetcherResolver,
} from './fakes.js';
import { KnowledgeIngestionService } from './knowledge-ingestion-service.js';
import type { FetchedDocument, KnowledgeIngestReport } from './types.js';

/** fast-check runs: ≥100 to broadly explore the change/unchanged/add/remove space. */
const NUM_RUNS = 200;

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };

/** A document the generator emits: a source-local id plus its parsed content. */
interface GenDoc {
  externalId: string;
  content: string;
}

/**
 * Content always has a non-whitespace `body:` prefix, so after the chunker's
 * whitespace normalization every document yields at least one chunk (hence
 * exactly one embedding batch when indexed). That lets the embed-call count be
 * an exact oracle for "re-indexed vs skipped".
 */
const contentArb = fc.string({ maxLength: 60 }).map((s) => `body:${s}`);

/** A source-local external id, drawn from a small space so collisions are possible. */
const externalIdArb = fc.string({ minLength: 1, maxLength: 5 }).map((s) => `ext-${s}`);

/** A set of documents with unique external ids. */
const docSetArb = (max: number): fc.Arbitrary<GenDoc[]> =>
  fc.uniqueArray(fc.record({ externalId: externalIdArb, content: contentArb }), {
    selector: (d) => d.externalId,
    minLength: 0,
    maxLength: max,
  });

/** The per-initial-document edit applied before the second ingest. */
type EditAction = 'keep' | 'change' | 'remove';

interface Scenario {
  initial: GenDoc[];
  /** One edit per initial document (same length, by index). */
  edits: Array<{ action: EditAction; newContent: string }>;
  /** Brand-new documents added in the second ingest (ids disjoint from `initial`). */
  added: GenDoc[];
}

const scenarioArb: fc.Arbitrary<Scenario> = docSetArb(6).chain((initial) => {
  const initialIds = new Set(initial.map((d) => d.externalId));
  return fc.record({
    initial: fc.constant(initial),
    edits: fc.array(
      fc.record({
        action: fc.constantFrom<EditAction>('keep', 'change', 'remove'),
        newContent: contentArb,
      }),
      { minLength: initial.length, maxLength: initial.length },
    ),
    // Keep only ids not already present so the second set has unique ids.
    added: docSetArb(4).map((docs) => docs.filter((d) => !initialIds.has(d.externalId))),
  });
});

/** Apply a {@link Scenario}'s edits to produce the second (current) document set. */
function buildSecondSet(scenario: Scenario): GenDoc[] {
  const second: GenDoc[] = [];
  scenario.initial.forEach((doc, i) => {
    const edit = scenario.edits[i]!;
    if (edit.action === 'remove') return;
    second.push({
      externalId: doc.externalId,
      content: edit.action === 'change' ? edit.newContent : doc.content,
    });
  });
  for (const doc of scenario.added) {
    second.push({ externalId: doc.externalId, content: doc.content });
  }
  return second;
}

/** Map a {@link GenDoc}[] to the {@link FetchedDocument}[] the fetcher returns. */
function toFetched(docs: GenDoc[]): FetchedDocument[] {
  return docs.map((d) => ({
    externalId: d.externalId,
    title: `Title ${d.externalId}`,
    content: d.content,
    location: `loc/${d.externalId}`,
    link: `https://src/${d.externalId}`,
  }));
}

interface Harness {
  service: KnowledgeIngestionService;
  store: InMemoryKnowledgeStore;
  fetcher: FakeSourceFetcher;
  embedder: DeterministicEmbedder;
  vectors: InMemoryVectorStore;
}

/** A fresh service wired to fresh fakes, with small chunks so re-index can shrink/grow. */
function makeHarness(): Harness {
  const store = new InMemoryKnowledgeStore();
  const fetcher = new FakeSourceFetcher();
  const resolver = new MapSourceFetcherResolver();
  const embedder = new DeterministicEmbedder();
  const vectors = new InMemoryVectorStore();
  resolver.register('upload', fetcher);
  const service = new KnowledgeIngestionService({
    store,
    fetchers: resolver,
    embedder,
    vectorStore: vectors,
    chunkOptions: { chunkSize: 20, overlap: 5 },
  });
  return { service, store, fetcher, embedder, vectors };
}

/** Collect every knowledge-chunk vector id currently in the store for the org. */
async function allVectorIds(vectors: InMemoryVectorStore): Promise<Set<string>> {
  const matches = await vectors.query(
    new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
    { organizationId: ctx.organizationId, ownerType: 'knowledge_chunk' },
    1_000_000,
  );
  return new Set(matches.map((m) => m.id));
}

/** The vector ids the report says were (re-)indexed, keyed by external id. */
function indexedVectorIdsByExternalId(report: KnowledgeIngestReport): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const doc of report.documents) {
    if (doc.status === 'indexed') {
      byId.set(doc.externalId, doc.vectorIds);
    }
  }
  return byId;
}

const asSet = (xs: Iterable<string>): Set<string> => new Set(xs);

describe('Feature: auxify-ai-platform, Property 29: Change detection re-indexes only changed documents', () => {
  it('re-indexes exactly the changed + added documents, skips byte-identical ones without re-embedding, and replaces prior vectors leaving no orphans (Validates: Requirements 23.4)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { service, store, fetcher, embedder, vectors } = makeHarness();
        const source = await service.connectSource(ctx, { collectionId: 'col-1', type: 'upload' });

        // --- First ingest: the whole initial set is new, so all are indexed ---
        fetcher.setDocuments(source.id, toFetched(scenario.initial));
        const firstReport = await service.ingest(ctx, source.id);
        const firstVectorIds = indexedVectorIdsByExternalId(firstReport);

        // Every initial document (non-empty content) is indexed on the first run.
        expect(firstReport.failedCount).toBe(0);
        expect(firstReport.indexedCount).toBe(scenario.initial.length);
        expect(firstReport.unchangedCount).toBe(0);

        // --- Independent, content-based oracle for the second ingest ----------
        const second = buildSecondSet(scenario);
        const firstByExt = new Map(scenario.initial.map((d) => [d.externalId, d.content]));
        const secondByExt = new Map(second.map((d) => [d.externalId, d.content]));

        const expectedAdded = [...secondByExt.keys()].filter((id) => !firstByExt.has(id));
        const expectedChanged = [...secondByExt.keys()].filter(
          (id) => firstByExt.has(id) && firstByExt.get(id) !== secondByExt.get(id),
        );
        const expectedUnchanged = [...secondByExt.keys()].filter(
          (id) => firstByExt.has(id) && firstByExt.get(id) === secondByExt.get(id),
        );
        const expectedRemoved = [...firstByExt.keys()].filter((id) => !secondByExt.has(id));

        fetcher.setDocuments(source.id, toFetched(second));

        // --- detectChanges: correct partition, and pure (no mutation) ----------
        const sizeBeforeDetect = vectors.size();
        const embedBeforeDetect = embedder.calls.length;
        const docsBeforeDetect = (await store.listDocuments(ctx, source.id))
          .map((d) => ({ externalId: d.externalId, contentHash: d.contentHash }))
          .sort((a, b) => a.externalId.localeCompare(b.externalId));

        const changes = await service.detectChanges(ctx, source.id);

        expect(asSet(changes.added)).toEqual(asSet(expectedAdded));
        expect(asSet(changes.changed)).toEqual(asSet(expectedChanged));
        expect(asSet(changes.unchanged)).toEqual(asSet(expectedUnchanged));
        expect(asSet(changes.removed)).toEqual(asSet(expectedRemoved));

        // detectChanges only hashes — it must not embed, index, or persist.
        expect(vectors.size()).toBe(sizeBeforeDetect);
        expect(embedder.calls.length).toBe(embedBeforeDetect);
        const docsAfterDetect = (await store.listDocuments(ctx, source.id))
          .map((d) => ({ externalId: d.externalId, contentHash: d.contentHash }))
          .sort((a, b) => a.externalId.localeCompare(b.externalId));
        expect(docsAfterDetect).toEqual(docsBeforeDetect);

        // --- Second ingest: re-index only changed + added ---------------------
        const embedBeforeSecond = embedder.calls.length;
        const secondReport = await service.ingest(ctx, source.id);

        const indexedSet = asSet(
          secondReport.documents.filter((d) => d.status === 'indexed').map((d) => d.externalId),
        );
        const unchangedSet = asSet(
          secondReport.documents.filter((d) => d.status === 'unchanged').map((d) => d.externalId),
        );

        expect(secondReport.failedCount).toBe(0);
        expect(indexedSet).toEqual(asSet([...expectedAdded, ...expectedChanged]));
        expect(unchangedSet).toEqual(asSet(expectedUnchanged));
        expect(secondReport.indexedCount).toBe(expectedAdded.length + expectedChanged.length);
        expect(secondReport.unchangedCount).toBe(expectedUnchanged.length);

        // Unchanged documents are NOT re-embedded: exactly one embed batch per
        // re-indexed (non-empty) document and none for the skipped ones.
        const embedBatchesInSecond = embedder.calls.length - embedBeforeSecond;
        expect(embedBatchesInSecond).toBe(expectedAdded.length + expectedChanged.length);

        // --- Vector store: exactly the current chunks, no orphans -------------
        // Expected = current vectors of re-indexed docs (from the second report)
        //          ∪ retained vectors of unchanged docs (untouched since ingest)
        //          ∪ retained vectors of removed docs (the service leaves these).
        const secondVectorIds = indexedVectorIdsByExternalId(secondReport);
        const expectedVectorIds = new Set<string>();
        for (const ids of secondVectorIds.values()) {
          for (const id of ids) expectedVectorIds.add(id);
        }
        for (const ext of [...expectedUnchanged, ...expectedRemoved]) {
          for (const id of firstVectorIds.get(ext) ?? []) expectedVectorIds.add(id);
        }

        expect(await allVectorIds(vectors)).toEqual(expectedVectorIds);
        // No stray vectors of any other kind/owner linger either.
        expect(vectors.size()).toBe(expectedVectorIds.size);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
