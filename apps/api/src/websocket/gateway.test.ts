/**
 * Unit tests for the WebSocket_Gateway (Req 45.4, 45.5).
 *
 * Covers: JWT-before-session authentication and default-deny (Req 45.4), the
 * delivery of all eight server event types with the correct discriminant and
 * payload (Req 45.5), conversation/run/user scoping, the typed chat.error
 * carrying a PlatformError, and disconnect stopping further delivery.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';
import { describe, expect, it } from 'vitest';

import { WS_AUTH_FAILED_CLOSE_CODE, WS_EVENT_TYPES } from './types';
import { WebSocketGateway, WsSessionError } from './gateway';
import { FakeAuthenticator, FakeWsConnection, fakeIdentity } from './fakes';

const VALID_TOKEN = 'valid-jwt';

function makeGateway(): { gateway: WebSocketGateway; auth: FakeAuthenticator } {
  const auth = new FakeAuthenticator({
    [VALID_TOKEN]: fakeIdentity({ userId: 'user-1', organizationId: 'org-1' }),
  });
  return { gateway: new WebSocketGateway(auth), auth };
}

describe('WebSocketGateway — authenticate before session (Req 45.4)', () => {
  it('rejects a connection with NO token: closes with 4401, no session, no delivery', async () => {
    const { gateway } = makeGateway();
    const conn = new FakeWsConnection('c1');

    await expect(gateway.connect(conn, {})).rejects.toBeInstanceOf(WsSessionError);

    expect(conn.isClosed).toBe(true);
    expect(conn.closes[0]?.code).toBe(WS_AUTH_FAILED_CLOSE_CODE);
    expect(gateway.sessionCount).toBe(0);

    // default-deny: no targeting can reach an unauthenticated connection
    const delivered = await gateway.deliver('c1', {
      type: 'notification',
      notification: { id: 'n1', kind: 'system', title: 'hi', createdAt: '2026-01-01T00:00:00Z' },
    });
    expect(delivered).toBe(false);
    expect(conn.sent).toHaveLength(0);
  });

  it('rejects an INVALID token: validates the token, closes with 4401, no session', async () => {
    const { gateway, auth } = makeGateway();
    const conn = new FakeWsConnection('c1');

    await expect(gateway.connect(conn, { token: 'bogus' })).rejects.toMatchObject({
      reason: 'invalid_token',
    });

    // the JWT was checked BEFORE any session was established (Req 45.4)
    expect(auth.seen).toEqual(['bogus']);
    expect(conn.closes[0]?.code).toBe(WS_AUTH_FAILED_CLOSE_CODE);
    expect(gateway.sessionCount).toBe(0);
  });

  it('establishes a session for a valid JWT and returns the resolved identity', async () => {
    const { gateway, auth } = makeGateway();
    const conn = new FakeWsConnection('c1');

    const session = await gateway.connect(conn, { token: VALID_TOKEN });

    expect(auth.seen).toEqual([VALID_TOKEN]);
    expect(session.connectionId).toBe('c1');
    expect(session.identity.userId).toBe('user-1');
    expect(session.tenant).toEqual({ organizationId: 'org-1', userId: 'user-1' });
    expect(gateway.sessionCount).toBe(1);
    expect(conn.isClosed).toBe(false);
  });

  it('never logs or echoes the token value on the session or error', async () => {
    const { gateway } = makeGateway();
    const conn = new FakeWsConnection('c1');
    const session = await gateway.connect(conn, { token: VALID_TOKEN });
    // the established session carries identity, not the raw token
    expect(JSON.stringify(session)).not.toContain(VALID_TOKEN);
  });
});

describe('WebSocketGateway — event delivery (Req 45.5)', () => {
  it('delivers all eight event types to the authenticated subscriber', async () => {
    const { gateway } = makeGateway();
    const conn = new FakeWsConnection('c1');
    await gateway.connect(conn, {
      token: VALID_TOKEN,
      conversationIds: ['conv-A'],
      runIds: ['run-A'],
    });

    await gateway.emitChatToken('conv-A', 'Hel', 0);
    await gateway.emitChatCompletion('conv-A', {
      model: 'gpt-x',
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: 0.02,
      finishReason: 'stop',
    });
    await gateway.emitChatError(
      'conv-A',
      createPlatformError({
        category: 'provider_unavailable',
        code: 'PROVIDER_DOWN',
        message: 'provider is unavailable',
        correlationId: 'corr-1',
      }),
    );
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
    // every Req 45.5 event type was delivered, exactly once, in order
    expect(types).toEqual([...WS_EVENT_TYPES]);
    expect(new Set(types)).toEqual(new Set(WS_EVENT_TYPES));
  });

  it('chat.token carries the delta + conversationId + index', async () => {
    const { gateway } = makeGateway();
    const conn = new FakeWsConnection('c1');
    await gateway.connect(conn, { token: VALID_TOKEN, conversationIds: ['conv-A'] });

    await gateway.emitChatToken('conv-A', 'Hello', 3);

    const event = conn.sent[0];
    expect(event).toEqual({ type: 'chat.token', conversationId: 'conv-A', delta: 'Hello', index: 3 });
  });

  it('chat.completion carries model, usage, and cost', async () => {
    const { gateway } = makeGateway();
    const conn = new FakeWsConnection('c1');
    await gateway.connect(conn, { token: VALID_TOKEN, conversationIds: ['conv-A'] });

    await gateway.emitChatCompletion('conv-A', {
      model: 'claude-x',
      usage: { inputTokens: 100, outputTokens: 50 },
      cost: 0.5,
    });

    expect(conn.sent[0]).toEqual({
      type: 'chat.completion',
      conversationId: 'conv-A',
      model: 'claude-x',
      usage: { inputTokens: 100, outputTokens: 50 },
      cost: 0.5,
    });
  });

  it('chat.error carries a PlatformError', async () => {
    const { gateway } = makeGateway();
    const conn = new FakeWsConnection('c1');
    await gateway.connect(conn, { token: VALID_TOKEN, conversationIds: ['conv-A'] });

    const platformError: PlatformError = createPlatformError({
      category: 'rate_limited',
      code: 'RATE_LIMITED',
      message: 'slow down',
      correlationId: 'corr-9',
      retryAfterSeconds: 30,
    });
    await gateway.emitChatError('conv-A', platformError);

    const event = conn.sent[0];
    expect(event?.type).toBe('chat.error');
    if (event?.type === 'chat.error') {
      expect(event.error).toEqual(platformError);
      expect(event.error.category).toBe('rate_limited');
      expect(event.error.retriable).toBe(true);
    }
  });

  it('emitChatError mints a typed PlatformError from a bare message', async () => {
    const { gateway } = makeGateway();
    const conn = new FakeWsConnection('c1');
    await gateway.connect(conn, { token: VALID_TOKEN, conversationIds: ['conv-A'] });

    await gateway.emitChatError('conv-A', 'something failed');

    const event = conn.sent[0];
    if (event?.type === 'chat.error') {
      expect(event.error.category).toBe('internal');
      expect(event.error.message).toBe('something failed');
      expect(typeof event.error.correlationId).toBe('string');
    } else {
      throw new Error('expected a chat.error event');
    }
  });
});

describe('WebSocketGateway — scoping/targeting (Req 45.5)', () => {
  it('a chat.token for conversation A reaches A subscriber, not an unrelated session', async () => {
    const auth = new FakeAuthenticator({
      tokenA: fakeIdentity({ userId: 'user-A' }),
      tokenB: fakeIdentity({ userId: 'user-B' }),
    });
    const gateway = new WebSocketGateway(auth);

    const connA = new FakeWsConnection('cA');
    const connB = new FakeWsConnection('cB');
    await gateway.connect(connA, { token: 'tokenA', conversationIds: ['conv-A'] });
    await gateway.connect(connB, { token: 'tokenB', conversationIds: ['conv-B'] });

    const count = await gateway.emitChatToken('conv-A', 'hi', 0);

    expect(count).toBe(1);
    expect(connA.sent).toHaveLength(1);
    expect(connB.sent).toHaveLength(0);
  });

  it('an agent.step for run A reaches only run-A subscribers', async () => {
    const auth = new FakeAuthenticator({
      tokenA: fakeIdentity({ userId: 'user-A' }),
      tokenB: fakeIdentity({ userId: 'user-B' }),
    });
    const gateway = new WebSocketGateway(auth);

    const connA = new FakeWsConnection('cA');
    const connB = new FakeWsConnection('cB');
    await gateway.connect(connA, { token: 'tokenA', runIds: ['run-A'] });
    await gateway.connect(connB, { token: 'tokenB', runIds: ['run-Z'] });

    await gateway.emitAgentStep('run-A', {
      stepNumber: 1,
      tool: 't',
      outcome: 'ok',
      durationMs: 1,
    });

    expect(connA.sent).toHaveLength(1);
    expect(connB.sent).toHaveLength(0);
  });

  it('a user-targeted notification reaches every session of that user only', async () => {
    const auth = new FakeAuthenticator({
      t1: fakeIdentity({ userId: 'user-1', sessionId: 's1' }),
      t2: fakeIdentity({ userId: 'user-1', sessionId: 's2' }),
      t3: fakeIdentity({ userId: 'user-2', sessionId: 's3' }),
    });
    const gateway = new WebSocketGateway(auth);

    const c1 = new FakeWsConnection('c1');
    const c2 = new FakeWsConnection('c2');
    const c3 = new FakeWsConnection('c3');
    await gateway.connect(c1, { token: 't1' });
    await gateway.connect(c2, { token: 't2' });
    await gateway.connect(c3, { token: 't3' });

    const count = await gateway.emitNotification('user-1', {
      id: 'n1',
      kind: 'system',
      title: 'hi',
      createdAt: '2026-01-01T00:00:00Z',
    });

    expect(count).toBe(2);
    expect(c1.sent).toHaveLength(1);
    expect(c2.sent).toHaveLength(1);
    expect(c3.sent).toHaveLength(0);
  });

  it('supports subscribing to a conversation after connect', async () => {
    const { gateway } = makeGateway();
    const conn = new FakeWsConnection('c1');
    await gateway.connect(conn, { token: VALID_TOKEN });

    // not subscribed yet -> no delivery
    expect(await gateway.emitChatToken('conv-late', 'x', 0)).toBe(0);

    gateway.subscribeConversation('c1', 'conv-late');
    expect(await gateway.emitChatToken('conv-late', 'y', 1)).toBe(1);
    expect(conn.sent).toHaveLength(1);
  });
});

describe('WebSocketGateway — disconnect (Req 45.4 lifecycle)', () => {
  it('stops further delivery after disconnect', async () => {
    const { gateway } = makeGateway();
    const conn = new FakeWsConnection('c1');
    await gateway.connect(conn, { token: VALID_TOKEN, conversationIds: ['conv-A'] });

    expect(await gateway.emitChatToken('conv-A', 'a', 0)).toBe(1);

    const removed = gateway.disconnect('c1');
    expect(removed).toBe(true);
    expect(gateway.sessionCount).toBe(0);

    // no further delivery
    expect(await gateway.emitChatToken('conv-A', 'b', 1)).toBe(0);
    expect(await gateway.deliver('c1', { type: 'chat.token', conversationId: 'conv-A', delta: 'c', index: 2 })).toBe(false);
    expect(conn.sent).toHaveLength(1);
  });

  it('disconnect of an unknown connection returns false', () => {
    const { gateway } = makeGateway();
    expect(gateway.disconnect('nope')).toBe(false);
  });
});
