/**
 * Chat_Pipeline typed error (Req 22.x, 34.x, 36.1).
 *
 * {@link ChatPipelineBlockedError} is the single typed block the Chat_Pipeline
 * raises when a request is refused at one of its fail-closed guards — the
 * request-edge Security_Gateway (`gateway`), the Budget_Manager cap check
 * (`budget`), or the Content_Safety_Filter input screening
 * (`content_safety_input`). The pipeline is fail-closed by construction: a
 * denial at any guard short-circuits the flow *before* the model is called and
 * *before* any spend or metric is recorded, so the block is the request's
 * terminal outcome.
 *
 * Rather than invent a new wire shape, this error composes the component
 * services' own projections: the Security_Gateway's
 * {@link import('../security-gateway/index.js').RequestDeniedError}, the
 * Budget_Manager's
 * {@link import('../budget/index.js').quotaExceededError}, and the
 * Content_Safety_Filter's
 * {@link import('../content-safety/index.js').ContentBlockedError} each already
 * project into the platform-wide serializable
 * {@link import('@auxify/types').PlatformError} (Req 46.8). This error carries
 * the blocking {@link ChatPipelineStage} alongside that projected
 * {@link PlatformError} so the carried wire shape is exactly the component's,
 * tagged with the stage that produced it, and {@link toPlatformError} returns it
 * verbatim.
 */

import type { PlatformError } from '@auxify/types';

import type { ChatPipelineStage } from './types.js';

/** The stable machine-readable code prefix for a Chat_Pipeline guard block. */
export const CHAT_PIPELINE_BLOCKED_CODE = 'CHAT_PIPELINE_BLOCKED' as const;

/**
 * Thrown (by the `*OrThrow` convenience path) when the Chat_Pipeline refuses a
 * request at a fail-closed guard (Req 22.x, 34.x, 36.1).
 *
 * {@link stage} names the guard that blocked — `gateway`, `budget`, or
 * `content_safety_input` — and {@link platformError} is the component service's
 * own projected, serializable error for that denial, so no detail is lost and
 * no new wire shape is introduced. The non-throwing {@link import('./chat-pipeline.js').ChatPipeline.run}
 * carries the same `(stage, platformError)` pair on its
 * {@link import('./types.js').ChatPipelineResult} instead of throwing.
 */
export class ChatPipelineBlockedError extends Error {
  /** The fail-closed guard that produced the block. */
  readonly stage: ChatPipelineStage;
  /** The component service's projected, serializable error for the denial (Req 46.8). */
  readonly platformError: PlatformError;

  constructor(stage: ChatPipelineStage, platformError: PlatformError) {
    super(`Chat pipeline blocked at the "${stage}" guard: ${platformError.message}`);
    this.name = 'ChatPipelineBlockedError';
    this.stage = stage;
    this.platformError = platformError;
  }

  /**
   * Return the carried platform error (Req 46.8).
   *
   * The projection already happened in the component service that raised the
   * denial; this returns that same serializable error verbatim so the blocking
   * stage's wire shape crosses the REST_API, WebSocket_Gateway, and SDK
   * unchanged.
   */
  toPlatformError(): PlatformError {
    return this.platformError;
  }
}
