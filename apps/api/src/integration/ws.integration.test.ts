/**
 * Integration tests for the WebSocket_Gateway delivery contract (Req 45.5,
 * exercising Req 45.4 default-deny as part of delivery scoping).
 *
 * The Client_SDK in this codebase does not itself open a WebSocket, so the
 * server side of the same realtime contract is driven directly: a
 * {@link FakeWsConnection} is connected through the REAL {@link WebSocketGateway}
 * (JWT-before-session) and we assert the gateway delivers every platform server
 * event — chat token / completion / error, agent step / completion, message,
 * notification, and budget alert — to the subscribed connection, while a
 * connection with no/invalid token is closed and receives nothing (default-deny,
 * Req 45.4).
 */

import { describe, expect, it } from 'vitest';

import { FakeAuthenticator, FakeWsConnection, fakeIdentity } from '../websocket/fakes';
import { WebSocketGateway, WsSessionError } from '../websocket/gateway';
import { WS_AUTH_FAILED_CLOSE_CODE, WS_EVENT_TYPES } from '../websocket/types';

const VALID_TOKEN = 'valid-jwt';

/** Build a gateway whose authenticator accepts a single valid token. */
function makeGateway(): WebSocketGateway {
  const auth = new FakeAuthenticator({
    [VALID_TOKEN]: fakeIdentity({ userId: 'user-1', organizationId: 'org-1' }),
  });
  return new WebSocketGateway(auth);
}

describe('WebSocket_Gateway integration — scoped event delivery (Req 45.5)', () => {
  it('delivers all eight server event types to a subscribed, authenticated connection', async () => {
    const gateway = makeGateway();
    const conn = new FakeWsConnection('c1');

    // JWT verified BEFORE the session is established (Req 45.4).
    const session = await gateway.connect(conn, {
      token: VALID_TOKEN,
      conversationIds: ['conv-A'],
      runIds: ['run-A'],
    });
    expect(session.identity.userId).toBe('user-1');
    expect(gateway.sessionCount).toBe(1);

    await gateway.emitChatToken('conv-A', 'Hel', 0);
    await gateway.emitChatCompletion('conv-A', {
      model: 'gpt-x',
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: 0.02,
      finishReason: 'stop',
    });
    await gateway.emitChatError('conv-A', 'provider failed');
    await gateway.emitAgentStep('run-A', {
      stepNumber: 1,
      tool: 'web.search',
      outcome: 'ok',
      durationMs: 42,
    });
    await gateway.emitAgentCompletion('run-A', {
      status: 'completed',
      totalSteps: 1,
      totalTokens: 15,
      totalCost: 0.02,
      totalDurationMs: 42,
    });
    await gateway.emitMessage('user-1', {
      id: 'm1',
      channelId: 'ch1',
      senderId: 'user-2',
      body: 'hello',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await gateway.emitNotification('user-1', {
      id: 'n1',
      kind: 'mention',
      title: 'You were mentioned',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await gateway.emitBudgetAlert('user-1', {
      scope: 'organization',
      scopeId: 'org-1',
      limit: 100,
      consumed: 80,
      threshold: 0.8,
    });

    const types = conn.sent.map((e) => e.type);
    expect(types).toEqual([...WS_EVENT_TYPES]);
  });

  it('scopes chat/agent events to their subscribed connection only', async () => {
    const auth = new FakeAuthenticator({
      tokenA: fakeIdentity({ userId: 'user-A', organizationId: 'org-1' }),
      tokenB: fakeIdentity({ userId: 'user-B', organizationId: 'org-1' }),
    });
    const gateway = new WebSocketGateway(auth);

    const connA = new FakeWsConnection('cA');
    const connB = new FakeWsConnection('cB');
    await gateway.connect(connA, { token: 'tokenA', conversationIds: ['conv-A'], runIds: ['run-A'] });
    await gateway.connect(connB, { token: 'tokenB', conversationIds: ['conv-B'], runIds: ['run-B'] });

    expect(await gateway.emitChatToken('conv-A', 'hi', 0)).toBe(1);
    expect(await gateway.emitAgentStep('run-A', { stepNumber: 1, tool: 't', outcome: 'ok', durationMs: 1 })).toBe(1);

    expect(connA.sent.map((e) => e.type)).toEqual(['chat.token', 'agent.step']);
    expect(connB.sent).toHaveLength(0);
  });
});

describe('WebSocket_Gateway integration — default-deny (Req 45.4, 45.5)', () => {
  it('closes a connection with NO token and delivers nothing to it', async () => {
    const gateway = makeGateway();
    const conn = new FakeWsConnection('c1');

    await expect(gateway.connect(conn, {})).rejects.toBeInstanceOf(WsSessionError);
    expect(conn.closes[0]?.code).toBe(WS_AUTH_FAILED_CLOSE_CODE);
    expect(gateway.sessionCount).toBe(0);

    // No routing target can reach an unauthenticated connection.
    expect(
      await gateway.deliver('c1', {
        type: 'notification',
        notification: { id: 'n1', kind: 'system', title: 'hi', createdAt: '2026-01-01T00:00:00Z' },
      }),
    ).toBe(false);
    expect(conn.sent).toHaveLength(0);
  });

  it('closes a connection with an INVALID token (verified before any session) and delivers nothing', async () => {
    const gateway = makeGateway();
    const conn = new FakeWsConnection('c1');

    await expect(gateway.connect(conn, { token: 'bogus' })).rejects.toMatchObject({
      reason: 'invalid_token',
    });
    expect(conn.closes[0]?.code).toBe(WS_AUTH_FAILED_CLOSE_CODE);
    expect(gateway.sessionCount).toBe(0);
    expect(conn.sent).toHaveLength(0);
  });
});
