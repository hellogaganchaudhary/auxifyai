/**
 * The configurable safety policy and the pure decision core of the
 * Content_Safety_Filter (Req 36.1, 36.2, 36.3, 36.5).
 *
 * This module holds the side-effect-free heart of the filter:
 *   - {@link DEFAULT_SAFETY_POLICY} — a conservative starting policy a
 *     deployment overrides field-by-field.
 *   - {@link decideSafety} — maps a {@link SafetyClassification} to a
 *     {@link ContentSafetyDecision} under a {@link SafetyPolicy}, with no I/O.
 *   - {@link failClosedDecision} / {@link failOpenDecision} — the two decisions
 *     the filter falls back to when the classifier cannot be consulted, chosen
 *     by the policy's {@link SafetyPolicy.failMode}.
 *   - {@link maskPiiSpans} — replaces located PII spans with a stable mask token
 *     (Req 36.1, 36.3).
 *
 * Keeping the decision logic pure means it can be exhaustively unit- and
 * property-tested directly, and the {@link import('./content-safety-filter.js').ContentSafetyFilter}
 * is left as thin orchestration over the three injectable ports.
 */

import {
  PROMPT_INJECTION_CATEGORY,
  type CategoryScore,
  type ContentSafetyDecision,
  type PiiSpan,
  type SafetyAction,
  type SafetyClassification,
  type SafetyPolicy,
  type SafetyReason,
} from './types.js';

/**
 * A conservative default {@link SafetyPolicy}.
 *
 * It maps no categories explicitly and lets any detected-above-threshold
 * category through (`defaultAction: 'allow'`) so an unfamiliar category never
 * silently blocks; it acts only on categories at or above a `0.5` confidence;
 * it masks PII by default (Req 36.1, 36.3); and it fails closed when the
 * classifier cannot be consulted, matching the platform's default fail-closed
 * posture. A prompt-injection attempt is always blocked regardless of these
 * settings (Req 36.2). A deployment overrides any field via {@link mergePolicy}.
 */
export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  categoryActions: {},
  defaultAction: 'allow',
  threshold: 0.5,
  maskPii: true,
  failMode: 'closed',
};

/** The token a masked PII span is replaced with; carries the PII type label. */
function maskToken(type: string): string {
  const normalized = type.trim().toUpperCase().replace(/\s+/g, '_');
  return `[REDACTED_${normalized.length > 0 ? normalized : 'PII'}]`;
}

/** Total severity order over {@link SafetyAction}: allow < flag < block. */
const ACTION_SEVERITY: Readonly<Record<SafetyAction, number>> = {
  allow: 0,
  flag: 1,
  block: 2,
};

/**
 * Return the more severe of two actions under the total `allow < flag < block`
 * order.
 *
 * @param a The first action.
 * @param b The second action.
 * @returns Whichever of `a`/`b` is more severe (or either when equal).
 */
export function moreSevere(a: SafetyAction, b: SafetyAction): SafetyAction {
  return ACTION_SEVERITY[a] >= ACTION_SEVERITY[b] ? a : b;
}

/**
 * Resolve the action a policy assigns to a single category: its explicit
 * {@link SafetyPolicy.categoryActions} entry, or the policy's
 * {@link SafetyPolicy.defaultAction} when unlisted.
 *
 * @param policy The active safety policy.
 * @param category The detected category.
 * @returns The action the policy assigns to the category.
 */
export function actionForCategory(policy: SafetyPolicy, category: string): SafetyAction {
  return policy.categoryActions[category] ?? policy.defaultAction;
}

/** Build the boolean projections of a {@link ContentSafetyDecision} from its action. */
function withProjections(
  action: SafetyAction,
  promptInjectionDetected: boolean,
  reasons: SafetyReason[],
): ContentSafetyDecision {
  return {
    action,
    allowed: action !== 'block',
    flagged: action === 'flag',
    blocked: action === 'block',
    promptInjectionDetected,
    reasons,
  };
}

/**
 * Map a {@link SafetyClassification} to a {@link ContentSafetyDecision} under a
 * {@link SafetyPolicy} — pure and side-effect-free (Req 36.1, 36.2, 36.5).
 *
 * The rules, in effect:
 *   1. A detected prompt-injection attempt ({@link SafetyClassification.promptInjection})
 *      always contributes a `block` reason under {@link PROMPT_INJECTION_CATEGORY}
 *      (Req 36.2), independent of the category map or threshold.
 *   2. Each detected category whose {@link CategoryScore.score} meets the policy
 *      {@link SafetyPolicy.threshold} contributes a reason with the action the
 *      policy assigns it ({@link actionForCategory}); a category below threshold,
 *      or one resolving to `allow`, contributes no reason.
 *   3. The decision's overall {@link ContentSafetyDecision.action} is the most
 *      severe action across all contributing reasons (`allow` when none).
 *
 * @param classification The classifier's result for one piece of content.
 * @param policy The active safety policy.
 * @returns The structured allow/flag/block decision.
 */
export function decideSafety(
  classification: SafetyClassification,
  policy: SafetyPolicy,
): ContentSafetyDecision {
  const reasons: SafetyReason[] = [];
  const promptInjectionDetected = classification.promptInjection === true;

  if (promptInjectionDetected) {
    reasons.push({ category: PROMPT_INJECTION_CATEGORY, action: 'block' });
  }

  for (const { category, score } of classification.categories ?? []) {
    if (score < policy.threshold) {
      continue;
    }
    const action = actionForCategory(policy, category);
    if (action === 'allow') {
      continue;
    }
    reasons.push({ category, action, score });
  }

  const action = reasons.reduce<SafetyAction>(
    (acc, reason) => moreSevere(acc, reason.action),
    'allow',
  );

  return withProjections(action, promptInjectionDetected, reasons);
}

/**
 * The decision the filter renders when the classifier cannot be consulted and
 * the policy fails closed: a `block` attributed to a synthetic
 * `classifier_unavailable` reason, with {@link ContentSafetyDecision.failClosed}
 * set so callers can tell a fail-closed block from a classified one.
 */
export function failClosedDecision(): ContentSafetyDecision {
  return {
    ...withProjections('block', false, [
      { category: 'classifier_unavailable', action: 'block' },
    ]),
    failClosed: true,
  };
}

/**
 * The decision the filter renders when the classifier cannot be consulted and
 * the policy fails open: an `allow` with no reasons. Used only when a deployment
 * has explicitly opted into {@link SafetyPolicy.failMode} `open`.
 */
export function failOpenDecision(): ContentSafetyDecision {
  return withProjections('allow', false, []);
}

/**
 * Replace each located PII span in `content` with a stable mask token
 * (Req 36.1, 36.3).
 *
 * Spans are applied right-to-left so earlier offsets stay valid as later spans
 * are rewritten; out-of-range or inverted spans are skipped defensively so a
 * misbehaving classifier can never corrupt the content or throw. Returns the
 * original string unchanged when there are no spans.
 *
 * @param content The content to mask.
 * @param spans The PII spans the classifier located.
 * @returns The content with every valid span replaced by a mask token.
 */
export function maskPiiSpans(content: string, spans: readonly PiiSpan[]): string {
  if (spans.length === 0) {
    return content;
  }
  const valid = spans
    .filter((s) => s.start >= 0 && s.end <= content.length && s.start < s.end)
    .sort((a, b) => b.start - a.start);

  let masked = content;
  for (const span of valid) {
    masked = masked.slice(0, span.start) + maskToken(span.type) + masked.slice(span.end);
  }
  return masked;
}

/**
 * Produce a complete {@link SafetyPolicy} by overlaying partial `overrides` onto
 * the {@link DEFAULT_SAFETY_POLICY}.
 *
 * `categoryActions` is shallow-merged (overrides win per category) rather than
 * replaced, so a deployment can add a single category mapping without restating
 * the whole map. This is the canonical way callers build a policy.
 *
 * @param overrides The fields to override on the default policy.
 * @returns A fully-populated policy.
 */
export function mergePolicy(overrides: Partial<SafetyPolicy> = {}): SafetyPolicy {
  return {
    ...DEFAULT_SAFETY_POLICY,
    ...overrides,
    categoryActions: {
      ...DEFAULT_SAFETY_POLICY.categoryActions,
      ...(overrides.categoryActions ?? {}),
    },
  };
}

/** Count the distinct {@link CategoryScore} categories at or above the threshold. */
export function categoriesAboveThreshold(
  categories: readonly CategoryScore[] | undefined,
  threshold: number,
): number {
  return (categories ?? []).filter((c) => c.score >= threshold).length;
}
