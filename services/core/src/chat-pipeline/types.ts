/**
 * Chat_Pipeline composition types (Req 4.1, 4.3, 22.1, 24.1, 31.1, 36.1, 36.3).
 *
 * The Chat_Pipeline is the platform's end-to-end *composition* of the existing
 * request-path services into the single ordered flow the design specifies:
 *
 *   Security_Gateway → Chat_Service → Budget_Manager → Content_Safety_Filter →
 *   RAG_Retriever → Model_Router (via the Chat_Service) → Provider →
 *   Streaming_Engine → Content_Safety_Filter (output) →
 *   Analytics_Service + Budget_Manager.
 *
 * It owns no domain logic of its own — every collaborator is one of the real
 * services, injected directly through {@link ChatPipelineOptions} — so this
 * module only defines the pipeline's request/result shapes. The narrow,
 * service-method ports are deliberately NOT redefined here: the Security_Gateway,
 * Budget_Manager, Content_Safety_Filter, RAG_Retriever, Chat_Service,
 * Streaming_Engine, and Analytics_Service are composed through their existing
 * public surfaces.
 *
 * A {@link ChatPipelineRequest} carries everything one chat send needs to flow
 * through every guard: the edge {@link GatewayRequest} (consulted only when a
 * Security_Gateway is wired), the tenant {@link TenantContext}, the
 * authenticated {@link Principal}, the {@link ChatSendRequest} chat-send fields,
 * the {@link EventSink} the Streaming_Engine relays to, a knowledge-enabled flag
 * (Req 24.1), and the targeted model tier for the Budget_Manager cap check
 * (Req 22.x). A {@link ChatPipelineResult} carries the SSE relay handle (the
 * {@link StreamResult}), the persisted assistant exchange (the
 * {@link ChatSendResult}), the {@link BudgetDecision}, the input/output safety
 * decisions ({@link ScreenedInput} / {@link ScannedOutput}), the RAG attribution
 * ({@link RetrievedContext}), and the recorded analytics {@link RequestMetric} —
 * or, on a fail-closed block, the blocking {@link ChatPipelineStage} and the
 * carried {@link PlatformError}.
 */

import type { ModelTier, PlatformError, Principal, TenantContext } from '@auxify/types';

import type { ScannedOutput, ScreenedInput } from '../content-safety/index.js';
import type { RetrieveOptions, RetrievedContext } from '../knowledge/index.js';
import type { BudgetDecision } from '../budget/index.js';
import type { ChatSendRequest, ChatSendResult } from '../chat/index.js';
import type { EventSink, StreamResult } from '../streaming/index.js';
import type { GatewayVerdict, GatewayRequest } from '../security-gateway/index.js';
import type { RequestMetric } from '../analytics/index.js';

/**
 * The ordered stage of the Chat_Pipeline that can fail a request closed
 * (Req 22.x, 34.x, 36.1).
 *
 * Each is a *guard* the request must positively pass before the model is ever
 * called and before any spend is recorded: the request-edge
 * {@link import('../security-gateway/index.js').SecurityGateway} (`gateway`),
 * the {@link import('../budget/index.js').BudgetManager} cap check (`budget`),
 * and the {@link import('../content-safety/index.js').ContentSafetyFilter}
 * input screening (`content_safety_input`). A denial at any of them
 * short-circuits the pipeline fail-closed.
 */
export type ChatPipelineStage = 'gateway' | 'budget' | 'content_safety_input';

/** All {@link ChatPipelineStage} values, for iteration and test generators. */
export const CHAT_PIPELINE_STAGES: readonly ChatPipelineStage[] = [
  'gateway',
  'budget',
  'content_safety_input',
] as const;

/**
 * One chat request to run through the full Chat_Pipeline (Req 4.1, 22.1, 24.1,
 * 36.1).
 *
 * It bundles the edge request the Security_Gateway evaluates (only consulted
 * when a gateway is wired), the tenant scope, the authenticated principal, the
 * chat-send fields the Chat_Service persists and routes, the transport sink the
 * Streaming_Engine relays tokens to, and the per-request RAG / budget knobs. The
 * user content carried on {@link send} is screened (and PII-masked, Req 36.1)
 * before it is forwarded to the model.
 */
export interface ChatPipelineRequest {
  /** The tenant scope the request runs in (Organization, Req 1.2). */
  ctx: TenantContext;
  /** The authenticated actor the Model_Router and RAG_Retriever act on (Req 3, 24.3). */
  principal: Principal;
  /** The chat-send fields (conversation, content, optional model/system prompt). */
  send: ChatSendRequest;
  /** The transport sink the streamed token + completion events are relayed to (Req 4.1, 4.3). */
  sink: EventSink;
  /** The tier of the targeted model, for the Budget_Manager team-cap check (Req 22.4). */
  modelTier: ModelTier;
  /**
   * The edge request descriptor the {@link import('../security-gateway/index.js').SecurityGateway}
   * evaluates (Req 34.x). Consulted only when a gateway is wired; required then.
   */
  gatewayRequest?: GatewayRequest;
  /** Whether to retrieve attributed knowledge (RAG) for this request (Req 24.1). */
  knowledgeEnabled?: boolean;
  /** The query used for RAG retrieval; defaults to the user message text (Req 24.1). */
  knowledgeQuery?: string;
  /** Per-query RAG tuning (top-K, relevance threshold) (Req 24.2, 24.7). */
  retrieveOptions?: RetrieveOptions;
  /** Cooperative cancellation signal forwarded to the Streaming_Engine (Req 4.4). */
  signal?: AbortSignal;
  /** Correlation id tying a fail-closed {@link PlatformError} to logs/traces (Req 46.7). */
  correlationId?: string;
}

/**
 * The outcome of a completed (or fail-closed) Chat_Pipeline run (Req 4.1, 4.3,
 * 22.1, 24.1, 31.1, 36.1, 36.3).
 *
 * On success {@link ok} is `true` and the per-stage results are populated: the
 * {@link gatewayVerdict} (when a gateway ran), the {@link budgetDecision}, the
 * {@link screenedInput} (PII-masked, Req 36.1), the {@link retrieval} attribution
 * (when knowledge was enabled, Req 24.1), the persisted {@link send} exchange,
 * the {@link stream} relay handle carrying the token + completion events
 * (Req 4.1, 4.3), the {@link scannedOutput} (PII-scanned before delivery,
 * Req 36.3), and the recorded analytics {@link metric} (Req 31.1).
 *
 * On a fail-closed block {@link ok} is `false`, {@link blockedStage} names the
 * guard that refused the request, {@link error} carries the projected
 * serializable {@link PlatformError}, and the downstream fields are absent — no
 * model was called and no spend or metric was recorded.
 */
export interface ChatPipelineResult {
  /** Whether the request passed every guard and completed the flow. */
  ok: boolean;
  /** The guard that blocked the request, present only when {@link ok} is `false`. */
  blockedStage?: ChatPipelineStage;
  /** The projected platform error carried on a fail-closed block (Req 46.8). */
  error?: PlatformError;
  /** The Security_Gateway verdict, present when a gateway was wired and evaluated. */
  gatewayVerdict?: GatewayVerdict;
  /** The Budget_Manager decision, present once budget enforcement ran (Req 22.x). */
  budgetDecision?: BudgetDecision;
  /** The input safety decision and PII-masked input, present once screening ran (Req 36.1). */
  screenedInput?: ScreenedInput;
  /** The RAG retrieval and attribution, present when knowledge was enabled (Req 24.1). */
  retrieval?: RetrievedContext;
  /** The persisted chat exchange and routed chunks, present on success (Req 3, 4.2). */
  send?: ChatSendResult;
  /** The Streaming_Engine relay handle (the SSE/WS relay outcome), present on success (Req 4.1, 4.3). */
  stream?: StreamResult;
  /** The output safety decision and PII-masked delivered content, present on success (Req 36.3). */
  scannedOutput?: ScannedOutput;
  /** The recorded analytics metric, present once the request was recorded (Req 31.1). */
  metric?: RequestMetric;
}
