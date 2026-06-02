/**
 * WebSocket_Gateway contract (Req 45.4, 45.5).
 *
 * The WebSocket_Gateway authenticates a connection via its presented JWT BEFORE
 * a session is established (Req 45.4) and then delivers the platform's real-time
 * server events to the relevant authenticated connection(s) (Req 45.5): chat
 * token / completion / error, agent step / completion, message, notification,
 * and budget alert.
 *
 * It is deliberately TRANSPORT-AGNOSTIC: the gateway never imports a socket
 * library. A connected client is modelled behind the narrow {@link WsConnection}
 * port — a real `ws`/Node adapter implements it later by serializing the typed
 * {@link WsServerEvent} into a wire frame and writing it — and authentication is
 * modelled behind the {@link Authenticator} port (structurally the shared
 * `AuthService.validate`). This keeps the gateway fully unit-testable with the
 * in-memory fakes in `./fakes` and free of any real socket, timer, or network.
 *
 * SECURITY: the JWT is verified before any session exists; an unauthenticated
 * connection never joins the registry and therefore never receives an event
 * (default-deny). No payload defined here carries a token, password, or secret.
 */

import type { SessionIdentity } from '@auxify/core';
import type { ChatFinishReason, PlatformError, TenantContext, TokenUsage } from '@auxify/types';

// ---------------------------------------------------------------------------
// Event taxonomy (Req 45.5)
// ---------------------------------------------------------------------------

/**
 * The exact set of server event types the gateway delivers (Req 45.5): chat
 * token, chat completion, chat error, agent step, agent completion, message,
 * notification, and budget alert.
 */
export type WsEventType =
  | 'chat.token'
  | 'chat.completion'
  | 'chat.error'
  | 'agent.step'
  | 'agent.completion'
  | 'message'
  | 'notification'
  | 'budget_alert';

/** All {@link WsEventType} values, for iteration, validation, and test generators. */
export const WS_EVENT_TYPES: readonly WsEventType[] = [
  'chat.token',
  'chat.completion',
  'chat.error',
  'agent.step',
  'agent.completion',
  'message',
  'notification',
  'budget_alert',
] as const;

/**
 * An incremental chat token delta delivered as the model produces it (Req 45.5,
 * mirroring the Streaming_Engine's token event, Req 4.2). Scoped to its
 * conversation so it reaches only that conversation's subscriber(s).
 */
export interface WsChatTokenEvent {
  /** Discriminant. */
  type: 'chat.token';
  /** The conversation this token belongs to (the delivery scope). */
  conversationId: string;
  /** The incremental text produced since the previous token. */
  delta: string;
  /** 0-based ordinal of this token within the stream. */
  index: number;
}

/**
 * The terminal chat completion event carrying the served model, total token
 * usage, and total cost (Req 45.5, mirroring the Streaming_Engine's completion
 * event, Req 4.3).
 */
export interface WsChatCompletionEvent {
  /** Discriminant. */
  type: 'chat.completion';
  /** The conversation this completion belongs to (the delivery scope). */
  conversationId: string;
  /** The model that produced the response. */
  model: string;
  /** Total token counts for the message. */
  usage: TokenUsage;
  /** Total cost for the message. */
  cost: number;
  /** Why generation stopped, when reported. */
  finishReason?: ChatFinishReason;
}

/**
 * A chat error event carrying the platform-wide serializable
 * {@link PlatformError} (Req 45.5, 46.8) — the same typed shape the REST_API
 * returns, never a raw exception or secret.
 */
export interface WsChatErrorEvent {
  /** Discriminant. */
  type: 'chat.error';
  /** The conversation the error pertains to, when scoped to one. */
  conversationId?: string;
  /** The typed, serializable error. */
  error: PlatformError;
}

/**
 * The salient, secret-free projection of an agent step record delivered in real
 * time as a run progresses (Req 45.5; mirrors the Agent_Runtime's
 * `AgentStepRecord`, Req 15.6, without coupling the gateway to that module).
 */
export interface WsAgentStep {
  /** The 1-based position of the step within the run. */
  stepNumber: number;
  /** The tool the step invoked (or attempted to invoke). */
  tool: string;
  /** The step's outcome classification (e.g. `ok`, `denied`). */
  outcome: string;
  /** The step's duration in milliseconds. */
  durationMs: number;
}

/** An agent step event delivered to a run's subscriber(s) (Req 45.5). */
export interface WsAgentStepEvent {
  /** Discriminant. */
  type: 'agent.step';
  /** The run this step belongs to (the delivery scope). */
  runId: string;
  /** The step record projection. */
  step: WsAgentStep;
}

/**
 * The terminal totals of an agent run delivered on completion (Req 45.5; the
 * reconciled totals of the Agent_Runtime's run result, Req 15.9).
 */
export interface WsAgentCompletionEvent {
  /** Discriminant. */
  type: 'agent.completion';
  /** The run that finished (the delivery scope). */
  runId: string;
  /** The terminal status of the run. */
  status: string;
  /** The total number of recorded steps. */
  totalSteps: number;
  /** The total tokens consumed across the run. */
  totalTokens: number;
  /** The total cost accrued across the run. */
  totalCost: number;
  /** The total wall-clock duration of the run in milliseconds. */
  totalDurationMs: number;
}

/** A delivered messaging message, secret-free (Req 45.5). */
export interface WsDeliveredMessage {
  /** The message's stable id. */
  id: string;
  /** The channel the message was posted to. */
  channelId: string;
  /** The id of the user who sent the message. */
  senderId: string;
  /** The message body. */
  body: string;
  /** The ISO-8601 creation timestamp. */
  createdAt: string;
}

/** A message-delivered event delivered to its recipient (Req 45.5). */
export interface WsMessageEvent {
  /** Discriminant. */
  type: 'message';
  /** The delivered message. */
  message: WsDeliveredMessage;
}

/** A user-facing notification, secret-free (Req 45.5). */
export interface WsNotification {
  /** The notification's stable id. */
  id: string;
  /** The notification kind (e.g. `mention`, `share`, `system`). */
  kind: string;
  /** A short human-readable title. */
  title: string;
  /** An optional longer body. */
  body?: string;
  /** The ISO-8601 creation timestamp. */
  createdAt: string;
}

/** A notification event delivered to the recipient user (Req 45.5). */
export interface WsNotificationEvent {
  /** Discriminant. */
  type: 'notification';
  /** The notification payload. */
  notification: WsNotification;
}

/** The scope a budget alert pertains to. */
export type WsBudgetScope = 'organization' | 'team' | 'project' | 'user';

/** A budget threshold alert, secret-free (Req 45.5). */
export interface WsBudgetAlert {
  /** The scope the budget applies to. */
  scope: WsBudgetScope;
  /** The id of the scoped entity (organization/team/project/user id). */
  scopeId: string;
  /** The configured budget limit. */
  limit: number;
  /** The amount consumed so far. */
  consumed: number;
  /** The fraction of the limit at which the alert fired (e.g. 0.8 for 80%). */
  threshold: number;
}

/** A budget alert event delivered to the relevant user (Req 45.5). */
export interface WsBudgetAlertEvent {
  /** Discriminant. */
  type: 'budget_alert';
  /** The budget alert payload. */
  alert: WsBudgetAlert;
}

/**
 * The discriminated union of every server event the gateway delivers (Req 45.5).
 * A {@link WsConnection} adapter switches on `type` to serialize the wire frame.
 */
export type WsServerEvent =
  | WsChatTokenEvent
  | WsChatCompletionEvent
  | WsChatErrorEvent
  | WsAgentStepEvent
  | WsAgentCompletionEvent
  | WsMessageEvent
  | WsNotificationEvent
  | WsBudgetAlertEvent;

// ---------------------------------------------------------------------------
// Transport and authentication ports
// ---------------------------------------------------------------------------

/**
 * The transport-agnostic port a single connected client is modelled behind.
 *
 * A production `ws`/Node adapter implements {@link send} by serializing the
 * typed event to a wire frame and writing it, and {@link close} by closing the
 * underlying socket with the given code. The gateway holds only this narrow
 * port, so it never imports a socket library. {@link send} may be synchronous or
 * return a promise; the gateway awaits it either way so back-pressure is
 * respected.
 */
export interface WsConnection {
  /** A stable, unique identifier for this connection. */
  readonly id: string;
  /**
   * Deliver one typed server event to the client (the adapter serializes it).
   *
   * @param event The typed event to transmit.
   */
  send(event: WsServerEvent): void | Promise<void>;
  /**
   * Close the connection with a WebSocket close code and optional reason.
   *
   * @param code The WebSocket close code (e.g. {@link WS_AUTH_FAILED_CLOSE_CODE}).
   * @param reason An optional human-readable, secret-free reason.
   */
  close(code: number, reason?: string): void;
}

/**
 * The parameters presented when a client connects.
 *
 * {@link token} is the JWT/access token the gateway verifies BEFORE establishing
 * a session (Req 45.4). The optional initial subscriptions let a client express,
 * at connect time, which conversation(s)/run(s) it wants to receive scoped
 * events for; further subscriptions can be added afterwards.
 */
export interface ConnectParams {
  /** The access token presented at connect; verified before any session exists (Req 45.4). */
  token?: string;
  /** Conversation ids to subscribe to immediately on a successful connect. */
  conversationIds?: string[];
  /** Agent run ids to subscribe to immediately on a successful connect. */
  runIds?: string[];
}

/**
 * The per-connection subscription set used to scope/target events (Req 45.5).
 *
 * A chat event reaches only sessions subscribed to its conversation; an agent
 * event reaches only sessions subscribed to its run. User-targeted events
 * (message, notification, budget alert) are routed by the session's
 * authenticated user id, not by these sets.
 */
export interface WsSubscriptions {
  /** Conversation ids this session receives chat events for. */
  conversationIds: Set<string>;
  /** Agent run ids this session receives agent events for. */
  runIds: Set<string>;
}

/**
 * An established, authenticated session (Req 45.4).
 *
 * It exists ONLY after the presented JWT has been verified, so holding a
 * {@link WsSession} is proof the connection is authenticated. It carries the
 * connection id, the auth-resolved {@link SessionIdentity}, the derived
 * {@link TenantContext} for tenant-scoped routing, and the connection's
 * {@link WsSubscriptions}.
 */
export interface WsSession {
  /** The id of the underlying connection. */
  readonly connectionId: string;
  /** The identity resolved from the verified access token. */
  readonly identity: SessionIdentity;
  /** The tenant scope derived from the identity. */
  readonly tenant: TenantContext;
  /** The conversation/run subscriptions used to scope events. */
  readonly subscriptions: WsSubscriptions;
}

/**
 * The authentication seam the gateway verifies a connection against (Req 45.4).
 *
 * It is structurally the shared `AuthService.validate`: it resolves a presented
 * access token to a {@link SessionIdentity} or throws when the token is missing,
 * unknown, expired, or revoked. Production wires the real `AuthService`; tests
 * substitute a deterministic fake. Modeling it as a narrow port keeps the
 * gateway testable without the full Auth_Service.
 */
export interface Authenticator {
  /**
   * Validate a presented access token (Req 45.4 / 33.8).
   *
   * @param accessToken The raw access token presented at connect.
   * @returns The identity resolved from the live session.
   * @throws when the token is unknown, expired, or revoked.
   */
  validate(accessToken: string): Promise<SessionIdentity>;
}

/**
 * A routing target for {@link import('./gateway').WebSocketGateway.publish}.
 *
 * Events are delivered ONLY to authenticated sessions matching the target:
 * a single connection, every session of a user, every subscriber of a
 * conversation, or every subscriber of an agent run.
 */
export type WsTarget =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'run'; runId: string };

/**
 * The WebSocket close code used when authentication fails (Req 45.4).
 *
 * 4401 is in the application-private 4000-4999 range and mirrors HTTP 401:
 * "the connection was closed because it presented no valid credentials".
 */
export const WS_AUTH_FAILED_CLOSE_CODE = 4401 as const;

/** The normal WebSocket close code used when the server tears a session down. */
export const WS_NORMAL_CLOSE_CODE = 1000 as const;
