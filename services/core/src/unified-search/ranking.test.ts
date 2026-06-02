/**
 * Unit tests for the Unified_Search_Service pure scoring/ranking helpers
 * (Req 29.3, 29.6).
 *
 * These exercise the relevance math in isolation, with no ports or I/O:
 *  - {@link clamp01} bounds scores into `[0, 1]` and neutralizes non-finite input;
 *  - {@link hybridScore} fuses keyword and vector relevance under weights,
 *    staying in `[0, 1]` (Req 29.6);
 *  - {@link compareByScoreThenId} orders by non-increasing score with a
 *    deterministic id tie-break (Req 29.3).
 */

import { describe, expect, it } from 'vitest';

import { clamp01, compareByScoreThenId, hybridScore, type Rankable } from './ranking.js';

describe('clamp01', () => {
  it('keeps values already inside [0, 1]', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps out-of-range values to the [0, 1] bounds', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(7)).toBe(1);
  });

  it('collapses non-finite values to 0 so they never dominate ranking', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('hybridScore (Req 29.6)', () => {
  it('returns the weighted, normalized combination of the two components', () => {
    // vw=0.5, kw=0.5 → simple average.
    expect(hybridScore(1, 0, 0.5, 0.5)).toBeCloseTo(0.5);
    // Weight the keyword component more heavily.
    expect(hybridScore(0, 1, 1, 3)).toBeCloseTo(0.75);
  });

  it('stays within [0, 1] for any in-range inputs and weights', () => {
    for (const [v, k, vw, kw] of [
      [0, 0, 1, 1],
      [1, 1, 2, 5],
      [0.3, 0.9, 0.1, 0.9],
      [1, 0, 10, 0],
    ] as const) {
      const score = hybridScore(v, k, vw, kw);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('clamps misbehaving component scores before combining', () => {
    // A vector score above 1 is clamped to 1; keyword 0 → average 0.5.
    expect(hybridScore(5, 0, 0.5, 0.5)).toBeCloseTo(0.5);
    // A negative keyword score is clamped to 0.
    expect(hybridScore(1, -2, 0.5, 0.5)).toBeCloseTo(0.5);
  });

  it('falls back to an even average when both weights are zero', () => {
    expect(hybridScore(0.4, 0.8, 0, 0)).toBeCloseTo(0.6);
  });
});

describe('compareByScoreThenId (Req 29.3)', () => {
  it('orders by non-increasing score', () => {
    const items: Rankable[] = [
      { id: 'a', score: 0.2 },
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.5 },
    ];
    const sorted = [...items].sort(compareByScoreThenId).map((item) => item.id);
    expect(sorted).toEqual(['b', 'c', 'a']);
  });

  it('breaks score ties on ascending id, deterministically', () => {
    const items: Rankable[] = [
      { id: 'zeta', score: 0.5 },
      { id: 'alpha', score: 0.5 },
      { id: 'mike', score: 0.5 },
    ];
    const sorted = [...items].sort(compareByScoreThenId).map((item) => item.id);
    expect(sorted).toEqual(['alpha', 'mike', 'zeta']);
  });
});
