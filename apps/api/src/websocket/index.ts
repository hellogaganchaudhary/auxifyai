/**
 * WebSocket_Gateway (Req 45.4, 45.5): authenticate-before-session plus scoped
 * delivery of the eight platform server events. Transport-agnostic — a real
 * `ws`/Node adapter implements the {@link WsConnection} port and production
 * wires the shared `AuthService` as the {@link Authenticator}. The test fakes in
 * `./fakes` are intentionally NOT re-exported here.
 */

export { WebSocketGateway, WsSessionError } from './gateway';
export type { WebSocketGatewayOptions } from './gateway';

export {
  WS_EVENT_TYPES,
  WS_AUTH_FAILED_CLOSE_CODE,
  WS_NORMAL_CLOSE_CODE,
} from './types';
export type {
  Authenticator,
  ConnectParams,
  WsAgentCompletionEvent,
  WsAgentStep,
  WsAgentStepEvent,
  WsBudgetAlert,
  WsBudgetAlertEvent,
  WsBudgetScope,
  WsChatCompletionEvent,
  WsChatErrorEvent,
  WsChatTokenEvent,
  WsConnection,
  WsDeliveredMessage,
  WsEventType,
  WsMessageEvent,
  WsNotification,
  WsNotificationEvent,
  WsServerEvent,
  WsSession,
  WsSubscriptions,
  WsTarget,
} from './types';
