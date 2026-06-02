/**
 * Chat_Pipeline — the end-to-end streaming-chat-with-RAG request flow
 * (Req 4.1, 4.3, 22.1, 24.1, 31.1, 36.1, 36.3).
 *
 * The {@link ChatPipeline} composes the platform's already-built request-path
 * services into the single ordered flow the design specifies, owning no domain
 * logic of its own — it orchestrates the real services through their existing
 * public surfaces and runs one chat send through every guard, recording cost and
 * metrics at the end:
 *
 *   1. **Security_Gateway (Req 34.x).** When a gateway is wired, the edge
 *      request is evaluated first; a deny verdict STOPS the pipeline fail-closed
 *      (no model call, no spend), carrying the gateway's projected
 *      {@link import('@auxify/types').PlatformError}.
 *   2. **Budget_Manager (Req 22.x).** The targeted model + tier are checked
 *      against the user/team/per-model caps; a block decision STOPS fail-closed
 *      before any model call.
 *   3. **Content_Safety_Filter input (Req 36.1).** The user content is screened
 *      and PII-masked, and the configured system prompt is preserved unchanged;
 *      a blocked input STOPS fail-closed. The masked content is what is forwarded
 *      to the model.
 *   4. **RAG_Retriever (Req 24.1).** When knowledge is enabled, the attributed
 *      top-K chunks (or the explicit "no relevant knowledge found" signal) are
 *      attached to the model context.
 *   5. **Chat_Service → Model_Router → Provider (Req 3, 4.2).** The send is
 *      routed and the assistant exchange persisted; the provider's collected
 *      chunks are returned for relay.
 *   6. **Streaming_Engine (Req 4.1, 4.3).** The chunks are relayed to the
 *      caller's {@link import('../streaming/index.js').EventSink} token-by-token,
 *      then a completion event carrying the model, total tokens, and total cost
 *      is emitted.
 *   7. **Content_Safety_Filter output (Req 36.3).** The delivered text is
 *      scanned and PII-masked before it is considered delivered.
 *   8. **Analytics + Budget (Req 31.1, 22.1).** The request is recorded as one
 *      analytics metric (model/provider/tokens/cost/latency/requestType/
 *      toolCallCount) AND its cost is attributed up the user → Project → Team →
 *      Organization hierarchy.
 *
 * The pipeline is FAIL-CLOSED by construction: each guard can only deny, and the
 * first denial short-circuits the flow before the model is called and before any
 * spend or metric is recorded. The Security_Gateway and RAG_Retriever are
 * optional so the pipeline is testable in slices; the Budget_Manager,
 * Content_Safety_Filter, Chat_Service, Streaming_Engine, and Analytics_Service
 * are always required.
 */

import { randomUUID } from 'node:crypto';

import type { ChatChunk } from '@auxify/types';

import { AnalyticsService } from '../analytics/index.js';
import { BudgetManager, quotaExceededError } from '../budget/index.js';
import { ContentBlockedError, ContentSafetyFilter } from '../content-safety/index.js';
import { blocksToText, ChatService, toContentBlocks } from '../chat/index.js';
import type { ChatSendRequest } from '../chat/index.js';
import {
  NO_RELEVANT_KNOWLEDGE_MESSAGE,
  RagRetriever,
  type RetrievedContext,
} from '../knowledge/index.js';
import { AUTO_MODEL_ID } from '../router/index.js';
import {
  RequestDeniedError,
  SecurityGateway,
  type GatewayVerdict,
} from '../security-gateway/index.js';
import { StreamingEngine, type StreamContext } from '../streaming/index.js';

import { ChatPipelineBlockedError } from './errors.js';
import type { ChatPipelineRequest, ChatPipelineResult } from './types.js';

/**
 * The services the {@link ChatPipeline} composes.
 *
 * The Security_Gateway and RAG_Retriever are optional (so the pipeline can be
 * exercised in slices and so a deployment without RAG still works); every other
 * collaborator is the real, required service injected directly — the pipeline
 * adds no port indirection over them.
 */
export interface ChatPipelineOptions {
  /** The request-edge guard; when wired, every request is evaluated through it first (Req 34.x). */
  securityGateway?: SecurityGateway;
  /** The spend-cap guard and cost-attribution sink (Req 22.1, 22.x). */
  budget: BudgetManager;
  /** The input/output safety screen (Req 36.1, 36.3). */
  contentSafety: ContentSafetyFilter;
  /** The retrieval-augmentation source; consulted only when knowledge is enabled (Req 24.1). */
  rag?: RagRetriever;
  /** The send orchestrator that routes through the Model_Router and persists the exchange (Req 3). */
  chat: ChatService;
  /** The token-by-token relay that emits the completion event (Req 4.1, 4.3). */
  streaming: StreamingEngine;
  /** The per-request metric recorder (Req 31.1). */
  analytics: AnalyticsService;
}

/**
 * Turn the Model_Router's collected chunks into the async source the
 * {@link StreamingEngine} relays (Req 4.2).
 *
 * The router *collects* a provider's chunks (it cannot transparently retry a
 * partially-streamed model), so the pipeline re-streams that collected array
 * through the engine to deliver the tokens incrementally to the client.
 */
async function* asAsyncChunks(chunks: readonly ChatChunk[]): AsyncGenerator<ChatChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * Compose a model-context preamble from a RAG retrieval (Req 24.1, 24.4, 24.7).
 *
 * On a hit, each attributed chunk is rendered with its source title and link so
 * the model can ground and cite its answer (Req 24.4); on a miss, the explicit
 * "no relevant knowledge found" signal is surfaced verbatim (Req 24.7).
 */
function knowledgeContext(retrieval: RetrievedContext): string {
  if (!retrieval.found) {
    return retrieval.message ?? NO_RELEVANT_KNOWLEDGE_MESSAGE;
  }
  const lines = retrieval.chunks.map(
    (chunk, index) =>
      `[${index + 1}] ${chunk.text} (source: ${chunk.attribution.sourceTitle}, ${chunk.attribution.link})`,
  );
  return ['Relevant knowledge:', ...lines].join('\n');
}

/** Join the (possibly empty) system prompt and knowledge preamble into one prompt. */
function combinePrompt(systemPrompt: string, knowledge: string | undefined): string {
  return [systemPrompt, knowledge].filter((part) => part !== undefined && part !== '').join('\n\n');
}

/**
 * The Chat_Pipeline. Construct once with its composed services, then call
 * {@link run} (non-throwing, returns a {@link ChatPipelineResult}) or
 * {@link runOrThrow} (raises {@link ChatPipelineBlockedError} on a guard block)
 * per chat request.
 */
export class ChatPipeline {
  private readonly securityGateway: SecurityGateway | undefined;
  private readonly budget: BudgetManager;
  private readonly contentSafety: ContentSafetyFilter;
  private readonly rag: RagRetriever | undefined;
  private readonly chat: ChatService;
  private readonly streaming: StreamingEngine;
  private readonly analytics: AnalyticsService;

  constructor(options: ChatPipelineOptions) {
    this.securityGateway = options.securityGateway;
    this.budget = options.budget;
    this.contentSafety = options.contentSafety;
    this.rag = options.rag;
    this.chat = options.chat;
    this.streaming = options.streaming;
    this.analytics = options.analytics;
  }

  /**
   * Run one chat request through the full pipeline, returning the structured
   * {@link ChatPipelineResult} (Req 4.1, 4.3, 22.1, 24.1, 31.1, 36.1, 36.3).
   *
   * Every guard is applied in order; the first denial short-circuits with
   * `ok: false`, the blocking {@link import('./types.js').ChatPipelineStage}, and
   * the component service's projected {@link import('@auxify/types').PlatformError}
   * — and NO model is called and NO spend or metric is recorded. When every
   * guard passes, the result carries the per-stage outputs, the streamed relay
   * handle, the PII-scanned delivered output, the recorded metric, and the
   * attributed cost.
   *
   * @param request The chat request plus its tenant/principal/transport context.
   * @returns The pipeline result; a guard block sets `ok: false` and never throws.
   */
  async run(request: ChatPipelineRequest): Promise<ChatPipelineResult> {
    const correlationId = request.correlationId ?? randomUUID();

    // Stage 1 — Security_Gateway (Req 34.x). A deny STOPS fail-closed.
    const gatewayVerdict = await this.runGateway(request, correlationId);
    if (gatewayVerdict !== undefined && !gatewayVerdict.verdict.allowed) {
      return gatewayVerdict.blocked;
    }

    // Stage 2 — Budget_Manager cap check (Req 22.3, 22.4, 22.5). A block STOPS
    // fail-closed BEFORE any model call.
    const budgetDecision = await this.budget.enforce(request.ctx, {
      modelId: request.send.modelId ?? AUTO_MODEL_ID,
      modelTier: request.modelTier,
    });
    if (!budgetDecision.allowed) {
      return {
        ok: false,
        blockedStage: 'budget',
        error: quotaExceededError(budgetDecision, correlationId),
        ...(gatewayVerdict !== undefined ? { gatewayVerdict: gatewayVerdict.verdict } : {}),
        budgetDecision,
      };
    }

    // Stage 3 — Content_Safety_Filter input screening (Req 36.1). A block STOPS
    // fail-closed; otherwise the PII-masked content is forwarded to the model.
    const userContent = blocksToText(toContentBlocks(request.send.content));
    const screenedInput = await this.contentSafety.screenInput({
      conversationId: request.send.conversationId,
      systemPrompt: request.send.systemPrompt ?? '',
      userContent,
      organizationId: request.ctx.organizationId,
      userId: request.ctx.userId,
    });
    if (screenedInput.decision.blocked) {
      return {
        ok: false,
        blockedStage: 'content_safety_input',
        error: new ContentBlockedError('input', screenedInput.decision).toPlatformError(
          correlationId,
        ),
        ...(gatewayVerdict !== undefined ? { gatewayVerdict: gatewayVerdict.verdict } : {}),
        budgetDecision,
        screenedInput,
      };
    }

    // Stage 4 — RAG_Retriever (Req 24.1), when knowledge is enabled. Attach the
    // attributed top-K chunks (or the "none found" signal) to the model context.
    let retrieval: RetrievedContext | undefined;
    if (this.rag !== undefined && request.knowledgeEnabled === true) {
      const query = request.knowledgeQuery ?? screenedInput.userContent;
      retrieval = await this.rag.retrieve(query, request.principal, request.retrieveOptions ?? {});
    }
    const effectiveSystemPrompt = combinePrompt(
      screenedInput.systemPrompt,
      retrieval !== undefined ? knowledgeContext(retrieval) : undefined,
    );

    // Stage 5 — route + generate via the Chat_Service (Model_Router → provider,
    // Req 3). The masked content (Req 36.1) and the RAG-augmented system prompt
    // are what the model sees.
    const sendRequest: ChatSendRequest = {
      ...request.send,
      content: screenedInput.userContent,
      ...(effectiveSystemPrompt !== '' ? { systemPrompt: effectiveSystemPrompt } : {}),
    };
    const send = await this.chat.send(request.ctx, sendRequest, request.principal);

    // Stage 6 — Streaming_Engine relay (Req 4.1, 4.3). Relay each token, then a
    // completion event carrying the served model, total tokens, and total cost.
    const streamContext: StreamContext = {
      target: { conversationId: send.conversationId, messageId: send.assistantMessage.id },
      cost: send.outcome.cost,
      modelId: send.outcome.modelId,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    };
    const stream = await this.streaming.stream(
      asAsyncChunks(send.chunks),
      request.sink,
      streamContext,
    );

    // Stage 7 — Content_Safety_Filter output scan (Req 36.3). PII-mask the
    // delivered text before it is considered delivered.
    const scannedOutput = await this.contentSafety.scanOutput({
      conversationId: send.conversationId,
      content: stream.text,
      organizationId: request.ctx.organizationId,
      userId: request.ctx.userId,
    });

    // Stage 8 — record one analytics metric (Req 31.1) AND attribute the cost up
    // the hierarchy (Req 22.1). The two share the served model/provider/tokens/
    // cost/latency the Model_Router recorded.
    const provider = send.decision.model.provider;
    const metric = await this.analytics.recordRequest(request.ctx, {
      model: send.outcome.modelId,
      provider,
      inputTokens: send.outcome.inputTokens,
      outputTokens: send.outcome.outputTokens,
      costUsd: send.outcome.cost,
      latencyMs: send.outcome.latencyMs,
      requestType: 'chat',
      toolCallCount: 0,
    });
    await this.budget.recordUsage(request.ctx, {
      model: send.outcome.modelId,
      provider,
      inputTokens: send.outcome.inputTokens,
      outputTokens: send.outcome.outputTokens,
      cost: send.outcome.cost,
      latencyMs: send.outcome.latencyMs,
      requestType: 'chat',
    });

    return {
      ok: true,
      ...(gatewayVerdict !== undefined ? { gatewayVerdict: gatewayVerdict.verdict } : {}),
      budgetDecision,
      screenedInput,
      ...(retrieval !== undefined ? { retrieval } : {}),
      send,
      stream,
      scannedOutput,
      metric,
    };
  }

  /**
   * Like {@link run}, but throws {@link ChatPipelineBlockedError} on a
   * fail-closed guard block (carrying the blocking stage and the component's
   * projected error) and resolves to the successful {@link ChatPipelineResult}
   * otherwise. Edge callers use this to fail closed with a single throw site.
   *
   * @param request The chat request to run.
   * @returns The successful pipeline result.
   * @throws {ChatPipelineBlockedError} When a guard blocks the request.
   */
  async runOrThrow(request: ChatPipelineRequest): Promise<ChatPipelineResult> {
    const result = await this.run(request);
    if (!result.ok) {
      // `ok: false` always carries a stage and a projected error.
      throw new ChatPipelineBlockedError(
        result.blockedStage ?? 'gateway',
        result.error ?? quotaExceededError(
          { allowed: false, kind: 'block_user_cap', reason: 'blocked' },
          request.correlationId ?? 'chat-pipeline',
        ),
      );
    }
    return result;
  }

  /**
   * Evaluate the Security_Gateway when one is wired (Req 34.x).
   *
   * Returns `undefined` when no gateway is configured (the pipeline runs without
   * an edge guard, e.g. in a slice). Otherwise returns the verdict plus the
   * pre-built fail-closed {@link ChatPipelineResult} for a denial, so {@link run}
   * can short-circuit without re-deriving the projection.
   */
  private async runGateway(
    request: ChatPipelineRequest,
    correlationId: string,
  ): Promise<{ verdict: GatewayVerdict; blocked: ChatPipelineResult } | undefined> {
    if (this.securityGateway === undefined) {
      return undefined;
    }
    const gatewayRequest = request.gatewayRequest;
    if (gatewayRequest === undefined) {
      throw new Error(
        'ChatPipeline: a securityGateway is configured but the request carries no gatewayRequest to evaluate',
      );
    }
    const verdict = await this.securityGateway.evaluate(gatewayRequest);
    const blocked: ChatPipelineResult = {
      ok: false,
      blockedStage: 'gateway',
      error: new RequestDeniedError(verdict).toPlatformError(correlationId),
      gatewayVerdict: verdict,
    };
    return { verdict, blocked };
  }
}
