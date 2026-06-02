/**
 * Content_Safety_Filter (Req 36.1, 36.2, 36.3, 36.4, 36.5).
 *
 * The component that screens AI inputs and outputs so the platform resists
 * prompt injection and prevents data leakage. {@link ContentSafetyFilter} is
 * thin, deterministic orchestration over three narrow injected ports — a
 * {@link SafetyClassifier} (the moderation model), the shared
 * {@link import('../audit/index.js').AuditRecorder} (the Audit_Service), and a
 * {@link ReviewQueue} (the human-review backlog) — plus the pure decision core
 * ({@link decideSafety}). Production wires the real classifier, Audit_Service,
 * and review backlog; tests substitute the fakes in `./content-safety/fakes.js`.
 *
 *   - {@link ContentSafetyFilter.screenInput} classifies an inbound prompt on
 *     the `input` surface, maps it to an allow/flag/block
 *     {@link ContentSafetyDecision} under the active {@link SafetyPolicy}, masks
 *     detected PII (Req 36.1), and returns the configured system prompt
 *     **unchanged** so a detected prompt-injection attempt can never override it
 *     (Req 36.2 / Property 48); a block is recorded in the Audit_Service
 *     (Req 36.2) and any flag/block auto-queues the conversation for human
 *     review (Req 36.5).
 *   - {@link ContentSafetyFilter.scanOutput} classifies an outbound response on
 *     the `output` surface and masks detected PII before delivery (Req 36.3),
 *     auditing a block and auto-queuing a flagged/blocked conversation.
 *   - {@link ContentSafetyFilter.queueForReview} queues a conversation for human
 *     review — `user_report` for a user-reported output (Req 36.4) or
 *     `auto_flag` for content-filter flagging (Req 36.5).
 *
 * The verdict is fully configurable through the {@link SafetyPolicy}: per-category
 * {@link SafetyAction} mappings, a confidence threshold, PII-masking toggle, and
 * an `open`/`closed` fail mode chosen when the classifier cannot be consulted
 * (default fail-closed). A detected prompt-injection attempt always blocks
 * regardless of the category map. {@link ContentSafetyFilter.screenInputOrThrow}
 * / {@link ContentSafetyFilter.scanOutputOrThrow} raise a typed
 * {@link ContentBlockedError} that projects into a serializable `validation`
 * {@link import('@auxify/types').PlatformError} (Req 46.8) carrying only the
 * surface, triggering category labels, and injection flag — never the offending
 * content.
 *
 * Names are `Safety`-/`ContentSafety`-/`Pii`-/`Review`-prefixed and otherwise
 * distinct (e.g. {@link ContentSafetyDecision}, {@link SafetyCategory},
 * {@link SafetyAction}) so they never collide with sibling modules' barrel
 * exports.
 */

export {
  ContentSafetyFilter,
  type ContentSafetyFilterOptions,
} from './content-safety-filter.js';

export {
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

export { ContentBlockedError, CONTENT_BLOCKED_CODE } from './errors.js';

export {
  PROMPT_INJECTION_CATEGORY,
  SAFETY_ACTIONS,
  REVIEW_REASONS,
  type CategoryScore,
  type ContentSafetyDecision,
  type ModelInput,
  type ModelOutput,
  type PiiSpan,
  type ReviewItem,
  type ReviewQueue,
  type ReviewReason,
  type SafetyAction,
  type SafetyCategory,
  type SafetyClassification,
  type SafetyClassifier,
  type SafetyPolicy,
  type SafetyReason,
  type SafetySurface,
  type ScannedOutput,
  type ScreenedInput,
} from './types.js';
