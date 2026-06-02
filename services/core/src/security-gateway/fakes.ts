/**
 * Test fakes and builders for the Security_Gateway.
 *
 * The gateway composes several injected ports — an {@link AuditRecorder}, an
 * {@link Authenticator}, an {@link IpReputation}, a {@link RateLimiter}, a
 * {@link RequestValidator}, a {@link CsrfVerifier}, an optional
 * {@link Authorizer}, and a {@link SecurityGatewayClock}. These fakes let unit
 * and property tests drive {@link SecurityGateway.evaluate} deterministically
 * and inspect what was denied/audited, without a real network, TLS terminator,
 * rate-limit backend, or Auth_Service:
 *
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert exactly which denials were audited (Req 37.1 / Property 3).
 *   - {@link FakeAuthenticator} authenticates to a fixed principal (or a
 *     supplied function), so a test can model an authenticated or anonymous
 *     request; {@link ThrowingAuthenticator} models a guard that errors, for the
 *     fail-closed path.
 *   - {@link FakeAuthorizer} returns a configurable allow/deny.
 *   - {@link ManualClock} returns a hand-controlled instant so rate-limit
 *     windows advance deterministically.
 *   - {@link makePrincipal} and {@link makeRequest} are small builders with
 *     sensible (admit-by-default) defaults that each test overrides field-by-field.
 *
 * These are imported directly from `./fakes.js` by the tests (never from the
 * package barrel), matching the established convention so the equally-named
 * audit-recorder fakes of sibling modules never collide at the package barrel.
 */

import type { Principal, TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type {
  AuthOutcome,
  Authenticator,
  Authorizer,
  AuthzOutcome,
  GatewayRequest,
  HttpMethod,
  SecurityGatewayClock,
} from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} that stores every recorded event so tests
 * can assert which denials were audited (Req 37.1).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({
      ctx: { ...ctx },
      event: { ...event, metadata: { ...(event.metadata ?? {}) } },
    });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `security.denied`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined`. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/**
 * An {@link Authenticator} that returns a configurable outcome.
 *
 * By default it authenticates to {@link makePrincipal}'s principal. Pass a fixed
 * {@link AuthOutcome}, or a function computing one from the request, to model an
 * authenticated, anonymous, or conditionally-authenticated request. Every call
 * is captured in {@link calls}.
 */
export class FakeAuthenticator implements Authenticator {
  /** Every authenticate invocation, in order. */
  readonly calls: GatewayRequest[] = [];

  constructor(
    private readonly outcome:
      | AuthOutcome
      | ((request: GatewayRequest) => AuthOutcome) = { authenticated: true, principal: makePrincipal() },
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async authenticate(request: GatewayRequest): Promise<AuthOutcome> {
    this.calls.push(request);
    return typeof this.outcome === 'function' ? this.outcome(request) : this.outcome;
  }
}

/** Convenience: an authenticator that always fails authentication. */
export function unauthenticatedAuthenticator(reason = 'no credentials'): FakeAuthenticator {
  return new FakeAuthenticator({ authenticated: false, reason });
}

/** An {@link Authenticator} that always throws, to exercise the fail-closed path. */
export class ThrowingAuthenticator implements Authenticator {
  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async authenticate(): Promise<AuthOutcome> {
    throw new Error('authenticator unavailable');
  }
}

/**
 * An {@link Authorizer} that returns a configurable outcome (defaults to allow).
 * Every call is captured in {@link calls}.
 */
export class FakeAuthorizer implements Authorizer {
  /** Every authorize invocation, in order. */
  readonly calls: Array<{ principal: Principal; request: GatewayRequest }> = [];

  constructor(
    private readonly outcome:
      | AuthzOutcome
      | ((principal: Principal, request: GatewayRequest) => AuthzOutcome) = { allowed: true },
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async authorize(principal: Principal, request: GatewayRequest): Promise<AuthzOutcome> {
    this.calls.push({ principal, request });
    return typeof this.outcome === 'function' ? this.outcome(principal, request) : this.outcome;
  }
}

/** Convenience: an authorizer that always denies. */
export function denyingAuthorizer(reason = 'not authorized'): FakeAuthorizer {
  return new FakeAuthorizer({ allowed: false, reason });
}

/**
 * A hand-controlled {@link SecurityGatewayClock} for deterministic rate-limit
 * windowing. {@link advance} moves the clock forward by a number of milliseconds.
 */
export class ManualClock implements SecurityGatewayClock {
  private current: number;

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** Advance the clock by `ms` milliseconds and return the new instant. */
  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }
}

/** Build a {@link Principal} with sensible defaults; override field-by-field. */
export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    roles: ['standard_user'],
    teamIds: ['team-1'],
    projectIds: ['project-1'],
    allowedModels: [],
    premiumAuthorized: false,
    ...overrides,
  };
}

/**
 * Build a {@link GatewayRequest} with admit-by-default defaults; override
 * field-by-field.
 *
 * The defaults pass every stage of the pipeline: TLS 1.3, a benign GET path, a
 * non-blocked IP, and no body — so a test can flip exactly one field to exercise
 * one stage's denial.
 */
export function makeRequest(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  const method: HttpMethod = overrides.method ?? 'GET';
  return {
    transport: { tlsVersion: '1.3' },
    method,
    path: '/v1/conversations',
    ip: '203.0.113.10',
    ...overrides,
  };
}
