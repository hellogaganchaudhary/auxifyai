/**
 * Chat_Service (Req 3.10, 5.8, and the chat send path of Req 4).
 *
 * The orchestrator that turns a user message into a fully persisted exchange:
 * it persists the user message, routes the conversation so far through the
 * Model_Router (selecting/falling back/recording the outcome — Req 3), persists
 * the assistant response with the served model, token counts, and cost
 * (Req 3.9, 44.6), applies a mid-conversation model switch that affects only
 * subsequent messages while preserving prior history (Req 3.10), and
 * auto-generates a title after the first exchange of a still-untitled
 * conversation without ever overwriting a user-assigned one (Req 5.8).
 *
 * This task implements the **send path, model switch, and title generation**;
 * editing/branching/regeneration/comparison/rating are task 8.7. Incremental
 * token relay to a client is deliberately the Streaming_Engine's job — the
 * service returns the routed result's collected chunks (plus usage/finish
 * reason) so a transport adapter can relay them (see the streaming seam in
 * `chat-service.ts`); this service owns durable persistence of the full
 * exchange.
 *
 * Every effect is an injectable port so the service is unit-testable with fakes
 * (a fake router returning a canned `RoutedChatResult`, in-memory repositories,
 * a fake title generator) — no real providers or network.
 *
 * Surface:
 *   - {@link ChatService} — the service (`send`, `switchModel`, `generateTitle`).
 *   - {@link RoutingPort} / {@link ChatConversationStore} / {@link ChatMessageStore}
 *     — the narrow ports it composes (satisfied by `ModelRouter` and the
 *     tenant-scoped repositories).
 *   - {@link TitleGenerator} and the default {@link DeterministicTitleGenerator}
 *     plus {@link normalizeTitle} — the pluggable title-generation seam (Req 5.8).
 *   - {@link ChatSendRequest} / {@link ChatSendResult} — the send input/output.
 *   - Content helpers ({@link toContentBlocks}, {@link blocksToText},
 *     {@link chunksToText}, {@link recordsToChatMessages}) used to move between
 *     persisted content blocks and model/title text.
 */

export {
  ChatService,
  type ChatServiceOptions,
  type EditMessageOptions,
  type MessageIdGenerator,
} from './chat-service.js';

export {
  DeterministicTitleGenerator,
  normalizeTitle,
  normalizeWhitespace,
  MAX_TITLE_LENGTH,
  FALLBACK_TITLE,
  type TitleGenerator,
  type TitleSource,
} from './title-generator.js';

export {
  blockToText,
  blocksToText,
  toContentBlocks,
  chunksToText,
  recordsToChatMessages,
} from './content.js';

export type {
  Branch,
  ChatCompareRequest,
  ChatConversationStore,
  ChatMessageStore,
  ChatSendRequest,
  ChatSendResult,
  CompareResult,
  MessageRating,
  RegenerateResult,
  RoutingPort,
} from './types.js';
