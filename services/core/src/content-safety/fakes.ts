/**
 * Test fakes and builders for the Content_Safety_Filter.
 *
 * The filter depends on three injected ports — a {@link SafetyClassifier} (the
 * moderation model), an {@link AuditRecorder} (the Audit_Service), and a
 * {@link ReviewQueue} (the human-review backlog). These deterministic fakes let
 * unit and property tests drive `screenInput`/`scanOutput` and inspect what was
 * audited and queued, with no real moderation model, database, or work queue:
 *
 *   - {@link FakeSafetyClassifier} returns a per-content {@link SafetyClassification}
 *     from a configurable map (defaulting to a clean `{}` classification), and
 *     can be told to throw to exercise the fail-open/fail-closed paths.
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` pair so a test
 *     can assert that exactly the blocks were audited (Req 36.2 / 37.1).
 *   - {@link CapturingReviewQueue} records every {@link ReviewItem} enqueued so a
 *     test can assert what was queued for review (Req 36.4, 36.5).
 *   - {@link makeInput} / {@link makeOutput} are small builders with sensible
 *     defaults that each test overrides field-by-field.
 *
 * NOTE: the fixtures are deliberately benign and abstract — placeholder category
 * labels (e.g. `category_a`) and synthetic PII spans — never actual harmful
 * content. The real moderation classifier is wired separately in production.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type {
  ModelInput,
  ModelOutput,
  ReviewItem,
  ReviewQueue,
  SafetyClassification,
  SafetyClassifier,
  SafetySurface,
} from './types.js';

/**
 * A {@link SafetyClassifier} that returns a configurable per-content
 * classification.
 *
 * Classifications are looked up by exact content string from {@link byContent};
 * a content with no entry resolves to {@link fallback} (a clean `{}` by
 * default). Set {@link throwError} to make `classify` reject, modelling a
 * moderation model that is itself unavailable, to exercise the filter's
 * fail-open / fail-closed paths. Every call is captured in {@link calls}.
 */
export class FakeSafetyClassifier implements SafetyClassifier {
  /** Per-content classifications; a missing content resolves to {@link fallback}. */
  readonly byContent: Map<string, SafetyClassification>;
  /** The classification returned for any content not present in {@link byContent}. */
  fallback: SafetyClassification;
  /** When set, `classify` rejects with this error (models an unavailable classifier). */
  throwError: Error | undefined;
  /** Every `classify` invocation, in order. */
  readonly calls: Array<{ content: string; surface: SafetySurface }> = [];

  constructor(
    byContent: Record<string, SafetyClassification> = {},
    options: { fallback?: SafetyClassification; throwError?: Error } = {},
  ) {
    this.byContent = new Map(Object.entries(byContent));
    this.fallback = options.fallback ?? {};
    this.throwError = options.throwError;
  }

  async classify(content: string, surface: SafetySurface): Promise<SafetyClassification> {
    this.calls.push({ content, surface });
    if (this.throwError !== undefined) {
      throw this.throwError;
    }
    return this.byContent.get(content) ?? this.fallback;
  }

  /** Set or replace the classification for a content string; returns `this` for chaining. */
  set(content: string, classification: SafetyClassification): this {
    this.byContent.set(content, classification);
    return this;
  }
}

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} that stores every recorded event so tests
 * can assert which blocks were audited (Req 36.2 / 37.1).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    // Defensive copies so later mutation by callers cannot rewrite the trail.
    this.recorded.push({ ctx: { ...ctx }, event: { ...event, metadata: { ...event.metadata } } });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `content_safety.input_blocked`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }
}

/**
 * A capturing {@link ReviewQueue} that stores every enqueued {@link ReviewItem}
 * so tests can assert what was queued for human review (Req 36.4, 36.5).
 */
export class CapturingReviewQueue implements ReviewQueue {
  /** Every enqueued review item, in order. */
  readonly items: ReviewItem[] = [];

  async enqueue(item: ReviewItem): Promise<void> {
    this.items.push({ ...item });
  }

  /** The number of items enqueued so far. */
  get count(): number {
    return this.items.length;
  }

  /** Every enqueued item with the given reason. */
  withReason(reason: ReviewItem['reason']): ReviewItem[] {
    return this.items.filter((i) => i.reason === reason);
  }
}

/** Build a {@link ModelInput} with sensible defaults; override field-by-field. */
export function makeInput(overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    conversationId: 'conv-1',
    systemPrompt: 'You are a helpful assistant.',
    userContent: 'hello there',
    organizationId: 'org-1',
    ...overrides,
  };
}

/** Build a {@link ModelOutput} with sensible defaults; override field-by-field. */
export function makeOutput(overrides: Partial<ModelOutput> = {}): ModelOutput {
  return {
    conversationId: 'conv-1',
    content: 'a perfectly benign answer',
    organizationId: 'org-1',
    ...overrides,
  };
}
