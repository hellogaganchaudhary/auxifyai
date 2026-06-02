/**
 * @auxify/sdk — typed client SDK for the Auxify public REST/WebSocket API
 * (Requirement 45.6). It reuses the shared domain types from `@auxify/types`
 * so request/response shapes stay identical across client and server
 * (Requirement 46.8).
 *
 * Surface:
 *   - {@link AuxifyClient} — the typed client implementing {@link ClientSDK}:
 *     chat, streaming chat, agent runs, web search, knowledge-base search, and
 *     unified search, all over the shared `@auxify/types` shapes.
 *   - {@link HttpTransport} — the narrow, injectable wire-transport port, with
 *     the {@link FetchHttpTransport} default (global `fetch`) and the pure
 *     {@link parseSseChunk} SSE line parser.
 *   - The SDK request/result types ({@link ChatSendRequest}, {@link Message},
 *     {@link ChatEvent}, {@link AgentRunInput}, {@link AgentStepEvent},
 *     {@link SearchRequest}, {@link SearchResult}, {@link RetrievedContext},
 *     {@link GroupedResults}, …).
 *   - Re-exported `@auxify/types` error helpers consumers branch on
 *     ({@link PlatformError}, {@link Result}, {@link createPlatformError}, …).
 */

import { AUXIFY_TYPES_PACKAGE } from '@auxify/types';

export { AuxifyClient, AuxifyApiError, type ClientSDK } from './client';
export { FetchHttpTransport, parseSseChunk, type SseParseResult } from './transport';

export type {
  AgentRunInput,
  AgentStep,
  AgentStepEvent,
  ChatEvent,
  ChatSendRequest,
  GroupedResults,
  HttpTransport,
  Message,
  RetrievedChunk,
  RetrievedContext,
  SdkClientOptions,
  SearchRequest,
  SearchResult,
  SearchResultGroup,
  TransportFrame,
  TransportRequest,
  TransportResponse,
} from './types';

// Re-export the shared typed-error helpers consumers need to branch on a
// surfaced PlatformError without taking a direct `@auxify/types` dependency.
export {
  createPlatformError,
  httpStatusForError,
  isRetriableCategory,
  type ErrorCategory,
  type PlatformError,
  type Result,
} from '@auxify/types';

/** Package marker used to verify the SDK package and its type dependency. */
export const AUXIFY_SDK_PACKAGE = '@auxify/sdk' as const;

/** Re-exported so consumers can confirm the shared types link resolves. */
export const SHARED_TYPES_PACKAGE = AUXIFY_TYPES_PACKAGE;
