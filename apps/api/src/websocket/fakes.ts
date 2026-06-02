/**
 * In-memory test fakes for the WebSocket_Gateway (Req 45.4, 45.5).
 *
 * These let the gateway be unit-tested with no real socket, auth service, or
 * network: {@link FakeWsConnection} captures every event sent and every close
 * call, and {@link FakeAuthenticator} resolves a configured set of valid tokens
 * to identities and throws (like the real `AuthService.validate`) for anything
 * else.
 *
 * This module is intentionally NOT re-exported from the app barrel
 * (`apps/api/src/index.ts`); tests import it directly from `./fakes`.
 */

import { InvalidSessionError } from '@auxify/core';
import type { SessionIdentity } from '@auxify/core';

import type { Authenticator, WsConnection, WsServerEvent } from './types';

/** A recorded close call captured by a {@link FakeWsConnection}. */
export interface RecordedClose {
  /** The WebSocket close code passed to `close`. */
  code: number;
  /** The optional reason passed to `close`. */
  reason?: string;
}

/**
 * A {@link WsConnection} fake that records the events it is sent and the close
 * calls it receives, so a test can assert exactly what reached the client.
 */
export class FakeWsConnection implements WsConnection {
  /** Every event delivered to this connection, in order. */
  readonly sent: WsServerEvent[] = [];
  /** Every close call this connection received, in order. */
  readonly closes: RecordedClose[] = [];

  constructor(readonly id: string) {}

  send(event: WsServerEvent): void {
    this.sent.push(event);
  }

  close(code: number, reason?: string): void {
    this.closes.push(reason === undefined ? { code } : { code, reason });
  }

  /** Whether this connection has been closed at least once. */
  get isClosed(): boolean {
    return this.closes.length > 0;
  }
}

/**
 * An {@link Authenticator} fake mapping valid tokens to identities.
 *
 * A token present in the configured map resolves to its identity; any other
 * token (including a revoked one) throws an {@link InvalidSessionError}, exactly
 * as the real `AuthService.validate` does — so the gateway's catch-and-reject
 * path is exercised faithfully.
 */
export class FakeAuthenticator implements Authenticator {
  private readonly valid = new Map<string, SessionIdentity>();

  /** The tokens this fake was asked to validate, in order (for assertions). */
  readonly seen: string[] = [];

  constructor(entries?: Record<string, SessionIdentity>) {
    if (entries !== undefined) {
      for (const [token, identity] of Object.entries(entries)) {
        this.valid.set(token, identity);
      }
    }
  }

  /** Register a token → identity mapping treated as a valid session. */
  addToken(token: string, identity: SessionIdentity): this {
    this.valid.set(token, identity);
    return this;
  }

  /** Revoke a previously-valid token so subsequent validation throws. */
  revoke(token: string): this {
    this.valid.delete(token);
    return this;
  }

  async validate(accessToken: string): Promise<SessionIdentity> {
    this.seen.push(accessToken);
    const identity = this.valid.get(accessToken);
    if (identity === undefined) {
      throw new InvalidSessionError('unknown');
    }
    return identity;
  }
}

/**
 * Build a {@link SessionIdentity} for tests with sensible defaults.
 *
 * @param overrides Partial fields to override the defaults.
 * @returns A complete, secret-free session identity.
 */
export function fakeIdentity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    roles: ['standard_user'],
    sessionId: 'session-1',
    ...overrides,
  };
}
