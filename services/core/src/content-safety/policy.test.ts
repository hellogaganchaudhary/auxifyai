/**
 * Unit tests for the pure decision core of the Content_Safety_Filter
 * (Req 36.1, 36.2, 36.3, 36.5).
 *
 * These pin the side-effect-free pieces the filter composes:
 *   - {@link decideSafety} maps a classification to an allow/flag/block verdict
 *     under a policy, including the always-block prompt-injection rule and the
 *     most-severe-action collapse;
 *   - {@link maskPiiSpans} masks located spans, applying them right-to-left and
 *     skipping invalid spans defensively;
 *   - {@link mergePolicy} overlays partial overrides on the default policy;
 *   - {@link moreSevere} / {@link actionForCategory} / {@link categoriesAboveThreshold}
 *     helpers behave as specified.
 *
 * Fixtures use placeholder category labels and synthetic PII spans only.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SAFETY_POLICY,
  actionForCategory,
  categoriesAboveThreshold,
  decideSafety,
  failClosedDecision,
  failOpenDecision,
  maskPiiSpans,
  mergePolicy,
  moreSevere,
} from './policy.js';
import { PROMPT_INJECTION_CATEGORY } from './types.js';

describe('decideSafety (Req 36.2, 36.5)', () => {
  it('allows a clean classification with no reasons', () => {
    const decision = decideSafety({}, DEFAULT_SAFETY_POLICY);
    expect(decision).toMatchObject({ action: 'allow', allowed: true, reasons: [] });
  });

  it('always blocks a detected prompt-injection attempt regardless of policy', () => {
    const decision = decideSafety({ promptInjection: true }, mergePolicy({ defaultAction: 'allow' }));
    expect(decision.blocked).toBe(true);
    expect(decision.promptInjectionDetected).toBe(true);
    expect(decision.reasons[0]?.category).toBe(PROMPT_INJECTION_CATEGORY);
  });

  it('ignores categories below the policy threshold', () => {
    const decision = decideSafety(
      { categories: [{ category: 'category_a', score: 0.4 }] },
      mergePolicy({ categoryActions: { category_a: 'block' }, threshold: 0.5 }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reasons).toHaveLength(0);
  });

  it('collapses to the most severe triggered action', () => {
    const decision = decideSafety(
      {
        categories: [
          { category: 'category_a', score: 0.9 },
          { category: 'category_b', score: 0.9 },
        ],
      },
      mergePolicy({ categoryActions: { category_a: 'flag', category_b: 'block' } }),
    );
    expect(decision.action).toBe('block');
  });

  it('drops categories mapped to allow even when above threshold', () => {
    const decision = decideSafety(
      { categories: [{ category: 'category_a', score: 1 }] },
      mergePolicy({ categoryActions: { category_a: 'allow' } }),
    );
    expect(decision.action).toBe('allow');
    expect(decision.reasons).toHaveLength(0);
  });
});

describe('maskPiiSpans (Req 36.1, 36.3)', () => {
  it('returns the original content when there are no spans', () => {
    expect(maskPiiSpans('hello', [])).toBe('hello');
  });

  it('masks a single span with a typed token', () => {
    const content = 'email me at a@b.co please';
    const start = content.indexOf('a@b.co');
    expect(maskPiiSpans(content, [{ type: 'email', start, end: start + 6 }])).toBe(
      'email me at [REDACTED_EMAIL] please',
    );
  });

  it('masks multiple spans right-to-left so offsets stay valid', () => {
    const content = 'a@b.co and c@d.co';
    const first = content.indexOf('a@b.co');
    const second = content.indexOf('c@d.co');
    const masked = maskPiiSpans(content, [
      { type: 'email', start: first, end: first + 6 },
      { type: 'email', start: second, end: second + 6 },
    ]);
    expect(masked).toBe('[REDACTED_EMAIL] and [REDACTED_EMAIL]');
  });

  it('skips out-of-range and inverted spans defensively', () => {
    const content = 'short';
    expect(maskPiiSpans(content, [{ type: 'x', start: 3, end: 99 }])).toBe('short');
    expect(maskPiiSpans(content, [{ type: 'x', start: 4, end: 2 }])).toBe('short');
    expect(maskPiiSpans(content, [{ type: 'x', start: -1, end: 2 }])).toBe('short');
  });

  it('falls back to a generic token for a blank type label', () => {
    expect(maskPiiSpans('xy', [{ type: '   ', start: 0, end: 1 }])).toBe('[REDACTED_PII]y');
  });
});

describe('mergePolicy', () => {
  it('returns the default policy when given no overrides', () => {
    expect(mergePolicy()).toEqual(DEFAULT_SAFETY_POLICY);
  });

  it('shallow-merges categoryActions rather than replacing them', () => {
    const base = mergePolicy({ categoryActions: { category_a: 'block' } });
    const merged = mergePolicy({ ...base, categoryActions: { category_b: 'flag' } });
    expect(merged.categoryActions).toMatchObject({ category_b: 'flag' });
  });

  it('overrides scalar fields', () => {
    const policy = mergePolicy({ threshold: 0.9, maskPii: false, failMode: 'open' });
    expect(policy.threshold).toBe(0.9);
    expect(policy.maskPii).toBe(false);
    expect(policy.failMode).toBe('open');
  });
});

describe('helpers', () => {
  it('moreSevere returns the higher-severity action', () => {
    expect(moreSevere('allow', 'flag')).toBe('flag');
    expect(moreSevere('block', 'flag')).toBe('block');
    expect(moreSevere('allow', 'allow')).toBe('allow');
  });

  it('actionForCategory falls back to the default action for unlisted categories', () => {
    const policy = mergePolicy({ categoryActions: { category_a: 'block' }, defaultAction: 'flag' });
    expect(actionForCategory(policy, 'category_a')).toBe('block');
    expect(actionForCategory(policy, 'unknown')).toBe('flag');
  });

  it('categoriesAboveThreshold counts only at-or-above-threshold categories', () => {
    expect(
      categoriesAboveThreshold(
        [
          { category: 'a', score: 0.6 },
          { category: 'b', score: 0.4 },
        ],
        0.5,
      ),
    ).toBe(1);
    expect(categoriesAboveThreshold(undefined, 0.5)).toBe(0);
  });

  it('failClosedDecision blocks and is marked failClosed; failOpenDecision allows', () => {
    expect(failClosedDecision()).toMatchObject({ action: 'block', failClosed: true });
    expect(failOpenDecision()).toMatchObject({ action: 'allow' });
  });
});
