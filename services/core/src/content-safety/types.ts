/**
 * Domain records and injectable ports for the Content_Safety_Filter (Req 36).
 *
 * The Content_Safety_Filter screens AI inputs and outputs against a configurable
 * safety policy. It never embeds a moderation model: the act of classifying a
 * piece of content is delegated to the narrow injectable {@link SafetyClassifier}
 * port, the act of recording a block is delegated to the shared
 * {@link import('../audit/index.js').AuditRecorder} port, and the act of queuing
 * a conversation for human review is delegated to the injectable
 * {@link ReviewQueue} port. Everything else — mapping a classification to an
 * allow/flag/block {@link ContentSafetyDecision} under a {@link SafetyPolicy},
 * masking detected PII, and preserving the configured system prompt against a
 * prompt-injection attempt — is pure, deterministic orchestration, so the filter
 * is fully unit-testable with the fakes in `./fakes.js`.
 *
 * These types describe the inputs and outputs of the filter's three operations:
 *   - {@link ModelInput} -> {@link ScreenedInput} (screen an inbound prompt,
 *     Req 36.1, 36.2);
 *   - {@link ModelOutput} -> {@link ScannedOutput} (scan an outbound model
 *     response, Req 36.3);
 *   - a conversation id + {@link ReviewReason} -> a queued {@link ReviewItem}
 *     (Req 36.4, 36.5).
 */

/**
 * The action a {@link SafetyPolicy} assigns to a piece of content, in ascending
 * severity.
 *
 *   - `allow` — the content is permitted to proceed unchanged.
 *   - `flag` — the content is permitted but surfaced for review (Req 36.5); the
 *     conversation is auto-queued for human review.
 *   - `block` — the content is refused: an inbound prompt is prevented from
 *     reaching the model and an outbound response is withheld from the user,
 *     and the event is recorded in the Audit_Service (Req 36.2).
 *
 * Severity is total (`allow` < `flag` < `block`), so a decision over many
 * categories collapses to the single most severe action triggered.
 */
export type SafetyAction = 'allow' | 'flag' | 'block';

/** All {@link SafetyAction} values, for iteration, validation, and test generators. */
export const SAFETY_ACTIONS: readonly SafetyAction[] = ['allow', 'flag', 'block'] as const;

/**
 * The surface a piece of content was screened on.
 *
 * `input` is an inbound user prompt (Req 36.1, 36.2); `output` is an outbound
 * model response (Req 36.3). The classifier receives the surface so it can
 * apply surface-appropriate detectors (for example, prompt-injection detection
 * only makes sense on `input`).
 */
export type SafetySurface = 'input' | 'output';

/**
 * A safety category label.
 *
 * Categories are intentionally an open `string` rather than a fixed union so a
 * policy can be configured with whatever category vocabulary the deployed
 * classifier emits (placeholder labels in tests, the moderation vendor's real
 * taxonomy in production) without a code change. The one category the filter
 * itself reasons about by name is {@link PROMPT_INJECTION_CATEGORY}.
 */
export type SafetyCategory = string;

/**
 * The reserved category label the filter uses to represent a prompt-injection
 * attempt in a {@link SafetyReason} (Req 36.2).
 *
 * A {@link SafetyClassification} signals injection through its dedicated
 * {@link SafetyClassification.promptInjection} flag; the filter records the
 * resulting block reason under this category so the audit trail and the
 * decision's reasons name it explicitly.
 */
export const PROMPT_INJECTION_CATEGORY: SafetyCategory = 'prompt_injection';

/**
 * A single category the classifier detected in a piece of content, with the
 * classifier's confidence.
 *
 * `score` is a confidence in `[0, 1]`; the policy's {@link SafetyPolicy.threshold}
 * decides whether the score is high enough to act on the category at all.
 */
export interface CategoryScore {
  /** The detected category label. */
  category: SafetyCategory;
  /** The classifier's confidence in `[0, 1]` that the category applies. */
  score: number;
}

/**
 * A span of personally identifiable information the classifier located within a
 * piece of content, to be masked before the content proceeds (Req 36.1, 36.3).
 *
 * Offsets are half-open character indices `[start, end)` into the screened
 * string; `type` is a free-form label for the kind of PII (e.g. `email`,
 * `phone`) used only to compose the mask token.
 */
export interface PiiSpan {
  /** A label for the kind of PII (e.g. `email`); used only in the mask token. */
  type: string;
  /** The inclusive start character offset of the span. */
  start: number;
  /** The exclusive end character offset of the span. */
  end: number;
}

/**
 * The complete result of classifying one piece of content — the single source
 * of truth a {@link ContentSafetyDecision} is derived from.
 *
 * `categories` carries every detected category with its confidence;
 * `promptInjection` (meaningful on the `input` surface) signals a detected
 * attempt to override the system prompt (Req 36.2); `piiSpans` locates the PII
 * to mask (Req 36.1, 36.3). All fields are optional so a "clean" classification
 * is simply `{}`.
 */
export interface SafetyClassification {
  /** Every category the classifier detected, with confidence. */
  categories?: CategoryScore[];
  /** Whether a prompt-injection attempt was detected (input surface, Req 36.2). */
  promptInjection?: boolean;
  /** The PII spans to mask before the content proceeds (Req 36.1, 36.3). */
  piiSpans?: PiiSpan[];
}

/**
 * The narrow content-classification port the filter depends on (Req 36.1-36.3).
 *
 * Modelling classification as a one-method port keeps the Content_Safety_Filter
 * independent of any concrete moderation model or service: production wires the
 * real classifier while unit and property tests inject a deterministic fake.
 * The filter treats a rejection from this port as an inability to verify the
 * content's safety and falls open or closed according to the policy's
 * {@link SafetyPolicy.failMode}; an implementation that cannot classify MUST
 * reject rather than fabricate a clean result.
 */
export interface SafetyClassifier {
  /**
   * Classify a piece of content on the given surface.
   *
   * @param content The raw text to classify.
   * @param surface Whether the content is an inbound prompt or an outbound response.
   * @returns The detected categories, injection signal, and PII spans.
   */
  classify(content: string, surface: SafetySurface): Promise<SafetyClassification>;
}

/**
 * The reason a conversation was queued for human review (Req 36.4, 36.5).
 *
 *   - `user_report` — a user reported a problematic AI output (Req 36.4).
 *   - `auto_flag` — content filtering flagged or blocked the content (Req 36.5).
 */
export type ReviewReason = 'user_report' | 'auto_flag';

/** All {@link ReviewReason} values, for iteration, validation, and test generators. */
export const REVIEW_REASONS: readonly ReviewReason[] = ['user_report', 'auto_flag'] as const;

/**
 * A conversation queued for human review (Req 36.4, 36.5).
 *
 * The minimal record the {@link ReviewQueue} receives: which conversation, and
 * why. It mirrors the design's `queueForReview(conversationId, reason)`
 * signature so the same item is produced whether the queueing was triggered by
 * a user report or by auto-flagging.
 */
export interface ReviewItem {
  /** The conversation to be reviewed by a human. */
  conversationId: string;
  /** Why the conversation was queued. */
  reason: ReviewReason;
}

/**
 * The injectable port that queues a conversation for human review (Req 36.4,
 * 36.5).
 *
 * Modelling the review queue as a port keeps the filter decoupled from the
 * concrete moderation backlog (a database table, a work queue, a ticketing
 * system); tests substitute a capturing fake to assert exactly what was queued.
 */
export interface ReviewQueue {
  /**
   * Queue a conversation for human review.
   *
   * @param item The conversation id and the reason it is being queued.
   */
  enqueue(item: ReviewItem): Promise<void>;
}

/**
 * A single category-level reason contributing to a {@link ContentSafetyDecision}.
 *
 * One reason is produced per category whose detected {@link score} met the
 * policy threshold and resolved to a non-`allow` {@link action}; a detected
 * prompt-injection attempt contributes a reason under
 * {@link PROMPT_INJECTION_CATEGORY} with `action: 'block'` (Req 36.2).
 */
export interface SafetyReason {
  /** The category that triggered this reason. */
  category: SafetyCategory;
  /** The policy action assigned to the category. */
  action: SafetyAction;
  /** The classifier's confidence for the category, when score-based. */
  score?: number;
}

/**
 * The verdict the filter renders for one piece of content — a structured
 * allow/flag/block decision callers can inspect, mirroring Access_Control's
 * {@link import('../access/index.js').AuthzDecision} and the Billing_Guard's
 * {@link import('../billing-guard/index.js').BillingDecision}.
 *
 * `action` is the single most severe action triggered across all
 * {@link reasons}; the boolean projections {@link allowed}/{@link flagged}/
 * {@link blocked} are derived from it for convenient branching. `allowed` is
 * `true` for both `allow` and `flag` (a flagged item still proceeds, it is just
 * surfaced for review); it is `false` only for `block`.
 */
export interface ContentSafetyDecision {
  /** The most severe action triggered: `allow`, `flag`, or `block`. */
  action: SafetyAction;
  /** Whether the content may proceed. `true` unless {@link action} is `block`. */
  allowed: boolean;
  /** Whether the content was flagged for review (its most severe action is `flag`). */
  flagged: boolean;
  /** Whether the content was blocked (its most severe action is `block`). */
  blocked: boolean;
  /** Whether a prompt-injection attempt was detected (Req 36.2). */
  promptInjectionDetected: boolean;
  /** The per-category reasons that produced the decision (empty when allowed clean). */
  reasons: SafetyReason[];
  /**
   * `true` when the decision was forced by a fail-closed response to a
   * classifier error rather than by an actual classification (Req 36, platform
   * fail-closed posture). Absent on a normally-classified decision.
   */
  failClosed?: boolean;
}

/**
 * An inbound user prompt to be screened before it reaches the model (Req 36.1,
 * 36.2).
 *
 * `systemPrompt` is the configured instruction the platform places ahead of the
 * user's content; it is carried through screening so the filter can guarantee
 * that a prompt-injection attempt in {@link userContent} can never overwrite it
 * (Req 36.2 / Property 48). `organizationId` (and the optional `userId`) scope
 * the audit record written on a block to the originating tenant (Req 37.1).
 */
export interface ModelInput {
  /** The conversation the prompt belongs to, used to queue auto-flagged reviews (Req 36.5). */
  conversationId: string;
  /** The configured system prompt that must survive screening unchanged (Req 36.2). */
  systemPrompt: string;
  /** The user-supplied content to screen for injection and PII (Req 36.1). */
  userContent: string;
  /** The Organization the request belongs to, used to scope the block audit (Req 37.1). */
  organizationId: string;
  /** The acting user, recorded on a block; defaults to a system actor when absent. */
  userId?: string;
}

/**
 * The result of screening a {@link ModelInput} (Req 36.1, 36.2).
 *
 * `systemPrompt` is ALWAYS the unchanged configured system prompt from the
 * input — the filter never lets screened user content overwrite it, so a
 * detected injection cannot alter the effective instruction sent to the model
 * (Req 36.2 / Property 48). `userContent` is the PII-masked user content
 * (Req 36.1). `decision` carries the allow/flag/block verdict; when
 * `decision.blocked` is `true`, callers must not forward the input to the model.
 */
export interface ScreenedInput {
  /** The allow/flag/block verdict for the inbound prompt. */
  decision: ContentSafetyDecision;
  /** The configured system prompt, unchanged — never overridden by user content (Req 36.2). */
  systemPrompt: string;
  /** The PII-masked user content (Req 36.1). */
  userContent: string;
}

/**
 * An outbound model response to be scanned before delivery to the user
 * (Req 36.3).
 *
 * `organizationId` (and the optional `userId`) scope the audit record written
 * on a block to the originating tenant (Req 37.1); `conversationId` lets a
 * flagged or blocked response auto-queue its conversation for review (Req 36.5).
 */
export interface ModelOutput {
  /** The conversation the response belongs to, used to queue auto-flagged reviews (Req 36.5). */
  conversationId: string;
  /** The model-produced content to scan for PII and policy violations (Req 36.3). */
  content: string;
  /** The Organization the response belongs to, used to scope the block audit (Req 37.1). */
  organizationId: string;
  /** The acting user, recorded on a block; defaults to a system actor when absent. */
  userId?: string;
}

/**
 * The result of scanning a {@link ModelOutput} (Req 36.3).
 *
 * `content` is the PII-masked response; when `decision.blocked` is `true`,
 * callers must withhold the response from the user.
 */
export interface ScannedOutput {
  /** The allow/flag/block verdict for the outbound response. */
  decision: ContentSafetyDecision;
  /** The PII-masked response content (Req 36.3). */
  content: string;
}

/**
 * The configurable safety policy that maps a {@link SafetyClassification} to a
 * {@link ContentSafetyDecision} (Req 36).
 *
 * The policy is the single knob that makes the filter's behaviour
 * deployment-specific without a code change:
 *   - {@link categoryActions} assigns an action to specific categories; a
 *     category absent from the map takes {@link defaultAction}.
 *   - {@link defaultAction} is the action for any detected-above-threshold
 *     category with no explicit mapping (defaults to `allow`, so an unknown
 *     category never silently blocks).
 *   - {@link threshold} is the minimum confidence in `[0, 1]` a category's score
 *     must reach to be acted on at all.
 *   - {@link maskPii} toggles PII masking of screened/scanned content (Req 36.1,
 *     36.3); defaults to `true`.
 *   - {@link failMode} chooses the behaviour when the classifier cannot be
 *     consulted: `closed` blocks (the platform's default fail-closed posture),
 *     `open` allows.
 */
export interface SafetyPolicy {
  /** Per-category action assignments; an unlisted category takes {@link defaultAction}. */
  categoryActions: Record<SafetyCategory, SafetyAction>;
  /** The action for a detected-above-threshold category with no explicit mapping. */
  defaultAction: SafetyAction;
  /** The minimum confidence in `[0, 1]` a category score must reach to be acted on. */
  threshold: number;
  /** Whether to mask detected PII in screened/scanned content (Req 36.1, 36.3). */
  maskPii: boolean;
  /** Behaviour when the classifier cannot be consulted: `closed` blocks, `open` allows. */
  failMode: 'open' | 'closed';
}
