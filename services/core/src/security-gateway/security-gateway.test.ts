/**
 * Unit tests for the Security_Gateway (Req 34.1, 34.2, 34.3, 34.4, 34.5, 34.6,
 * 34.8).
 *
 * These exercise the full fail-closed pipeline through {@link SecurityGateway}:
 *   - an allowed request passes every stage and carries the authenticated
 *     principal + sanitized body;
 *   - TLS below 1.3 is denied (`tls_required`, Req 34.1);
 *   - a blocked IP is denied (`ip_blocked`, Req 34, WAF);
 *   - a rate-limit-exceeded request is denied with a retry-after hint
 *     (`rate_limited`, Req 34.3);
 *   - an invalid/unsanitized request is denied (`invalid_request`) and a benign
 *     body is sanitized before processing (Req 34.4, 34.5);
 *   - a state-changing request without a valid CSRF token is denied
 *     (`csrf_failed`, Req 34.6);
 *   - an unauthenticated request is denied (`unauthenticated`, Req 34.2);
 *   - an unauthorized request is denied (`unauthorized`, Req 34.8);
 *   - a guard that throws fails closed (`fail_closed`);
 *   - every denial — and only denials — is audited exactly once (Req 37.1);
 *   - `evaluateOrThrow` throws a {@link RequestDeniedError} projecting to a
 *     category-correct PlatformError.
 */

import { describe, expect, it } from 'vitest';

import type { AuditRecorder } from '../audit/index.js';
import { RequestDeniedError } from './errors.js';
import { InMemoryRateLimiter } from './rate-limiter.js';
import { StaticIpReputation } from './ip-reputation.js';
import { SecurityGateway, type SecurityGatewayOptions } from './security-gateway.js';
import { sanitizeText, containsDisallowedConstructs, encodeForOutput } from './validation.js';
import {
  CapturingAuditRecorder,
  FakeAuthenticator,
  FakeAuthorizer,
  ManualClock,
  ThrowingAuthenticator,
  denyingAuthorizer,
  makePrincipal,
  makeRequest,
  unauthenticatedAuthenticator,
} from './fakes.js';

/** Build a gateway over capturing audit + admit-by-default guards, with overrides. */
function makeGateway(
  overrides: Partial<SecurityGatewayOptions> = {},
): { gateway: SecurityGateway; audit: CapturingAuditRecorder } {
  const audit = overrides.auditRecorder ?? new CapturingAuditRecorder();
  const gateway = new SecurityGateway({
    auditRecorder: audit,
    authenticator: new FakeAuthenticator(),
    ...overrides,
  });
  return { gateway, audit: audit as CapturingAuditRecorder };
}

// ---------------------------------------------------------------------------
// Happy path — an allowed request (Req 34.2, 34.4)
// ---------------------------------------------------------------------------

describe('SecurityGateway — an allowed request passes', () => {
  it('admits a well-formed authenticated request, carrying principal + sanitized body', async () => {
    const principal = makePrincipal({ userId: 'u-7', organizationId: 'org-7' });
    const { gateway, audit } = makeGateway({
      authenticator: new FakeAuthenticator({ authenticated: true, principal }),
    });

    const verdict = await gateway.evaluate(
      makeRequest({
        method: 'POST',
        path: '/v1/messages',
        csrfToken: 'tok-1',
        csrfCookie: 'tok-1',
        body: { text: 'hello <b>world</b>' },
      }),
    );

    expect(verdict.allowed).toBe(true);
    expect(verdict.denialCode).toBeUndefined();
    expect(verdict.principal).toEqual(principal);
    // Body is sanitized (a benign tag survives; only disallowed constructs are stripped).
    expect(verdict.sanitizedBody).toEqual({ text: 'hello <b>world</b>' });
    // Allowed requests audit nothing.
    expect(audit.count).toBe(0);
  });

  it('strips disallowed constructs from the body before processing (Req 34.4)', async () => {
    const { gateway } = makeGateway();
    const verdict = await gateway.evaluate(
      makeRequest({
        method: 'POST',
        path: '/v1/messages',
        csrfToken: 't',
        csrfCookie: 't',
        body: { note: 'hi<script>steal()</script>', nested: { onclick: 'x onerror=alert(1)' } },
      }),
    );
    expect(verdict.allowed).toBe(true);
    const body = verdict.sanitizedBody as { note: string; nested: { onclick: string } };
    expect(body.note).toBe('hi');
    expect(containsDisallowedConstructs(JSON.stringify(verdict.sanitizedBody))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stage 1 — TLS 1.3 (Req 34.1)
// ---------------------------------------------------------------------------

describe('SecurityGateway — TLS 1.3 enforcement (Req 34.1)', () => {
  it('denies a connection below TLS 1.3 and audits it', async () => {
    const { gateway, audit } = makeGateway();
    const verdict = await gateway.evaluate(
      makeRequest({ transport: { tlsVersion: '1.2' } }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('tls_required');
    expect(audit.count).toBe(1);
    expect(audit.last?.event.action).toBe('security.denied');
  });

  it('does not authenticate a sub-TLS-1.3 request (fail fast)', async () => {
    const auth = new FakeAuthenticator();
    const { gateway } = makeGateway({ authenticator: auth });
    await gateway.evaluate(makeRequest({ transport: { tlsVersion: '1.1' } }));
    expect(auth.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — IP / abuse gating (Req 34, WAF)
// ---------------------------------------------------------------------------

describe('SecurityGateway — IP / abuse gating (Req 34)', () => {
  it('denies a blocked IP and audits it', async () => {
    const { gateway, audit } = makeGateway({
      ipReputation: new StaticIpReputation(['203.0.113.10']),
    });
    const verdict = await gateway.evaluate(makeRequest({ ip: '203.0.113.10' }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('ip_blocked');
    expect(audit.count).toBe(1);
    expect(audit.last?.event.ip).toBe('203.0.113.10');
  });

  it('admits an IP that is not on the block list', async () => {
    const { gateway } = makeGateway({
      ipReputation: new StaticIpReputation(['198.51.100.1']),
    });
    const verdict = await gateway.evaluate(makeRequest({ ip: '203.0.113.10' }));
    expect(verdict.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 — rate limiting (Req 34.3)
// ---------------------------------------------------------------------------

describe('SecurityGateway — rate limiting (Req 34.3)', () => {
  it('denies a request once the per-IP limit is exceeded, with a retry-after hint', async () => {
    const clock = new ManualClock(0);
    const { gateway } = makeGateway({
      rateLimiter: new InMemoryRateLimiter(),
      rateLimitConfig: {
        user: { requestsPerWindow: 1000, windowSeconds: 60 },
        apiKey: { requestsPerWindow: 1000, windowSeconds: 60 },
        ip: { requestsPerWindow: 2, windowSeconds: 60 },
      },
      clock,
    });

    const req = makeRequest({ ip: '203.0.113.99' });
    expect((await gateway.evaluate(req)).allowed).toBe(true);
    expect((await gateway.evaluate(req)).allowed).toBe(true);
    const third = await gateway.evaluate(req);
    expect(third.allowed).toBe(false);
    expect(third.denialCode).toBe('rate_limited');
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('frees the window after it elapses (Req 34.3)', async () => {
    const clock = new ManualClock(0);
    const { gateway } = makeGateway({
      rateLimiter: new InMemoryRateLimiter(),
      rateLimitConfig: {
        user: { requestsPerWindow: 1000, windowSeconds: 60 },
        apiKey: { requestsPerWindow: 1000, windowSeconds: 60 },
        ip: { requestsPerWindow: 1, windowSeconds: 10 },
      },
      clock,
    });
    const req = makeRequest({ ip: '203.0.113.50' });
    expect((await gateway.evaluate(req)).allowed).toBe(true);
    expect((await gateway.evaluate(req)).allowed).toBe(false);
    clock.advance(10_001);
    expect((await gateway.evaluate(req)).allowed).toBe(true);
  });

  it('limits independently per user dimension', async () => {
    const clock = new ManualClock(0);
    const { gateway } = makeGateway({
      rateLimiter: new InMemoryRateLimiter(),
      rateLimitConfig: {
        user: { requestsPerWindow: 1, windowSeconds: 60 },
        apiKey: { requestsPerWindow: 1000, windowSeconds: 60 },
        ip: { requestsPerWindow: 1000, windowSeconds: 60 },
      },
      clock,
    });
    const a = makeRequest({ ip: '203.0.113.1', principal: makePrincipal({ userId: 'ua' }) });
    const b = makeRequest({ ip: '203.0.113.2', principal: makePrincipal({ userId: 'ub' }) });
    expect((await gateway.evaluate(a)).allowed).toBe(true);
    // ua is now at its limit, but ub is independent.
    expect((await gateway.evaluate(a)).allowed).toBe(false);
    expect((await gateway.evaluate(b)).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — input validation + sanitization (Req 34.4, 34.5)
// ---------------------------------------------------------------------------

describe('SecurityGateway — input validation (Req 34.4)', () => {
  it('denies a malformed (relative) path', async () => {
    const { gateway, audit } = makeGateway();
    const verdict = await gateway.evaluate(makeRequest({ path: 'no-leading-slash' }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('invalid_request');
    expect(audit.count).toBe(1);
  });

  it('denies a path containing control characters', async () => {
    const { gateway } = makeGateway();
    const verdict = await gateway.evaluate(makeRequest({ path: '/v1/\u0000evil' }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('invalid_request');
  });
});

describe('sanitization helpers (Req 34.4, 34.5)', () => {
  it('sanitizeText removes script blocks and event handlers', () => {
    expect(sanitizeText('a<script>x()</script>b')).toBe('ab');
    expect(containsDisallowedConstructs(sanitizeText('<img src=x onerror=alert(1)>'))).toBe(false);
    expect(sanitizeText('go javascript:alert(1)')).not.toContain('javascript:');
  });

  it('sanitizeText is idempotent', () => {
    const inputs = ['<script>1</script>', 'plain', '<a onclick="x">y</a>', 'javascript:void'];
    for (const input of inputs) {
      const once = sanitizeText(input);
      expect(sanitizeText(once)).toBe(once);
    }
  });

  it('encodeForOutput HTML-encodes for XSS-safe rendering (Req 34.5)', () => {
    expect(encodeForOutput('<b>"x"</b>')).toBe('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  });
});

// ---------------------------------------------------------------------------
// Stage 5 — CSRF (Req 34.6)
// ---------------------------------------------------------------------------

describe('SecurityGateway — CSRF on state-changing requests (Req 34.6)', () => {
  it('denies a POST without a CSRF token', async () => {
    const { gateway, audit } = makeGateway();
    const verdict = await gateway.evaluate(makeRequest({ method: 'POST', path: '/v1/x' }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('csrf_failed');
    expect(audit.count).toBe(1);
  });

  it('denies a POST whose submitted token does not match the session cookie', async () => {
    const { gateway } = makeGateway();
    const verdict = await gateway.evaluate(
      makeRequest({ method: 'POST', path: '/v1/x', csrfToken: 'a', csrfCookie: 'b' }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('csrf_failed');
  });

  it('admits a POST with matching double-submit tokens', async () => {
    const { gateway } = makeGateway();
    const verdict = await gateway.evaluate(
      makeRequest({ method: 'POST', path: '/v1/x', csrfToken: 'same', csrfCookie: 'same' }),
    );
    expect(verdict.allowed).toBe(true);
  });

  it('does not require a CSRF token on a safe GET', async () => {
    const { gateway } = makeGateway();
    const verdict = await gateway.evaluate(makeRequest({ method: 'GET', path: '/v1/x' }));
    expect(verdict.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 6 — authentication before routing (Req 34.2, 34.8)
// ---------------------------------------------------------------------------

describe('SecurityGateway — authentication before routing (Req 34.2)', () => {
  it('denies a request that cannot be authenticated', async () => {
    const { gateway, audit } = makeGateway({
      authenticator: unauthenticatedAuthenticator('missing token'),
    });
    const verdict = await gateway.evaluate(makeRequest());
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('unauthenticated');
    expect(audit.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stage 7 — authorization (Req 34.8)
// ---------------------------------------------------------------------------

describe('SecurityGateway — authorization (Req 34.8)', () => {
  it('denies an authenticated-but-unauthorized request', async () => {
    const { gateway, audit } = makeGateway({ authorizer: denyingAuthorizer('no grant') });
    const verdict = await gateway.evaluate(makeRequest());
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('unauthorized');
    expect(audit.count).toBe(1);
    // The denial is scoped to the authenticated principal's Organization.
    expect(audit.last?.ctx.organizationId).toBe('org-1');
  });

  it('admits when the authorizer allows, and passes the principal to it', async () => {
    const authorizer = new FakeAuthorizer({ allowed: true });
    const principal = makePrincipal({ userId: 'u-42' });
    const { gateway } = makeGateway({
      authenticator: new FakeAuthenticator({ authenticated: true, principal }),
      authorizer,
    });
    const verdict = await gateway.evaluate(makeRequest());
    expect(verdict.allowed).toBe(true);
    expect(authorizer.calls[0]?.principal.userId).toBe('u-42');
  });

  it('grants once authenticated when no authorizer is wired (deferred to Access_Control)', async () => {
    const { gateway } = makeGateway();
    const verdict = await gateway.evaluate(makeRequest());
    expect(verdict.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behavior — a guard that errors
// ---------------------------------------------------------------------------

describe('SecurityGateway — fail-closed when a guard errors', () => {
  it('denies (fail_closed) when the authenticator throws, never admitting', async () => {
    const { gateway, audit } = makeGateway({ authenticator: new ThrowingAuthenticator() });
    const verdict = await gateway.evaluate(makeRequest());
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('fail_closed');
    expect(audit.count).toBe(1);
  });

  it('denies (fail_closed) when the IP reputation port throws', async () => {
    const throwingIp = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async evaluate(): Promise<never> {
        throw new Error('reputation feed down');
      },
    };
    const { gateway } = makeGateway({ ipReputation: throwingIp });
    const verdict = await gateway.evaluate(makeRequest());
    expect(verdict.allowed).toBe(false);
    expect(verdict.denialCode).toBe('fail_closed');
  });
});

// ---------------------------------------------------------------------------
// Audit cardinality + evaluateOrThrow
// ---------------------------------------------------------------------------

describe('SecurityGateway — audits exactly one denial, none for allows', () => {
  it('records exactly one security.denied per denied evaluate', async () => {
    const audit = new CapturingAuditRecorder();
    const { gateway } = makeGateway({ auditRecorder: audit });

    await gateway.evaluate(makeRequest()); // allow
    await gateway.evaluate(makeRequest({ transport: { tlsVersion: '1.0' } })); // deny tls
    await gateway.evaluate(makeRequest({ method: 'POST', path: '/x' })); // deny csrf

    expect(audit.withAction('security.denied')).toHaveLength(2);
    expect(audit.count).toBe(2);
  });
});

describe('SecurityGateway.evaluateOrThrow', () => {
  it('returns the allow verdict when admitted', async () => {
    const { gateway } = makeGateway();
    const verdict = await gateway.evaluateOrThrow(makeRequest());
    expect(verdict.allowed).toBe(true);
  });

  it('throws RequestDeniedError carrying the verdict + code on a denial', async () => {
    const { gateway } = makeGateway({ authenticator: unauthenticatedAuthenticator() });
    await expect(gateway.evaluateOrThrow(makeRequest())).rejects.toBeInstanceOf(RequestDeniedError);
    try {
      await gateway.evaluateOrThrow(makeRequest());
    } catch (error) {
      const denied = error as RequestDeniedError;
      expect(denied.code).toBe('unauthenticated');
      const platformError = denied.toPlatformError('corr-1');
      expect(platformError.category).toBe('authentication');
      expect(platformError.correlationId).toBe('corr-1');
    }
  });

  it('projects a rate-limit denial to a rate_limited PlatformError with retry-after', async () => {
    const clock = new ManualClock(0);
    const { gateway } = makeGateway({
      rateLimiter: new InMemoryRateLimiter(),
      rateLimitConfig: {
        user: { requestsPerWindow: 1000, windowSeconds: 60 },
        apiKey: { requestsPerWindow: 1000, windowSeconds: 60 },
        ip: { requestsPerWindow: 1, windowSeconds: 30 },
      },
      clock,
    });
    const req = makeRequest({ ip: '203.0.113.7' });
    await gateway.evaluate(req);
    try {
      await gateway.evaluateOrThrow(req);
      expect.unreachable('should have thrown');
    } catch (error) {
      const denied = error as RequestDeniedError;
      expect(denied.code).toBe('rate_limited');
      const platformError = denied.toPlatformError('corr-2');
      expect(platformError.category).toBe('rate_limited');
      expect(platformError.retryAfterSeconds).toBeGreaterThan(0);
      expect(platformError.retriable).toBe(true);
    }
  });
});

// A small compile-time check that the AuditRecorder port is satisfied by the fake.
const _recorder: AuditRecorder = new CapturingAuditRecorder();
void _recorder;
