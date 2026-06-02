/**
 * The WebSocket_Gateway (Req 45.4, 45.5).
 *
 * Authenticates each connection via its presented JWT BEFORE a session is
 * established (Req 45.4), then delivers the eight platform server events to the
 * relevant authenticated connection(s) (Req 45.5). It is transport-agnostic: a
 * connected client is the narrow {@link WsConnection} port and authentication is
 * the {@link Authenticator} port, so the gateway imports no socket library and
 * is fully unit-testable with the fakes in `./fakes`.
 *
 * SECURITY (Req 45.4): a connection that presents no token, or an invalid one,
 * is closed with {@link WS_AUTH_FAILED_CLOSE_CODE} and a {@link WsSessionError}
 * is thrown; NO {@link WsSession} is registered, so the connection never appears
 * in any routing set and never receives an event (default-deny). Token values
 * are never logged or echoed.
 */

import { createPlatformError, type ChatFinishReason, type PlatformError, type TokenUsage } from '@auxify/types';

import type {
  Authenticator,
  ConnectParams,
  WsAgentStep,
  WsBudgetAlert,
  WsConnection,
  WsDeliveredMessage,
  WsNotification,
  WsServerEvent,
  WsSession,
  WsSubscriptions,
  WsTarget,
} from './types';
import { WS_AUTH_FAILED_CLOSE_CODE } from './types';

/**
 * Thrown by {@link WebSocketGateway.connect} when a connection cannot be
 * authenticated (Req 45.4). The gateway has already closed the connection with
 * {@link WS_AUTH_FAILED_CLOSE_CODE} and established NO session. The error
 * carries a non-secret {@link reason} and never the presented token.
 */
export class WsSessionError extends Error {
  /** A short, non-secret reason the connection was rejected. */
  readonly reason: 'missing_token' | 'invalid_token';

  constructor(reason: 'missing_token' | 'invalid_token') {
    super(
      reason === 'missing_token'
        ? 'WebSocket connection presented no access token'
        : 'WebSocket connection presented an invalid access token',
    );
    this.name = 'WsSessionError';
    this.reason = reason;
  }
}

/** Options for the {@link WebSocketGateway}. */
export interface WebSocketGatewayOptions {
  /**
   * Generates a correlation id for a {@link PlatformError} the gateway mints
   * itself (e.g. the auth-failure chat error). Defaults to a monotonic counter
   * so events are deterministic in tests.
   */
  correlationIdFactory?: () => string;
}

/** Internal registry entry binding a session to its live connection. */
interface Registered {
  readonly session: WsSession;
  readonly connection: WsConnection;
}

/**
 * The WebSocket_Gateway: authenticate-before-session plus scoped event delivery.
 */
export class WebSocketGateway {
  private readonly authenticator: Authenticator;
  private readonly correlationIdFactory: () => string;

  /** connectionId → registered authenticated session. */
  private readonly sessions = new Map<string, Registered>();

  constructor(authenticator: Authenticator, options: WebSocketGatewayOptions = {}) {
    this.authenticator = authenticator;
    let seq = 0;
    this.correlationIdFactory =
      options.correlationIdFactory ?? (() => `ws-${(seq += 1).toString(36)}`);
  }

  /** The number of currently-registered authenticated sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Authenticate a connection's JWT and, only on success, establish its session
   * (Req 45.4).
   *
   * The token is validated through the {@link Authenticator} BEFORE any session
   * exists. On a missing or invalid token the connection is closed with
   * {@link WS_AUTH_FAILED_CLOSE_CODE}, NO session is registered, and a
   * {@link WsSessionError} is thrown (the gateway's chosen, documented
   * rejection contract). On success an authenticated {@link WsSession} is
   * registered with its initial subscriptions and returned.
   *
   * @param connection The transport port for the connecting client.
   * @param params The connect parameters carrying the presented token.
   * @returns The established, authenticated session.
   * @throws WsSessionError when the token is missing or fails validation.
   */
  async connect(connection: WsConnection, params: ConnectParams): Promise<WsSession> {
    const token = params.token;
    if (token === undefined || token === '') {
      connection.close(WS_AUTH_FAILED_CLOSE_CODE, 'authentication required');
      throw new WsSessionError('missing_token');
    }

    let identity;
    try {
      identity = await this.authenticator.validate(token);
    } catch {
      // The token did not validate (unknown/expired/revoked). Close without a
      // session so the connection never joins a routing set, and never echo the
      // token value.
      connection.close(WS_AUTH_FAILED_CLOSE_CODE, 'authentication failed');
      throw new WsSessionError('invalid_token');
    }

    const subscriptions: WsSubscriptions = {
      conversationIds: new Set(params.conversationIds ?? []),
      runIds: new Set(params.runIds ?? []),
    };

    const session: WsSession = {
      connectionId: connection.id,
      identity,
      tenant: {
        organizationId: identity.organizationId,
        userId: identity.userId,
      },
      subscriptions,
    };

    this.sessions.set(connection.id, { session, connection });
    return session;
  }

  /**
   * Subscribe an established session to a conversation's chat events.
   *
   * @param connectionId The session to subscribe.
   * @param conversationId The conversation to receive chat events for.
   */
  subscribeConversation(connectionId: string, conversationId: string): void {
    this.sessions.get(connectionId)?.session.subscriptions.conversationIds.add(conversationId);
  }

  /**
   * Subscribe an established session to an agent run's events.
   *
   * @param connectionId The session to subscribe.
   * @param runId The agent run to receive step/completion events for.
   */
  subscribeRun(connectionId: string, runId: string): void {
    this.sessions.get(connectionId)?.session.subscriptions.runIds.add(runId);
  }

  /**
   * Tear down a session (Req 45.4 lifecycle).
   *
   * After disconnect the connection is removed from the registry, so no further
   * event is delivered to it.
   *
   * @param connectionId The connection whose session to remove.
   * @returns `true` if a session was removed, `false` if none existed.
   */
  disconnect(connectionId: string): boolean {
    return this.sessions.delete(connectionId);
  }

  /**
   * Deliver an event to every authenticated session matching a target (Req 45.5).
   *
   * Only registered (authenticated) sessions are considered — an unauthenticated
   * connection is never in the registry, so it can never be a delivery target
   * (default-deny). Returns the number of connections the event was delivered to.
   *
   * @param target Which session(s) the event is routed to.
   * @param event The typed server event to deliver.
   * @returns The count of connections the event was sent to.
   */
  async publish(target: WsTarget, event: WsServerEvent): Promise<number> {
    const recipients: Registered[] = [];
    for (const entry of this.sessions.values()) {
      if (this.matches(entry.session, target)) {
        recipients.push(entry);
      }
    }
    await Promise.all(recipients.map((entry) => entry.connection.send(event)));
    return recipients.length;
  }

  /**
   * Deliver an event to a single authenticated connection (Req 45.5).
   *
   * @param connectionId The target connection.
   * @param event The typed server event to deliver.
   * @returns `true` if the connection was authenticated and the event was sent.
   */
  async deliver(connectionId: string, event: WsServerEvent): Promise<boolean> {
    const entry = this.sessions.get(connectionId);
    if (entry === undefined) {
      return false;
    }
    await entry.connection.send(event);
    return true;
  }

  // --- convenience emit helpers (Req 45.5) ---------------------------------

  /** Emit an incremental chat token to a conversation's subscribers (Req 45.5). */
  async emitChatToken(conversationId: string, delta: string, index: number): Promise<number> {
    return this.publish(
      { kind: 'conversation', conversationId },
      { type: 'chat.token', conversationId, delta, index },
    );
  }

  /** Emit the terminal chat completion to a conversation's subscribers (Req 45.5). */
  async emitChatCompletion(
    conversationId: string,
    completion: {
      model: string;
      usage: TokenUsage;
      cost: number;
      finishReason?: ChatFinishReason;
    },
  ): Promise<number> {
    return this.publish(
      { kind: 'conversation', conversationId },
      {
        type: 'chat.completion',
        conversationId,
        model: completion.model,
        usage: completion.usage,
        cost: completion.cost,
        ...(completion.finishReason !== undefined ? { finishReason: completion.finishReason } : {}),
      },
    );
  }

  /**
   * Emit a typed chat error to a conversation's subscribers (Req 45.5).
   *
   * The error crosses the wire as the platform-wide {@link PlatformError} shape
   * (Req 46.8), never as a raw exception. When passed a bare message the gateway
   * mints an `internal` {@link PlatformError} with a fresh correlation id.
   */
  async emitChatError(conversationId: string, error: PlatformError | string): Promise<number> {
    const platformError: PlatformError =
      typeof error === 'string'
        ? createPlatformError({
            category: 'internal',
            code: 'WS_CHAT_ERROR',
            message: error,
            correlationId: this.correlationIdFactory(),
          })
        : error;
    return this.publish(
      { kind: 'conversation', conversationId },
      { type: 'chat.error', conversationId, error: platformError },
    );
  }

  /** Emit a real-time agent step to a run's subscribers (Req 45.5). */
  async emitAgentStep(runId: string, step: WsAgentStep): Promise<number> {
    return this.publish({ kind: 'run', runId }, { type: 'agent.step', runId, step });
  }

  /** Emit the terminal agent run totals to a run's subscribers (Req 45.5). */
  async emitAgentCompletion(
    runId: string,
    completion: {
      status: string;
      totalSteps: number;
      totalTokens: number;
      totalCost: number;
      totalDurationMs: number;
    },
  ): Promise<number> {
    return this.publish(
      { kind: 'run', runId },
      { type: 'agent.completion', runId, ...completion },
    );
  }

  /** Emit a delivered message to its recipient user's sessions (Req 45.5). */
  async emitMessage(recipientUserId: string, message: WsDeliveredMessage): Promise<number> {
    return this.publish({ kind: 'user', userId: recipientUserId }, { type: 'message', message });
  }

  /** Emit a notification to its recipient user's sessions (Req 45.5). */
  async emitNotification(
    recipientUserId: string,
    notification: WsNotification,
  ): Promise<number> {
    return this.publish(
      { kind: 'user', userId: recipientUserId },
      { type: 'notification', notification },
    );
  }

  /** Emit a budget alert to the relevant user's sessions (Req 45.5). */
  async emitBudgetAlert(recipientUserId: string, alert: WsBudgetAlert): Promise<number> {
    return this.publish(
      { kind: 'user', userId: recipientUserId },
      { type: 'budget_alert', alert },
    );
  }

  // --- internals -----------------------------------------------------------

  /** Whether an authenticated session matches a routing target. */
  private matches(session: WsSession, target: WsTarget): boolean {
    switch (target.kind) {
      case 'connection':
        return session.connectionId === target.connectionId;
      case 'user':
        return session.identity.userId === target.userId;
      case 'conversation':
        return session.subscriptions.conversationIds.has(target.conversationId);
      case 'run':
        return session.subscriptions.runIds.has(target.runId);
    }
  }
}
