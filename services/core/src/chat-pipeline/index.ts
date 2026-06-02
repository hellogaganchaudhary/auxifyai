/**
 * Chat_Pipeline (Req 4.1, 4.3, 22.1, 24.1, 31.1, 36.1, 36.3): the end-to-end
 * composition of the streaming-chat-with-RAG request flow.
 *
 * The {@link ChatPipeline} is a COMPOSITION over the platform's already-built
 * request-path services — it owns no domain logic of its own, wiring the
 * existing services through their existing public surfaces into the single
 * ordered flow the design specifies:
 *
 *   Security_Gateway → Chat_Service → Budget_Manager → Content_Safety_Filter →
 *   RAG_Retriever → Model_Router → Provider → Streaming_Engine →
 *   Content_Safety_Filter (output) → Analytics_Service + Budget_Manager.
 *
 * {@link ChatPipeline.run} executes one chat send through every guard in order
 * and records cost + metrics at the end: it evaluates the request-edge
 * {@link import('../security-gateway/index.js').SecurityGateway} (when wired,
 * Req 34.x); enforces the {@link import('../budget/index.js').BudgetManager}
 * caps before any model call (Req 22.x); screens the input through the
 * {@link import('../content-safety/index.js').ContentSafetyFilter}, PII-masking
 * it and preserving the system prompt unchanged (Req 36.1); retrieves the
 * attributed top-K chunks (or the explicit "none found" signal) through the
 * {@link import('../knowledge/index.js').RagRetriever} when knowledge is enabled
 * (Req 24.1); routes + generates through the
 * {@link import('../chat/index.js').ChatService} (Model_Router → provider,
 * Req 3); relays the collected chunks token-by-token through the
 * {@link import('../streaming/index.js').StreamingEngine} and emits a completion
 * event carrying the model, total tokens, and total cost (Req 4.1, 4.3); scans
 * the delivered output for PII before delivery (Req 36.3); and records the
 * request in the {@link import('../analytics/index.js').AnalyticsService}
 * (Req 31.1) while attributing the cost up the user → Project → Team →
 * Organization hierarchy via the Budget_Manager (Req 22.1).
 *
 * The pipeline is FAIL-CLOSED: any guard denial short-circuits the flow with a
 * {@link ChatPipelineResult} (`ok: false`) carrying the blocking
 * {@link ChatPipelineStage} and the component service's projected
 * {@link import('@auxify/types').PlatformError} — before the model is called and
 * before any spend or metric is recorded. {@link ChatPipeline.runOrThrow} raises
 * a typed {@link ChatPipelineBlockedError} carrying the same on a block. The
 * Security_Gateway and RAG_Retriever are optional so the pipeline is testable in
 * slices; the remaining collaborators are always required.
 *
 * Surface:
 *   - {@link ChatPipeline} — the orchestrator (`run` / `runOrThrow`) and its
 *     {@link ChatPipelineOptions} composition shape.
 *   - {@link ChatPipelineRequest} / {@link ChatPipelineResult} — the pipeline's
 *     request and result shapes, plus the {@link ChatPipelineStage} vocabulary
 *     ({@link CHAT_PIPELINE_STAGES}).
 *   - {@link ChatPipelineBlockedError} / {@link CHAT_PIPELINE_BLOCKED_CODE} — the
 *     typed fail-closed block, projecting to the component's serializable error.
 *
 * The wire helpers and the capturing event sink live in `./fakes.js` and are
 * intentionally NOT re-exported from this barrel — following the established
 * convention, the tests import them (and the component modules' own fakes)
 * directly. The pipeline composes the component services' public types directly
 * and re-exports none of them here, so this barrel introduces no duplicate
 * export at the package barrel.
 */

export {
  ChatPipeline,
  type ChatPipelineOptions,
} from './chat-pipeline.js';

export {
  ChatPipelineBlockedError,
  CHAT_PIPELINE_BLOCKED_CODE,
} from './errors.js';

export {
  CHAT_PIPELINE_STAGES,
  type ChatPipelineStage,
  type ChatPipelineRequest,
  type ChatPipelineResult,
} from './types.js';
