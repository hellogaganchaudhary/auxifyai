/**
 * Content_Safety_Filter (Req 36.1, 36.2, 36.3, 36.4, 36.5).
 *
 * The Content_Safety_Filter screens AI inputs and outputs so the platform
 * resists prompt injection and prevents data leakage. It is thin, deterministic
 * orchestration over three injected ports — a {@link SafetyClassifier} (the
 * moderation model), an {@link import('../audit/index.js').AuditRecorder} (the
 * Audit_Service), and a {@link ReviewQueue} (the human-review backlog) — plus
 * the pure decision core in `./policy.js`. Production wires the real classifier,
 * Audit_Service, and review backlog while tests substitute the fakes in
 * `./fakes.js`.
 *
 * ## Screening an inbound prompt — {@link ContentSafetyFilter.screenInput} (Req 36.1, 36.2)
 *
 *   1. Classify the user content on the `input` surface through the injected
 *      classifier.
 *   2. Map the classification to a {@link ContentSafetyDecision} under the
 *      active {@link SafetyPolicy} ({@link decideSafety}). A detected
 *      prompt-injection attempt always blocks (Req 36.2).
 *   3. Mask any detected PII in the user content (Req 36.1), when the policy
 *      enables masking.
 *   4. Return the configured system prompt **unchanged** alongside the masked
 *      user content — the filter never lets screened user content overwrite the
 *      system prompt, so a detected injection cannot alter the effective
 *      instruction sent to the model (Req 36.2 / Property 48).
 *   5. Record a `content_safety.input_blocked` audit event on a block (Req 36.2),
 *      and auto-queue the conversation for human review on any flag/block
 *      (Req 36.5).
 *
 * ## Scanning an outbound response — {@link ContentSafetyFilter.scanOutput} (Req 36.3)
 *
 *   1. Classify the response on the `output` surface.
 *   2. Map it to a decision under the policy and mask detected PII in the
 *      response before it is delivered (Req 36.3).
 *   3. Record a `content_safety.output_blocked` audit event on a block, and
 *      auto-queue the conversation for review on any flag/block (Req 36.5).
 *
 * ## Queuing for review — {@link ContentSafetyFilter.queueForReview} (Req 36.4, 36.5)
 *
 * Queues a conversation for human review with the reason — `user_report` for a
 * user-reported output (Req 36.4) or `auto_flag` for content-filter flagging
 * (Req 36.5).
 *
 * ## Fail mode
 *
 * When the classifier rejects (it could not be consulted), the filter does not
 * propagate the exception into the request path: it renders the policy's
 * configured fallback — a fail-closed `block` ({@link failClosedDecision}) under
 * the default posture, or a fail-open `allow` only when a deployment has
 * explicitly set {@link SafetyPolicy.failMode} to `open`. On a fail-closed block
 * the content is conservatively left unmasked-but-withheld and the block is
 * audited like any other.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import { ContentBlockedError } from './errors.js';
import {
  decideSafety,
  failClosedDecision,
  failOpenDecision,
  maskPiiSpans,
  mergePolicy,
} from './policy.js';
import type {
  ContentSafetyDecision,
  ModelInput,
  ModelOutput,
  ReviewQueue,
  ReviewReason,
  SafetyClassification,
  SafetyClassifier,
  SafetyPolicy,
  SafetySurface,
  ScannedOutput,
  ScreenedInput,
} from './types.js';

/** Construction dependencies for {@link ContentSafetyFilter} (all injected). */
export interface ContentSafetyFilterOptions {
  /** The moderation classifier port (or a fake) classifying input/output content (Req 36.1-36.3). */
  classifier: SafetyClassifier;
  /** The Audit_Service (or a fake) recording every block (Req 36.2, 37.1). */
  auditRecorder: AuditRecorder;
  /** The human-review backlog (or a fake) the filter queues conversations into (Req 36.4, 36.5). */
  reviewQueue: ReviewQueue;
  /** The active safety policy; partial overrides are merged onto the default policy. */
  policy?: Partial<SafetyPolicy>;
}

/** The audit action recorded when an inbound prompt is blocked (Req 36.2). */
const INPUT_BLOCKED_ACTION = 'content_safety.input_blocked';
/** The audit action recorded when an outbound response is blocked. */
const OUTPUT_BLOCKED_ACTION = 'content_safety.output_blocked';

/**
 * The Content_Safety_Filter. Construct once with the classifier, Audit_Service,
 * and review-queue ports plus an optional policy, then call
 * {@link screenInput} before a prompt reaches the model and {@link scanOutput}
 * before a response is delivered.
 */
export class ContentSafetyFilter {
  private readonly classifier: SafetyClassifier;
  private readonly auditRecorder: AuditRecorder;
  private readonly reviewQueue: ReviewQueue;
  private readonly policy: SafetyPolicy;

  constructor(options: ContentSafetyFilterOptions) {
    this.classifier = options.classifier;
    this.auditRecorder = options.auditRecorder;
    this.reviewQueue = options.reviewQueue;
    this.policy = mergePolicy(options.policy);
  }

  /** The effective, fully-resolved {@link SafetyPolicy} this filter applies. */
  get activePolicy(): SafetyPolicy {
    return this.policy;
  }

  /**
   * Screen an inbound prompt for prompt injection and mask detected PII before
   * it reaches the model (Req 36.1, 36.2).
   *
   * Returns the unchanged configured system prompt (never overridden by user
   * content, Req 36.2) and the PII-masked user content (Req 36.1), with the
   * allow/flag/block verdict on `decision`. A block is audited (Req 36.2) and
   * any flag/block auto-queues the conversation for human review (Req 36.5).
   * When `decision.blocked` is `true`, callers MUST NOT forward the input to the
   * model.
   *
   * @param input The inbound prompt, its configured system prompt, and tenant scope.
   * @returns The screened input: the unchanged system prompt, masked content, and decision.
   */
  async screenInput(input: ModelInput): Promise<ScreenedInput> {
    const { decision, classification } = await this.classifyAndDecide(input.userContent, 'input');

    const userContent =
      this.policy.maskPii && classification !== undefined
        ? maskPiiSpans(input.userContent, classification.piiSpans ?? [])
        : input.userContent;

    if (decision.blocked) {
      await this.recordBlock(INPUT_BLOCKED_ACTION, input.conversationId, decision, {
        organizationId: input.organizationId,
        userId: input.userId,
      });
    }
    await this.autoQueue(input.conversationId, decision);

    // The system prompt is returned verbatim — screened user content can never
    // overwrite it, so a detected injection cannot change what the model sees.
    return { decision, systemPrompt: input.systemPrompt, userContent };
  }

  /**
   * Like {@link screenInput}, but throws {@link ContentBlockedError} on a block
   * (after the block is audited and the review is queued) and resolves to the
   * {@link ScreenedInput} otherwise. Chat-path callers use this to fail closed
   * with a single throw site while retaining the full decision on the error.
   *
   * @param input The inbound prompt to screen.
   * @returns The screened input when not blocked.
   * @throws {ContentBlockedError} When the input is blocked.
   */
  async screenInputOrThrow(input: ModelInput): Promise<ScreenedInput> {
    const screened = await this.screenInput(input);
    if (screened.decision.blocked) {
      throw new ContentBlockedError('input', screened.decision);
    }
    return screened;
  }

  /**
   * Scan an outbound model response for PII and policy violations before it is
   * delivered to the user (Req 36.3).
   *
   * Returns the PII-masked response with the allow/flag/block verdict on
   * `decision`. A block is audited and any flag/block auto-queues the
   * conversation for human review (Req 36.5). When `decision.blocked` is `true`,
   * callers MUST withhold the response from the user.
   *
   * @param output The model-produced response and its tenant scope.
   * @returns The scanned output: the masked content and the decision.
   */
  async scanOutput(output: ModelOutput): Promise<ScannedOutput> {
    const { decision, classification } = await this.classifyAndDecide(output.content, 'output');

    const content =
      this.policy.maskPii && classification !== undefined
        ? maskPiiSpans(output.content, classification.piiSpans ?? [])
        : output.content;

    if (decision.blocked) {
      await this.recordBlock(OUTPUT_BLOCKED_ACTION, output.conversationId, decision, {
        organizationId: output.organizationId,
        userId: output.userId,
      });
    }
    await this.autoQueue(output.conversationId, decision);

    return { decision, content };
  }

  /**
   * Like {@link scanOutput}, but throws {@link ContentBlockedError} on a block
   * (after the block is audited and the review is queued) and resolves to the
   * {@link ScannedOutput} otherwise.
   *
   * @param output The outbound response to scan.
   * @returns The scanned output when not blocked.
   * @throws {ContentBlockedError} When the output is blocked.
   */
  async scanOutputOrThrow(output: ModelOutput): Promise<ScannedOutput> {
    const scanned = await this.scanOutput(output);
    if (scanned.decision.blocked) {
      throw new ContentBlockedError('output', scanned.decision);
    }
    return scanned;
  }

  /**
   * Queue a conversation for human review (Req 36.4, 36.5).
   *
   * Used directly for a user-reported output (`user_report`, Req 36.4); the
   * `auto_flag` reason (Req 36.5) is also queued automatically by
   * {@link screenInput}/{@link scanOutput} on any flagged or blocked content.
   *
   * @param conversationId The conversation to queue for review.
   * @param reason Why the conversation is being queued.
   */
  async queueForReview(conversationId: string, reason: ReviewReason): Promise<void> {
    await this.reviewQueue.enqueue({ conversationId, reason });
  }

  /**
   * Classify content through the injected port and map it to a decision,
   * falling back to the policy's fail mode when the classifier cannot be
   * consulted. Returns the decision plus the classification (absent on a
   * classifier error, so callers skip masking on the fail path).
   */
  private async classifyAndDecide(
    content: string,
    surface: SafetySurface,
  ): Promise<{ decision: ContentSafetyDecision; classification?: SafetyClassification }> {
    let classification: SafetyClassification;
    try {
      classification = await this.classifier.classify(content, surface);
    } catch {
      // The classifier could not be consulted — fall back per policy fail mode.
      const decision =
        this.policy.failMode === 'open' ? failOpenDecision() : failClosedDecision();
      return { decision };
    }
    return { decision: decideSafety(classification, this.policy), classification };
  }

  /**
   * Auto-queue a conversation for human review when its decision flagged or
   * blocked the content (Req 36.5). A clean `allow` queues nothing.
   */
  private async autoQueue(
    conversationId: string,
    decision: ContentSafetyDecision,
  ): Promise<void> {
    if (decision.flagged || decision.blocked) {
      await this.reviewQueue.enqueue({ conversationId, reason: 'auto_flag' });
    }
  }

  /**
   * Record a content-safety block as an audit event scoped to the originating
   * Organization (Req 36.2, 37.1). The metadata carries the triggering category
   * labels, the injection flag, and whether the block was a fail-closed
   * fallback — never the offending content, so no sensitive text is persisted.
   */
  private async recordBlock(
    action: string,
    conversationId: string,
    decision: ContentSafetyDecision,
    scope: { organizationId: string; userId?: string },
  ): Promise<void> {
    const ctx: TenantContext = {
      organizationId: scope.organizationId,
      userId: scope.userId ?? 'system',
    };
    await this.auditRecorder.record(ctx, {
      action,
      resourceType: 'conversation',
      resourceId: conversationId,
      metadata: {
        categories: decision.reasons.map((r) => r.category),
        promptInjectionDetected: decision.promptInjectionDetected,
        failClosed: decision.failClosed === true,
      },
    });
  }
}
