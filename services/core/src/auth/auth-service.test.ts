/**
 * Unit tests for the Auth_Service (Req 33.2-33.9, 33.12, 33.13).
 *
 * These exercise the full authentication and session lifecycle through
 * {@link AuthService}, all behind the injectable BetterAuth {@link AuthProvider}
 * seam and deterministic fakes:
 *   - login success/failure for password, OAuth/OIDC, and SAML (Req 33.2-33.4),
 *     with a failed attempt denied and recorded in the Audit_Service (Req 33.12);
 *   - the MFA gate: a required second factor blocks sign-in until supplied and a
 *     wrong code is denied (Req 33.5-33.7);
 *   - token issuance on success (Req 33.8) and refresh from a valid refresh
 *     token (Req 33.9);
 *   - session validation accepts a live session and rejects an expired or
 *     revoked one (Req 33.8, 33.13);
 *   - sign-out revokes the session so its tokens are rejected thereafter
 *     (Req 33.13);
 *   - SSO / identity-provider association (Req 33.3, 33.4);
 *   - MFA enrollment + activation (Req 33.5);
 *   - the secret-handling discipline: only token HASHES are persisted, raw
 *     tokens are returned once, and no secret is recorded in audit metadata.
 *
 * The lifecycle tests use the fast injective {@link FakeTokenHasher}; the
 * "stored value is not the raw token" assertion uses the real
 * {@link sha256TokenHasher} so it is meaningful.
 */

import { describe, expect, it } from 'vitest';

import { sha256TokenHasher } from './auth-crypto.js';
import { AuthService } from './auth-service.js';
import {
  AuthenticationFailedError,
  InvalidSessionError,
  MfaFactorNotFoundError,
  MfaRequiredError,
} from './errors.js';
import {
  CapturingAuditRecorder,
  FakeAuthProvider,
  FakeTokenHasher,
  InMemoryIdentityLinkStore,
  InMemoryMfaEnrollmentStore,
  InMemorySessionStore,
  MutableAuthClock,
  SequentialTokenGenerator,
  makeIdentity,
  makeTenant,
  type FakeAuthProviderOptions,
} from './fakes.js';
import type { AuthServiceOptions } from './auth-service.js';

interface Harness {
  service: AuthService;
  sessions: InMemorySessionStore;
  identityLinks: InMemoryIdentityLinkStore;
  mfaFactors: InMemoryMfaEnrollmentStore;
  audit: CapturingAuditRecorder;
  clock: MutableAuthClock;
  provider: FakeAuthProvider;
}

/** Construct an AuthService wired with deterministic fakes. */
function makeService(
  providerOptions: FakeAuthProviderOptions = {},
  overrides: Partial<AuthServiceOptions> = {},
): Harness {
  const sessions = new InMemorySessionStore();
  const identityLinks = new InMemoryIdentityLinkStore();
  const mfaFactors = new InMemoryMfaEnrollmentStore();
  const audit = new CapturingAuditRecorder();
  const clock = new MutableAuthClock();
  const provider = new FakeAuthProvider(providerOptions);
  const service = new AuthService({
    provider,
    sessions,
    identityLinks,
    mfaFactors,
    audit,
    tokenGenerator: new SequentialTokenGenerator(),
    tokenHasher: new FakeTokenHasher(),
    idGenerator: sequentialIds(),
    clock,
    ...overrides,
  });
  return { service, sessions, identityLinks, mfaFactors, audit, clock, provider };
}

function sequentialIds(): AuthServiceOptions['idGenerator'] {
  let s = 0;
  let l = 0;
  let f = 0;
  return {
    sessionId: () => `sess-${(s += 1)}`,
    linkId: () => `idl-${(l += 1)}`,
    factorId: () => `mfa-${(f += 1)}`,
  };
}

// ---------------------------------------------------------------------------
// Password login — success/failure (Req 33.2, 33.8, 33.12)
// ---------------------------------------------------------------------------

describe('AuthService.signInPassword (Req 33.2, 33.8)', () => {
  it('establishes a session and issues access + refresh tokens on valid credentials', async () => {
    const identity = makeIdentity({ userId: 'u-1', organizationId: 'org-1' });
    const { service } = makeService({
      passwords: [{ email: 'user@example.com', password: 'correct horse', identity }],
    });

    const result = await service.signInPassword({
      email: 'user@example.com',
      password: 'correct horse',
    });

    expect(result.session.userId).toBe('u-1');
    expect(result.session.method).toBe('password');
    expect(result.session.revokedAt).toBeUndefined();
    expect(result.tokens.access).not.toBe('');
    expect(result.tokens.refresh).not.toBe('');
    expect(result.tokens.access).not.toBe(result.tokens.refresh);
    // Short-lived access token expires before the refresh token (Req 33.8).
    expect(new Date(result.tokens.accessExpiresAt).getTime()).toBeLessThan(
      new Date(result.tokens.refreshExpiresAt!).getTime(),
    );
  });

  it('denies and audits a failed authentication, never revealing the reason (Req 33.12)', async () => {
    const identity = makeIdentity();
    const { service, audit, sessions } = makeService({
      passwords: [{ email: 'user@example.com', password: 'correct horse', identity }],
    });

    await expect(
      service.signInPassword({ email: 'user@example.com', password: 'wrong' }),
    ).rejects.toBeInstanceOf(AuthenticationFailedError);

    // No session was created, and the failure was recorded (Req 33.12).
    expect(await sessions.listByUser('user-1')).toHaveLength(0);
    expect(audit.withAction('auth.failed')).toHaveLength(1);
    expect(audit.withAction('auth.sign_in')).toHaveLength(0);
  });

  it('records the masked session and audits the successful sign-in (Req 37.1)', async () => {
    const identity = makeIdentity({ userId: 'u-1' });
    const { service, audit } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
    });

    await service.signInPassword({
      email: 'user@example.com',
      password: 'pw',
      device: { ip: '203.0.113.7', userAgent: 'vitest', deviceName: 'CI box' },
    });

    const signIn = audit.withAction('auth.sign_in');
    expect(signIn).toHaveLength(1);
    expect(signIn[0]!.event.ip).toBe('203.0.113.7');
    expect(signIn[0]!.event.metadata?.method).toBe('password');
  });
});

// ---------------------------------------------------------------------------
// Secret handling — only hashes persisted (Req 33.8, 35.4)
// ---------------------------------------------------------------------------

describe('AuthService secret handling (Req 33.8, 35.4)', () => {
  it('stores only token hashes, never the raw access/refresh tokens', async () => {
    const identity = makeIdentity({ userId: 'u-1' });
    // Use the REAL hasher so "stored value is not the raw token" is meaningful.
    const { service, sessions } = makeService(
      { passwords: [{ email: 'user@example.com', password: 'pw', identity }] },
      { tokenHasher: sha256TokenHasher },
    );

    const result = await service.signInPassword({ email: 'user@example.com', password: 'pw' });
    const stored = sessions.peek(result.session.id);

    expect(stored).toBeDefined();
    expect(stored!.accessTokenHash).toBe(sha256TokenHasher.hash(result.tokens.access));
    expect(stored!.refreshTokenHash).toBe(sha256TokenHasher.hash(result.tokens.refresh!));
    // The raw tokens are NOT present anywhere on the stored record.
    expect(stored!.accessTokenHash).not.toBe(result.tokens.access);
    expect(stored!.refreshTokenHash).not.toBe(result.tokens.refresh);
    expect(JSON.stringify(stored)).not.toContain(result.tokens.access);
    expect(JSON.stringify(stored)).not.toContain(result.tokens.refresh);
  });

  it('never records a token or password in audit metadata', async () => {
    const identity = makeIdentity({ userId: 'u-1' });
    const { service, audit } = makeService({
      passwords: [{ email: 'user@example.com', password: 'secretpw', identity }],
    });

    const result = await service.signInPassword({ email: 'user@example.com', password: 'secretpw' });
    const serialized = JSON.stringify(audit.recorded);
    expect(serialized).not.toContain('secretpw');
    expect(serialized).not.toContain(result.tokens.access);
    expect(serialized).not.toContain(result.tokens.refresh);
  });
});

// ---------------------------------------------------------------------------
// OAuth/OIDC and SAML login (Req 33.3, 33.4)
// ---------------------------------------------------------------------------

describe('AuthService.signInOAuth / signInSSO (Req 33.3, 33.4)', () => {
  it('signs in through OAuth and associates the external identity (Req 33.3)', async () => {
    const identity = makeIdentity({
      userId: 'u-7',
      provider: 'google',
      providerAccountId: 'google|123',
    });
    const { service, identityLinks } = makeService({
      oauth: [{ provider: 'google', code: 'auth-code', identity }],
    });

    const result = await service.signInOAuth({ provider: 'google', code: 'auth-code' });
    expect(result.session.method).toBe('oauth');

    const link = await identityLinks.findByProviderAccount('google', 'google|123');
    expect(link).not.toBeNull();
    expect(link!.userId).toBe('u-7');
  });

  it('signs in through SAML 2.0 enterprise SSO (Req 33.4)', async () => {
    const identity = makeIdentity({
      userId: 'u-8',
      provider: 'okta',
      providerAccountId: 'okta|abc',
    });
    const { service } = makeService({ saml: [{ samlResponse: '<saml>ok</saml>', identity }] });

    const result = await service.signInSSO({ samlResponse: '<saml>ok</saml>' });
    expect(result.session.method).toBe('saml');
    expect(result.session.userId).toBe('u-8');
  });

  it('denies and audits an invalid OAuth code (Req 33.12)', async () => {
    const { service, audit } = makeService({ oauth: [] });
    await expect(
      service.signInOAuth({ provider: 'google', code: 'bad' }),
    ).rejects.toBeInstanceOf(AuthenticationFailedError);
    expect(audit.withAction('auth.failed')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MFA gate (Req 33.5, 33.6, 33.7)
// ---------------------------------------------------------------------------

describe('AuthService MFA gate (Req 33.5-33.7)', () => {
  it('blocks sign-in with MfaRequiredError when a required factor is missing', async () => {
    const identity = makeIdentity({ userId: 'u-1', mfaEnabled: true });
    const { service, audit } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
    });

    await expect(
      service.signInPassword({ email: 'user@example.com', password: 'pw' }),
    ).rejects.toBeInstanceOf(MfaRequiredError);

    // A missing-but-required factor is not a failed credential attempt.
    expect(audit.withAction('auth.failed')).toHaveLength(0);
    expect(audit.withAction('auth.sign_in')).toHaveLength(0);
  });

  it('completes sign-in when the required second factor is valid', async () => {
    const identity = makeIdentity({ userId: 'u-1', mfaEnabled: true });
    const { service } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
      validMfaCodes: [{ userId: 'u-1', code: '123456' }],
    });

    const result = await service.signInPassword({
      email: 'user@example.com',
      password: 'pw',
      mfaCode: '123456',
    });
    expect(result.session.mfaSatisfied).toBe(true);
  });

  it('denies and audits an invalid second factor (Req 33.12)', async () => {
    const identity = makeIdentity({ userId: 'u-1', mfaEnabled: true });
    const { service, audit } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
      validMfaCodes: [{ userId: 'u-1', code: '123456' }],
    });

    await expect(
      service.signInPassword({ email: 'user@example.com', password: 'pw', mfaCode: '000000' }),
    ).rejects.toBeInstanceOf(AuthenticationFailedError);
    expect(audit.withAction('auth.failed')).toHaveLength(1);
  });

  it('requires MFA for a privileged role even without per-user MFA (Req 33.6)', async () => {
    const { service } = makeService();
    const requirement = service.requireMfa({
      roles: ['admin'],
      mfaEnabled: false,
      orgMfaRequired: false,
    });
    expect(requirement.required).toBe(true);
    expect(requirement.reasons).toContain('privileged_role');
  });

  it('requires MFA when the Organization mandates it (Req 33.7)', async () => {
    const { service } = makeService();
    const requirement = service.requireMfa({
      roles: ['standard_user'],
      mfaEnabled: false,
      orgMfaRequired: true,
    });
    expect(requirement.required).toBe(true);
    expect(requirement.reasons).toEqual(['org_policy']);
  });

  it('does not require MFA when no condition holds', async () => {
    const { service } = makeService();
    const requirement = service.requireMfa({
      roles: ['standard_user'],
      mfaEnabled: false,
      orgMfaRequired: false,
    });
    expect(requirement.required).toBe(false);
    expect(requirement.reasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Session validation (Req 33.8, 33.13)
// ---------------------------------------------------------------------------

describe('AuthService.validate (Req 33.8, 33.13)', () => {
  it('accepts a live session and returns the identity, advancing last-active', async () => {
    const identity = makeIdentity({ userId: 'u-1', roles: ['power_user'] });
    const { service, sessions, clock } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
    });

    const { session, tokens } = await service.signInPassword({
      email: 'user@example.com',
      password: 'pw',
    });
    const before = sessions.peek(session.id)!.lastActiveAt;

    // Advance the clock (still within the access TTL) so a later validation
    // moves last-active forward (Req 33.10).
    clock.advanceSeconds(60);
    const result = await service.validate(tokens.access);
    expect(result.userId).toBe('u-1');
    expect(result.roles).toEqual(['power_user']);
    expect(result.sessionId).toBe(session.id);

    const after = sessions.peek(session.id)!.lastActiveAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('rejects an unknown access token', async () => {
    const { service } = makeService();
    await expect(service.validate('not-a-real-token')).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it('rejects an expired access token (Req 33.8)', async () => {
    const identity = makeIdentity({ userId: 'u-1' });
    const { service, clock } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
    });

    const { tokens } = await service.signInPassword({ email: 'user@example.com', password: 'pw' });
    // Advance past the 15-minute access TTL.
    clock.advanceSeconds(16 * 60);

    await expect(service.validate(tokens.access)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('rejects a token after the session is revoked (Req 33.13)', async () => {
    const identity = makeIdentity({ userId: 'u-1' });
    const { service } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
    });

    const { session, tokens } = await service.signInPassword({
      email: 'user@example.com',
      password: 'pw',
    });
    await service.validate(tokens.access); // valid before sign-out
    await service.signOut(session.id);

    await expect(service.validate(tokens.access)).rejects.toMatchObject({ reason: 'revoked' });
  });
});

// ---------------------------------------------------------------------------
// Refresh (Req 33.9)
// ---------------------------------------------------------------------------

describe('AuthService.refresh (Req 33.9)', () => {
  it('reissues an access token from a valid refresh token', async () => {
    const identity = makeIdentity({ userId: 'u-1' });
    const { service, clock } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
    });

    const { tokens } = await service.signInPassword({ email: 'user@example.com', password: 'pw' });
    clock.advanceSeconds(60);
    const refreshed = await service.refresh(tokens.refresh!);

    expect(refreshed.access).not.toBe('');
    expect(refreshed.access).not.toBe(tokens.access);
    expect(refreshed.refresh).toBeUndefined();

    // The new access token validates; the old one no longer does.
    const id = await service.validate(refreshed.access);
    expect(id.userId).toBe('u-1');
    await expect(service.validate(tokens.access)).rejects.toBeInstanceOf(InvalidSessionError);
  });

  it('rejects refresh with a revoked session (Req 33.13)', async () => {
    const identity = makeIdentity({ userId: 'u-1' });
    const { service } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
    });

    const { session, tokens } = await service.signInPassword({
      email: 'user@example.com',
      password: 'pw',
    });
    await service.signOut(session.id);

    await expect(service.refresh(tokens.refresh!)).rejects.toMatchObject({ reason: 'revoked' });
  });

  it('rejects an unknown refresh token', async () => {
    const { service } = makeService();
    await expect(service.refresh('nope')).rejects.toBeInstanceOf(InvalidSessionError);
  });
});

// ---------------------------------------------------------------------------
// Sign-out (Req 33.13)
// ---------------------------------------------------------------------------

describe('AuthService.signOut (Req 33.13)', () => {
  it('revokes the session so its tokens are rejected, and audits the sign-out', async () => {
    const identity = makeIdentity({ userId: 'u-1' });
    const { service, sessions, audit } = makeService({
      passwords: [{ email: 'user@example.com', password: 'pw', identity }],
    });

    const { session, tokens } = await service.signInPassword({
      email: 'user@example.com',
      password: 'pw',
    });
    await service.signOut(session.id);

    const stored = sessions.peek(session.id)!;
    expect(stored.revokedAt).toBeDefined();
    // The revoked session rejects its tokens thereafter (Req 33.13).
    await expect(service.validate(tokens.access)).rejects.toMatchObject({ reason: 'revoked' });
    expect(audit.withAction('auth.sign_out')).toHaveLength(1);
  });

  it('is idempotent for an unknown or already-revoked session', async () => {
    const { service, audit } = makeService();
    await service.signOut('does-not-exist');
    expect(audit.withAction('auth.sign_out')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Identity-provider association (Req 33.3, 33.4)
// ---------------------------------------------------------------------------

describe('AuthService.associateIdentity (Req 33.3, 33.4)', () => {
  it('associates an external identity and is idempotent', async () => {
    const { service, audit } = makeService();
    const ctx = makeTenant({ organizationId: 'org-1', userId: 'admin-1' });

    const first = await service.associateIdentity(ctx, {
      userId: 'u-1',
      provider: 'azure-ad',
      providerAccountId: 'aad|999',
    });
    const again = await service.associateIdentity(ctx, {
      userId: 'u-1',
      provider: 'azure-ad',
      providerAccountId: 'aad|999',
    });

    expect(first.id).toBe(again.id);
    expect(audit.withAction('auth.identity_link')).toHaveLength(1);

    const links = await service.listIdentities(ctx, 'u-1');
    expect(links).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// MFA enrollment (Req 33.5)
// ---------------------------------------------------------------------------

describe('AuthService MFA enrollment (Req 33.5)', () => {
  it('enrolls a pending TOTP factor with non-secret provisioning material', async () => {
    const { service, audit } = makeService();
    const ctx = makeTenant({ userId: 'u-1' });

    const { record, enrollment } = await service.beginMfaEnrollment(ctx, 'u-1', 'totp');
    expect(record.status).toBe('pending');
    expect(record.factor).toBe('totp');
    expect(enrollment.provisioningUri).toContain('otpauth://');
    // The record carries no secret.
    expect(JSON.stringify(record)).not.toContain('TESTONLY');
    expect(audit.withAction('auth.mfa_enroll')).toHaveLength(1);
  });

  it('activates the factor on a valid first code (Req 33.5)', async () => {
    const { service } = makeService({ validMfaCodes: [{ userId: 'u-1', code: '424242' }] });
    const ctx = makeTenant({ userId: 'u-1' });

    const { record } = await service.beginMfaEnrollment(ctx, 'u-1', 'totp');
    const activated = await service.verifyMfaEnrollment(ctx, record.id, '424242');

    expect(activated.status).toBe('active');
    expect(activated.activatedAt).toBeDefined();
  });

  it('denies activation on an invalid code and records the failed attempt (Req 33.12)', async () => {
    const { service, audit } = makeService({ validMfaCodes: [] });
    const ctx = makeTenant({ userId: 'u-1' });

    const { record } = await service.beginMfaEnrollment(ctx, 'u-1', 'totp');
    await expect(service.verifyMfaEnrollment(ctx, record.id, 'wrong')).rejects.toBeInstanceOf(
      AuthenticationFailedError,
    );
    expect(audit.withAction('auth.failed')).toHaveLength(1);
  });

  it('rejects activating a factor from another Organization', async () => {
    const { service } = makeService({ validMfaCodes: [{ userId: 'u-1', code: '424242' }] });
    const ctxA = makeTenant({ organizationId: 'org-1', userId: 'u-1' });
    const ctxB = makeTenant({ organizationId: 'org-2', userId: 'u-1' });

    const { record } = await service.beginMfaEnrollment(ctxA, 'u-1', 'totp');
    await expect(service.verifyMfaEnrollment(ctxB, record.id, '424242')).rejects.toBeInstanceOf(
      MfaFactorNotFoundError,
    );
  });
});
