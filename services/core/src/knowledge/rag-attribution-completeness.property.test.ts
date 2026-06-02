/**
 * Property-based test for RAG source-attribution completeness.
 *
 * Feature: auxify-ai-platform, Property 32: RAG attribution completeness.
 *
 * Design statement (Property 32): "For any set of candidate chunks, a chunk is
 * injected into the model context only if it carries complete source
 * attribution (source identifier, source title, location within the source, and
 * a link), and every chunk that is injected carries all four attribution
 * fields."
 *
 * Validates: Requirements 24.4, 24.6
 *
 * The test drives the real {@link RagRetriever} (task 12.5) over arbitrary
 * populations of `knowledge_chunk` Vector_Store records whose source
 * attribution is randomly complete or partial — one or more of `sourceId`,
 * `sourceTitle`, `location`, and `link` may be blank, whitespace-only,
 * non-string, or dropped, or the attribution object may be `null`, a
 * non-object, or omitted entirely. To isolate the attribution gate as the only
 * filter under test, every record uses the requesting principal's Organization,
 * an allow-all authorizer keeps the access filter open (Req 24.3), a `0`
 * relevance threshold keeps the threshold filter open (Req 24.7), and a top-K
 * far larger than any generated population keeps the top-K cut open (Req 24.2).
 * The remaining behaviour is therefore exactly the attribution gate.
 *
 * The expected outcome is computed by an independent oracle ({@link oracleIncluded})
 * that re-derives "complete attribution" straight from each record's stored
 * metadata without calling the production `hasCompleteAttribution`, so the test
 * cannot tautologically agree with the implementation it checks. For every
 * generated population the test asserts:
 *
 *   1. the set of returned chunk ids equals exactly the set of records whose
 *      attribution is complete (Req 24.4, 24.6);
 *   2. every returned chunk carries all four attribution fields, each a
 *      non-empty (non-whitespace) string (Req 24.4);
 *   3. no record with incomplete attribution is ever returned (Req 24.6);
 *   4. when no record has complete attribution the retriever reports no context
 *      with the explicit "no relevant knowledge found" signal.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Principal } from '@auxify/types';

import { DeterministicEmbedder } from '../file-processor/fakes.js';
import { EMBEDDING_DIMENSIONS, InMemoryVectorStore, type VectorRecord } from '../storage/index.js';

import { AllowAllChunkAuthorizer } from './fakes.js';
import { RagRetriever } from './rag-retriever.js';
import { NO_RELEVANT_KNOWLEDGE_MESSAGE } from './rag-types.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 150;

/** A top-K / candidate pool far larger than any generated population, so neither truncates. */
const UNBOUNDED = 10_000;

/** The four attribution fields the completeness gate requires (Req 24.4, 24.6). */
const ATTR_FIELDS = ['sourceId', 'sourceTitle', 'location', 'link'] as const;
type AttrField = (typeof ATTR_FIELDS)[number];

/**
 * How a single attribution field is materialized in a record's metadata. Only
 * `valid` yields a non-empty string; every other outcome makes the field fail
 * the completeness gate (Req 24.6).
 */
type FieldOutcome =
  | { tag: 'valid'; value: string }
  | { tag: 'empty' } // present but the empty string
  | { tag: 'whitespace' } // present but whitespace-only (must trim to empty)
  | { tag: 'missing' } // key absent from the attribution object
  | { tag: 'nonstring' }; // present but not a string

/** How the `attribution` value itself is materialized in a record's metadata. */
type AttributionSpec =
  | { variant: 'object'; fields: Record<AttrField, FieldOutcome> }
  | { variant: 'omit' } // no `attribution` key at all
  | { variant: 'null' } // `attribution: null`
  | { variant: 'nonobject' }; // `attribution` is not an object

/** A generated `knowledge_chunk` record spec (its id/owner are assigned by index). */
interface RecordSpec {
  /** The chunk text stored in metadata (always a valid string; not part of the gate). */
  text: string;
  /** The embedding fill value; only affects scoring, never the attribution gate. */
  embeddingValue: number;
  /** How this record's source attribution is materialized. */
  attribution: AttributionSpec;
}

/** A non-empty, non-whitespace field value (the `x` prefix survives trimming). */
const validFieldArb: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 8 })
  .map((s) => `x${s}`);

/**
 * A single field outcome, biased toward `valid` so complete records occur often
 * enough to exercise the inclusion path, while every incomplete shape still
 * appears regularly.
 */
const fieldOutcomeArb: fc.Arbitrary<FieldOutcome> = fc.oneof(
  { weight: 5, arbitrary: validFieldArb.map((value) => ({ tag: 'valid', value }) as FieldOutcome) },
  { weight: 1, arbitrary: fc.constant<FieldOutcome>({ tag: 'empty' }) },
  { weight: 1, arbitrary: fc.constant<FieldOutcome>({ tag: 'whitespace' }) },
  { weight: 1, arbitrary: fc.constant<FieldOutcome>({ tag: 'missing' }) },
  { weight: 1, arbitrary: fc.constant<FieldOutcome>({ tag: 'nonstring' }) },
);

/** The attribution shape, biased toward a populated object so both paths are exercised. */
const attributionArb: fc.Arbitrary<AttributionSpec> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .record({
        sourceId: fieldOutcomeArb,
        sourceTitle: fieldOutcomeArb,
        location: fieldOutcomeArb,
        link: fieldOutcomeArb,
      })
      .map((fields) => ({ variant: 'object', fields }) as AttributionSpec),
  },
  { weight: 1, arbitrary: fc.constant<AttributionSpec>({ variant: 'omit' }) },
  { weight: 1, arbitrary: fc.constant<AttributionSpec>({ variant: 'null' }) },
  { weight: 1, arbitrary: fc.constant<AttributionSpec>({ variant: 'nonobject' }) },
);

const recordSpecArb: fc.Arbitrary<RecordSpec> = fc.record({
  text: fc.string({ minLength: 0, maxLength: 40 }),
  embeddingValue: fc.integer({ min: 0, max: 100 }).map((n) => n / 100),
  attribution: attributionArb,
});

/** A scenario: an Organization, a querying user, a query, and a population of records. */
const scenarioArb = fc.record({
  organizationId: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `org-${s}`),
  userId: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `usr-${s}`),
  query: fc.string({ minLength: 0, maxLength: 40 }),
  records: fc.array(recordSpecArb, { minLength: 1, maxLength: 12 }),
});

/** A constant 1536-dim embedding filled with `value`, satisfying the Vector_Store contract. */
function vec(value: number): number[] {
  return new Array<number>(EMBEDDING_DIMENSIONS).fill(value);
}

/** Materialize a single attribution field into the attribution object under construction. */
function applyField(target: Record<string, unknown>, key: AttrField, outcome: FieldOutcome): void {
  switch (outcome.tag) {
    case 'valid':
      target[key] = outcome.value;
      break;
    case 'empty':
      target[key] = '';
      break;
    case 'whitespace':
      target[key] = '   ';
      break;
    case 'nonstring':
      target[key] = 42;
      break;
    case 'missing':
      // Leave the key absent.
      break;
  }
}

/**
 * Build the metadata stored on a `knowledge_chunk` record. `sourceId`,
 * `documentId`, `ordinal`, and `text` are always well-formed so the only
 * variable under test is the `attribution` value.
 */
function buildMetadata(spec: RecordSpec, index: number): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    sourceId: `src-${index}`,
    documentId: `doc-${index}`,
    ordinal: index,
    text: spec.text,
  };
  switch (spec.attribution.variant) {
    case 'object': {
      const attr: Record<string, unknown> = {};
      for (const field of ATTR_FIELDS) {
        applyField(attr, field, spec.attribution.fields[field]);
      }
      metadata['attribution'] = attr;
      break;
    }
    case 'null':
      metadata['attribution'] = null;
      break;
    case 'nonobject':
      metadata['attribution'] = 'not-an-object';
      break;
    case 'omit':
      // No `attribution` key.
      break;
  }
  return metadata;
}

/**
 * Independent oracle: decide, straight from a record's stored metadata, whether
 * the record carries complete source attribution and must therefore be the only
 * kind of chunk the retriever may return (Req 24.4, 24.6).
 *
 * This deliberately re-implements the completeness rule (a non-null attribution
 * object with four non-empty, non-whitespace string fields) rather than calling
 * the production `hasCompleteAttribution`, so the property is an independent
 * check of the retriever's behaviour.
 */
function oracleIncluded(metadata: Record<string, unknown>): boolean {
  const attribution = metadata['attribution'];
  if (typeof attribution !== 'object' || attribution === null) {
    return false;
  }
  const attr = attribution as Record<string, unknown>;
  const nonEmpty = (value: unknown): boolean =>
    typeof value === 'string' && value.trim().length > 0;
  return ATTR_FIELDS.every((field) => nonEmpty(attr[field]));
}

/** Build a principal in the given Organization. */
function makePrincipal(organizationId: string, userId: string): Principal {
  return {
    userId,
    organizationId,
    roles: ['standard_user'],
    teamIds: [],
    projectIds: [],
    allowedModels: [],
    premiumAuthorized: false,
  };
}

describe('Feature: auxify-ai-platform, Property 32: RAG attribution completeness', () => {
  it('returns exactly the chunks with complete attribution, each carrying all four fields, and never an incomplete one', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const vectors = new InMemoryVectorStore();
        const retriever = new RagRetriever({
          embedder: new DeterministicEmbedder(),
          vectorStore: vectors,
          authorizer: new AllowAllChunkAuthorizer(),
          // Open every other filter so the attribution gate is the only one acting:
          defaultRelevanceThreshold: 0, // threshold never excludes (Req 24.7 disabled)
          defaultTopK: UNBOUNDED, // top-K never truncates (Req 24.2 disabled)
          defaultCandidateLimit: UNBOUNDED, // the full population is always considered
        });

        const records: VectorRecord[] = scenario.records.map((spec, index) => ({
          id: `c-${index}`,
          organizationId: scenario.organizationId,
          ownerType: 'knowledge_chunk',
          ownerId: `doc-${index}`,
          embedding: vec(spec.embeddingValue),
          metadata: buildMetadata(spec, index),
        }));
        await vectors.upsert(records);

        const principal = makePrincipal(scenario.organizationId, scenario.userId);
        const result = await retriever.retrieve(scenario.query, principal);

        const expectedIds = new Set(
          records.filter((r) => oracleIncluded(r.metadata)).map((r) => r.id),
        );
        const incompleteIds = new Set(
          records.filter((r) => !oracleIncluded(r.metadata)).map((r) => r.id),
        );
        const returnedIds = new Set(result.chunks.map((chunk) => chunk.chunkId));

        // (1) The returned set is exactly the set of completely-attributed chunks.
        expect(returnedIds).toEqual(expectedIds);

        // (2) Every returned chunk carries all four attribution fields, each non-empty.
        for (const chunk of result.chunks) {
          expect(typeof chunk.attribution.sourceId).toBe('string');
          expect(chunk.attribution.sourceId.trim().length).toBeGreaterThan(0);
          expect(typeof chunk.attribution.sourceTitle).toBe('string');
          expect(chunk.attribution.sourceTitle.trim().length).toBeGreaterThan(0);
          expect(typeof chunk.attribution.location).toBe('string');
          expect(chunk.attribution.location.trim().length).toBeGreaterThan(0);
          expect(typeof chunk.attribution.link).toBe('string');
          expect(chunk.attribution.link.trim().length).toBeGreaterThan(0);
        }

        // (3) No chunk with incomplete attribution is ever returned.
        for (const id of returnedIds) {
          expect(incompleteIds.has(id)).toBe(false);
        }

        // (4) When nothing is completely attributed, the retriever signals no context.
        if (expectedIds.size === 0) {
          expect(result.found).toBe(false);
          expect(result.chunks).toHaveLength(0);
          expect(result.message).toBe(NO_RELEVANT_KNOWLEDGE_MESSAGE);
        } else {
          expect(result.found).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
