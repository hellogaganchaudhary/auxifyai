/**
 * Unit tests for the RAG_Retriever's pure ranking helpers (Req 24.1, 24.2,
 * 24.4, 24.6).
 *
 * These cover the deterministic math and the attribution gate in isolation:
 * tokenization, keyword scoring, the hybrid score combination, and the
 * complete-attribution predicate.
 */

import { describe, expect, it } from 'vitest';

import type { SourceAttribution } from '@auxify/types';

import { hasCompleteAttribution, hybridScore, keywordScore, tokenize } from './rag-ranking.js';

describe('tokenize (Req 24.1)', () => {
  it('lower-cases, splits on non-word characters, and de-duplicates', () => {
    expect(tokenize('Hello, WORLD! hello')).toEqual(new Set(['hello', 'world']));
  });

  it('returns an empty set for whitespace/punctuation only', () => {
    expect(tokenize('  ,.!? ')).toEqual(new Set());
  });
});

describe('keywordScore (Req 24.1)', () => {
  it('is the fraction of query terms present in the chunk', () => {
    // 2 of 2 query terms present.
    expect(keywordScore('alpha beta', 'alpha beta gamma')).toBe(1);
    // 1 of 2 query terms present.
    expect(keywordScore('alpha delta', 'alpha beta gamma')).toBe(0.5);
    // 0 of 2 present.
    expect(keywordScore('x y', 'alpha beta gamma')).toBe(0);
  });

  it('scores an empty query as zero', () => {
    expect(keywordScore('', 'any content')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(keywordScore('Kubernetes', 'kubernetes cluster')).toBe(1);
  });
});

describe('hybridScore (Req 24.1, 24.2)', () => {
  it('is the weight-normalized convex combination of the two scores', () => {
    expect(hybridScore(1, 0, 0.5, 0.5)).toBeCloseTo(0.5);
    expect(hybridScore(0.8, 0.4, 1, 1)).toBeCloseTo(0.6);
    expect(hybridScore(0.8, 0.4, 3, 1)).toBeCloseTo((3 * 0.8 + 0.4) / 4);
  });

  it('stays within [0, 1] when both inputs are in [0, 1]', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      for (const k of [0, 0.25, 0.5, 0.75, 1]) {
        const score = hybridScore(v, k, 0.5, 0.5);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('falls back to an even average when both weights are zero', () => {
    expect(hybridScore(0.6, 0.2, 0, 0)).toBeCloseTo(0.4);
  });
});

describe('hasCompleteAttribution (Req 24.4, 24.6)', () => {
  const complete: SourceAttribution = {
    sourceId: 'src-1',
    sourceTitle: 'Title',
    location: 'page/1',
    link: 'https://src/1',
  };

  it('accepts attribution with all four non-empty fields', () => {
    expect(hasCompleteAttribution(complete)).toBe(true);
  });

  it('rejects undefined attribution', () => {
    expect(hasCompleteAttribution(undefined)).toBe(false);
  });

  it.each(['sourceId', 'sourceTitle', 'location', 'link'] as const)(
    'rejects attribution missing %s',
    (field) => {
      expect(hasCompleteAttribution({ ...complete, [field]: '' })).toBe(false);
    },
  );

  it('rejects attribution whose field is whitespace only', () => {
    expect(hasCompleteAttribution({ ...complete, link: '   ' })).toBe(false);
  });
});
