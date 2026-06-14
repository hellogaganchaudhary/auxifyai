/**
 * The Auth_Service — authenticates users, establishes and validates sessions,
 * issues and refreshes tokens, associates external identities, and enforces
 * multi-factor authentication (Req 33.2-33.9, 33.12, 33.13).
 *
 * It is the single place that:
 *   - signs a user in with email/password (Req 33.2), OAuth/OIDC (Req 33.3), or
 *     enterprise SSO via SAML 2.0 (Req 33.4), delegating ALL credential
 *     verification to the injected BetterAuth {@link AuthProvider} seam;
 *   - resolves the MFA requirement (per-user, privileged role, or org policy)
 *     and gates session establishment on a verified second factor (Req 33.5-33.7);
 *   - issues a short-lived access token plus a refresh token on success
 *     (Req 33.8) and reissues an access token from a valid refresh token
 *     (Req 33.9);
 *   - validates a presented access token, accepting only a live session and
 *     rejecting an expired or revoked one (Req 33.8);
 *   - revokes a session on sign-out so its tokens are rejected thereafter
 *     (Req 33.13);
 *   - associates a platform user with an OAuth/OIDC or SAML identity-provider
 *     account (Req 33.3, 33.4);
 *   - enrolls and verifies MFA factors (Req 33.5);
 *   - records every FAILED authentication in the Audit_Service (Req 33.12) and
 *     audits session establishment and sign-out (Req 37.1).
 *
 * All dependencies are injected so the service is pure orchestration and fully
 * unit-testable with the fakes in `./fakes.js`: the BetterAuth
 * {@link AuthProvider}, a {@link SessionStore}, an {@link IdentityLinkStore}, an
 * {@link MfaEnrollmentStore}, the shared {@link AuditRecorder}, a
 * {@link TokenGenerator} and {@link TokenHasher}, an {@link AuthIdGenerator},
 * and an {@link AuthClock}.
 *
 * BetterAuth seam: BetterAuth is not a compile-time dependency of this package.
 * It is modelled behind the {@link AuthProvider} port; the concrete BetterAuth
 * adapter is wired in the application layer. This satisfies the design's
 * "on BetterAuth" requirement (Req 33.1) through an adapter seam while keeping
 * the domain logic testable without the framework or a network.
 *
 * SECURITY: the service never persists, logs, or echoes a raw password, MFA
 * secret, or session token. Passwords and second factors are verified only by
 * the {@link AuthProvider}; only one-way token hashes are stored on a
 * {@link SessionRecord}; raw tokens are returned to the caller EXACTLY ONCE at
 * issuance. A failed authentication returns a uniform
 * {@link AuthenticationFailedError} that never reveals whether the account
 * exists, and is recorded in the Audit_Service first (Req 33.12).
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import { constantTimeEqual, sha256TokenHasher, systemTokenGenerator } from './auth-crypto.js';
import {
  AuthenticationFailedError,
  InvalidSessionError,
  MfaFactorNotFoundError,
  MfaRequiredError,
} from './errors.js';
import { resolveMfaRequirement } from './mfa.js';
import {
  DEFAULT_AUTH_LIFETIMES,
  type AuditRecorder,
  type AuthClock,
  type AuthIdGenerator,
  type AuthLifetimes,
  type AuthMethod,
  type AuthProvider,
  type IdentityLink,
  type IdentityLinkInput,
  type IdentityLinkStore,
  type IssuedTokens,
  type MfaEnrollmentResult,
  type MfaEnrollmentStore,
  type MfaFactorRecord,
  type MfaFactorType,
  type MfaRequirement,
  type OAuthSignInInput,
  type PasswordSignInInput,
  type SamlSignInInput,
  type Session,
  type SessionIdentity,
  type SessionRecord,
  type SessionStore,
  type SignInResult,
  type TokenGenerator,
  type TokenHasher,
  type VerifiedIdentity,
} from './types.js';

/** The system clock backing the {@link AuthClock} port when none is injected. */
const systemAuthClock: AuthClock = { now: () => new Date() };

/** Default id generator backed by `crypto.randomUUID`. */
const defaultAuthIdGenerator: AuthIdGenerator = {
  sessionId: () => `sess_${randomUUID()}`,
  linkId: () => `idl_${randomUUID()}`,
  factorId: () => `mfa_${randomUUID()}`,
};

/** Construction dependencies for the {@link AuthService} (all injectable). */
export interface AuthServiceOptions {
  /** The BetterAuth seam: verifies credentials and second factors (Req 33.1-33.5). */
  provider: AuthProvider;
  /** Persistence for sessions and their issued-token hashes (Req 33.8, 33.9, 33.13). */
  sessions: SessionStore;
  /** Persistence for SSO / identity-provider associations (Req 33.3, 33.4). */
  identityLinks: IdentityLinkStore;
  /** Persistence for enrolled MFA factors — metadata only (Req 33.5). */
  mfaFactors: MfaEnrollmentStore;
  /** The append-only audit sink; failed auth and sign-out are recorded through it (Req 33.12, 37.1). */
  audit: AuditRecorder;
  /** The CSPRNG token generator; defaults to {@link systemTokenGenerator}. */
  tokenGenerator?: TokenGenerator;
  /** The one-way token hasher; defaults to {@link sha256TokenHasher}. */
  tokenHasher?: TokenHasher;
  /** The id generator; defaults to `crypto.randomUUID`-backed ids. */
  idGenerator?: AuthIdGenerator;
  /** The clock for token/session expiry; defaults to the system clock. */
  clock?: AuthClock;
  /** The token/session lifetimes; defaults to {@link DEFAULT_AUTH_LIFETIMES}. */
  lifetimes?: AuthLifetimes;
}

/**
 * Project a stored {@link SessionRecord} into its masked, secret-free
 * {@link Session} form. Every token hash is dropped here, so a token hash never
 * crosses the service boundary.
 */
export function toSession(record: SessionRecord): Session {
  const session: Session = {
    id: record.id,
    userId: record.userId,
    organizationId: record.organizationId,
    roles: [...record.roles],
    method: record.method,
    mfaSatisfied: record.mfaSatisfied,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastActiveAt: record.lastActiveAt,
  };
  if (record.deviceId !== undefined) session.deviceId = record.deviceId;
  if (record.deviceName !== undefined) session.deviceName = record.deviceName;
  if (record.revokedAt !== undefined) session.revokedAt = record.revokedAt;
  return session;
}

/**
 * The Auth_Service. Construct once with its injected dependencies (the
 * BetterAuth {@link AuthProvider} chief among them), then drive sign-in,
 * validation, refresh, sign-out, identity association, and MFA enrollment.
 */
export class AuthService {
  private readonly provider: AuthProvider;
  private readonly sessions: SessionStore;
  private readonly identityLinks: IdentityLinkStore;
  private readonly mfaFactors: MfaEnrollmentStore;
  private readonly audit: AuditRecorder;
  private readonly tokenGenerator: TokenGenerator;
  private readonly tokenHasher: TokenHasher;
  private readonly ids: AuthIdGenerator;
  private readonly clock: AuthClock;
  private readonly lifetimes: AuthLifetimes;

  constructor(options: AuthServiceOptions) {
    this.provider = options.provider;
    this.sessions = options.sessions;
    this.identityLinks = options.identityLinks;
    this.mfaFactors = options.mfaFactors;
    this.audit = options.audit;
    this.tokenGenerator = options.tokenGenerator ?? systemTokenGenerator;
    this.tokenHasher = options.tokenHasher ?? sha256TokenHasher;
    this.ids = options.idGenerator ?? defaultAuthIdGenerator;
    this.clock = options.clock ?? systemAuthClock;
    this.lifetimes = options.lifetimes ?? DEFAULT_AUTH_LIFETIMES;
  }

  /**
   * Sign in with email and password (Req 33.2).
   *
   * Delegates credential verification to the BetterAuth {@link AuthProvider};
   * on success, resolves the MFA requirement and (when required) verifies the
   * supplied second factor before establishing a session and issuing tokens.
   * A failed credential or second-factor check denies access and is recorded in
   * the Audit_Service first (Req 33.12).
   *
   * @param input The email, raw password, optional MFA code, and device info.
   * @returns The established {@link SignInResult} (masked session + one-time tokens).
   * @throws AuthenticationFailedError when credentials or the second factor are invalid.
   * @throws MfaRequiredError when a required second factor was not supplied.
   */
  async signInPassword(input: PasswordSignInInput): Promise<SignInResult> {
    const identity = await this.provider.verifyPassword(input.email, input.password);
    return this.completeSignIn('password', identity, input.mfaCode, input.device);
  }

  /**
   * Sign in through the configured OAuth/OIDC identity provider (Req 33.3).
   *
   * Delegates code verification to the BetterAuth {@link AuthProvider}; on
   * success, ensures the resolved external account is associated with the
   * platform user (Req 33.3), then applies the same MFA gate and session
   * issuance as a password sign-in.
   *
   * @param input The provider id, authorization code, optional MFA code, and device info.
   * @returns The established {@link SignInResult}.
   * @throws AuthenticationFailedError when verification or the second factor fails.
   * @throws MfaRequiredError when a required second factor was not supplied.
   */
  async signInOAuth(input: OAuthSignInInput): Promise<SignInResult> {
    const identity = await this.provider.verifyOAuth(input.provider, input.code);
    await this.ensureIdentityLink(identity);
    return this.completeSignIn('oauth', identity, input.mfaCode, input.device);
  }

  /**
   * Sign in through the configured enterprise SSO (SAML 2.0) identity provider
   * (Req 33.4).
   *
   * Delegates SAML response verification to the BetterAuth {@link AuthProvider};
   * on success, ensures the asserted external account is associated with the
   * platform user, then applies the same MFA gate and session issuance.
   *
   * @param input The SAML response, optional MFA code, and device info.
   * @returns The established {@link SignInResult}.
   * @throws AuthenticationFailedError when verification or the second factor fails.
   * @throws MfaRequiredError when a required second factor was not supplied.
   */
  async signInSSO(input: SamlSignInInput): Promise<SignInResult> {
    const identity = await this.provider.verifySaml(input.samlResponse);
    await this.ensureIdentityLink(identity);
    return this.completeSignIn('saml', identity, input.mfaCode, input.device);
  }

  /**
   * Resolve whether a second factor is required for a verified identity
   * (Req 33.5, 33.6, 33.7) — the pure decision, exposed without side effects so
   * callers (and Property 51) can inspect it directly.
   *
   * @param identity The verified identity (or its MFA-relevant facts).
   * @returns The structured {@link MfaRequirement}.
   */
  requireMfa(identity: Pick<VerifiedIdentity, 'roles' | 'mfaEnabled' | 'orgMfaRequired'>): MfaRequirement {
    return resolveMfaRequirement({
      roles: identity.roles,
      userMfaEnabled: identity.mfaEnabled,
      orgMfaRequired: identity.orgMfaRequired,
    });
  }

  /**
   * Validate a presented access token (Req 33.8).
   *
   * Resolves the session by the token's hash and accepts it only when the
   * session is live — not revoked (Req 33.13), not past its expiry, and the
   * access token itself is unexpired and matches in constant time. A valid
   * validation advances the session's `lastActiveAt` (Req 33.10). Every failure
   * raises an {@link InvalidSessionError}; the method never mutates state on a
   * rejection.
   *
   * @param accessToken The raw access token presented by the client.
   * @returns The minimal {@link SessionIdentity} resolved from the live session.
   * @throws InvalidSessionError when the token is unknown, expired, or revoked.
   */
  async validate(accessToken: string): Promise<SessionIdentity> {
    const hash = this.tokenHasher.hash(accessToken);
    const record = await this.sessions.findByAccessTokenHash(hash);
    if (
      record === null ||
      record.accessTokenHash === undefined ||
      !constantTimeEqual(record.accessTokenHash, hash)
    ) {
      throw new InvalidSessionError('unknown');
    }
    if (record.revokedAt !== undefined) {
      throw new InvalidSessionError('revoked');
    }
    const now = this.clock.now();
    if (
      this.isPast(record.expiresAt, now) ||
      record.accessTokenExpiresAt === undefined ||
      this.isPast(record.accessTokenExpiresAt, now)
    ) {
      throw new InvalidSessionError('expired');
    }

    const advanced: SessionRecord = { ...record, lastActiveAt: now.toISOString() };
    await this.sessions.update(advanced);

    return {
      userId: record.userId,
      organizationId: record.organizationId,
      roles: [...record.roles],
      sessionId: record.id,
    };
  }

  /**
   * Reissue an access token from a valid refresh token (Req 33.9).
   *
   * Resolves the session by the refresh token's hash and, only when the session
   * is live (not revoked, not expired) and the refresh token matches in constant
   * time, mints a new short-lived access token, stores its hash (rotating the
   * previous access token out), and returns only the new access token. The
   * refresh token is unchanged.
   *
   * @param refreshToken The raw refresh token presented by the client.
   * @returns The reissued {@link IssuedTokens} carrying only a new access token.
   * @throws InvalidSessionError when the refresh token is unknown, expired, or revoked.
   */
  async refresh(refreshToken: string): Promise<IssuedTokens> {
    const hash = this.tokenHasher.hash(refreshToken);
    const record = await this.sessions.findByRefreshTokenHash(hash);
    if (
      record === null ||
      record.refreshTokenHash === undefined ||
      !constantTimeEqual(record.refreshTokenHash, hash)
    ) {
      throw new InvalidSessionError('unknown');
    }
    if (record.revokedAt !== undefined) {
      throw new InvalidSessionError('revoked');
    }
    const now = this.clock.now();
    if (this.isPast(record.expiresAt, now)) {
      throw new InvalidSessionError('expired');
    }

    const access = this.tokenGenerator.generate();
    const accessExpiresAt = this.expiryFrom(now, this.lifetimes.accessTokenTtlSeconds);
    const updated: SessionRecord = {
      ...record,
      accessTokenHash: this.tokenHasher.hash(access),
      accessTokenExpiresAt: accessExpiresAt,
      lastActiveAt: now.toISOString(),
    };
    await this.sessions.update(updated);

    // SECURITY: the new raw access token is returned here exactly once.
    return { access, accessExpiresAt };
  }

  /**
   * Sign out, revoking the session so its tokens are rejected thereafter
   * (Req 33.13).
   *
   * Marks the session revoked and clears its stored token hashes, then records a
   * `auth.sign_out` audit event. A subsequent {@link validate} or {@link refresh}
   * of the session's tokens fails with an {@link InvalidSessionError}. Signing
   * out an unknown or already-revoked session is idempotent and does nothing.
   *
   * @param sessionId The session to revoke.
   */
  async signOut(sessionId: string): Promise<void> {
    const record = await this.sessions.findById(sessionId);
    if (record === null || record.revokedAt !== undefined) {
      return;
    }
    const now = this.clock.now();
    const revoked: SessionRecord = {
      ...record,
      revokedAt: now.toISOString(),
      lastActiveAt: now.toISOString(),
    };
    // The session row is retained (and stays resolvable by its token hashes) so
    // a subsequent validate/refresh resolves it and rejects with the precise
    // `revoked` reason (Req 33.13). The hashes are one-way digests, not secrets.
    await this.sessions.update(revoked);

    await this.audit.record(this.contextFor(record), {
      action: 'auth.sign_out',
      resourceType: 'session',
      resourceId: record.id,
      actorId: record.userId,
      metadata: { method: record.method },
    });
  }

  /**
   * Associate a platform user with an external identity-provider account
   * (Req 33.3, 33.4).
   *
   * Records that the `(provider, providerAccountId)` pair maps to the user, so a
   * subsequent OAuth/OIDC or SAML sign-in resolves to the same user. An existing
   * link for the pair is returned unchanged (idempotent association). Records a
   * `auth.identity_link` audit event on a new association.
   *
   * @param ctx The acting principal's tenant context.
   * @param input The user, provider, and provider account id to associate.
   * @returns The persisted {@link IdentityLink}.
   */
  async associateIdentity(ctx: TenantContext, input: IdentityLinkInput): Promise<IdentityLink> {
    const existing = await this.identityLinks.findByProviderAccount(
      input.provider,
      input.providerAccountId,
    );
    if (existing !== null) {
      return existing;
    }
    const link: IdentityLink = {
      id: input.id ?? this.ids.linkId(),
      userId: input.userId,
      organizationId: ctx.organizationId,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      createdAt: this.clock.now().toISOString(),
    };
    const stored = await this.identityLinks.insert(ctx, link);
    await this.audit.record(ctx, {
      action: 'auth.identity_link',
      resourceType: 'user',
      resourceId: input.userId,
      metadata: { provider: input.provider, providerAccountId: input.providerAccountId },
    });
    return stored;
  }

  /** List a user's external identity-provider associations (Req 33.3, 33.4). */
  async listIdentities(ctx: TenantContext, userId: string): Promise<IdentityLink[]> {
    return this.identityLinks.listByUser(ctx, userId);
  }

  /**
   * Begin MFA enrollment for a user (Req 33.5).
   *
   * Delegates to the BetterAuth {@link AuthProvider} to mint the factor's shared
   * secret and return non-secret provisioning material, persists a `pending`
   * factor record (metadata only — never the secret), and records a
   * `auth.mfa_enroll` audit event. The factor becomes usable only after
   * {@link verifyMfaEnrollment} confirms a first code.
   *
   * @param ctx The acting principal's tenant context.
   * @param userId The user enrolling the factor.
   * @param factor The factor kind to enroll.
   * @returns The pending {@link MfaFactorRecord} and the one-time provisioning material.
   */
  async beginMfaEnrollment(
    ctx: TenantContext,
    userId: string,
    factor: MfaFactorType,
  ): Promise<MfaEnrollmentResult> {
    const enrollment = await this.provider.beginMfaEnrollment(userId, factor);
    const record: MfaFactorRecord = {
      id: this.ids.factorId(),
      userId,
      organizationId: ctx.organizationId,
      factor,
      status: 'pending',
      createdAt: this.clock.now().toISOString(),
    };
    const stored = await this.mfaFactors.insert(ctx, record);
    await this.audit.record(ctx, {
      action: 'auth.mfa_enroll',
      resourceType: 'user',
      resourceId: userId,
      metadata: { factor, factorId: stored.id, status: stored.status },
    });
    return { record: stored, enrollment };
  }

  /**
   * Verify the first code for a pending MFA enrollment, activating the factor
   * (Req 33.5).
   *
   * Delegates code verification to the BetterAuth {@link AuthProvider}. On a
   * valid code the factor is marked `active` and a `auth.mfa_activate` audit
   * event is recorded; on an invalid code the factor stays pending and an
   * {@link AuthenticationFailedError} is raised (recorded as a failed auth
   * attempt, Req 33.12).
   *
   * @param ctx The acting principal's tenant context.
   * @param factorId The pending factor to activate.
   * @param code The submitted second-factor code.
   * @returns The activated {@link MfaFactorRecord}.
   * @throws MfaFactorNotFoundError when no such factor exists in the tenant.
   * @throws AuthenticationFailedError when the code is invalid.
   */
  async verifyMfaEnrollment(
    ctx: TenantContext,
    factorId: string,
    code: string,
  ): Promise<MfaFactorRecord> {
    const record = await this.mfaFactors.findById(ctx, factorId);
    if (record === null) {
      throw new MfaFactorNotFoundError(factorId);
    }
    const valid = await this.provider.verifyMfaCode(record.userId, code);
    if (!valid) {
      await this.recordFailedAuth('password', {
        reason: 'mfa_enrollment_verification_failed',
        factorId,
        userId: record.userId,
        organizationId: ctx.organizationId,
      });
      throw new AuthenticationFailedError('password');
    }
    const activated: MfaFactorRecord = {
      ...record,
      status: 'active',
      activatedAt: this.clock.now().toISOString(),
    };
    const updated = await this.mfaFactors.update(ctx, activated);
    await this.audit.record(ctx, {
      action: 'auth.mfa_activate',
      resourceType: 'user',
      resourceId: record.userId,
      metadata: { factor: record.factor, factorId },
    });
    return updated ?? activated;
  }

  /** List a user's enrolled MFA factors — metadata only (Req 33.5). */
  async listMfaFactors(ctx: TenantContext, userId: string): Promise<MfaFactorRecord[]> {
    return this.mfaFactors.listByUser(ctx, userId);
  }

  // -------------------------------------------------------------------------
  // Internal orchestration
  // -------------------------------------------------------------------------

  /**
   * The shared tail of every sign-in: a failed verification denies and audits
   * (Req 33.12); otherwise the MFA requirement is resolved and gated (Req
   * 33.5-33.7) before a session is established and tokens issued (Req 33.8).
   */
  private async completeSignIn(
    method: AuthMethod,
    identity: VerifiedIdentity | null,
    mfaCode: string | undefined,
    device: PasswordSignInInput['device'],
  ): Promise<SignInResult> {
    if (identity === null) {
      await this.recordFailedAuth(method, { reason: 'invalid_credentials' });
      throw new AuthenticationFailedError(method);
    }

    const requirement = this.requireMfa(identity);
    if (requirement.required) {
      if (mfaCode === undefined || mfaCode === '') {
        // Credentials were valid but a required second factor is missing; the
        // caller must collect one and retry. This is not a failed auth attempt.
        throw new MfaRequiredError(requirement.reasons);
      }
      const ok = await this.provider.verifyMfaCode(identity.userId, mfaCode);
      if (!ok) {
        await this.recordFailedAuth(method, {
          reason: 'invalid_mfa_code',
          userId: identity.userId,
          organizationId: identity.organizationId,
        });
        throw new AuthenticationFailedError(method);
      }
    }

    return this.establishSession(method, identity, requirement.required, device);
  }

  /** Mint a session record with a fresh access + refresh token pair (Req 33.8). */
  private async establishSession(
    method: AuthMethod,
    identity: VerifiedIdentity,
    mfaSatisfied: boolean,
    device: PasswordSignInInput['device'],
  ): Promise<SignInResult> {
    const now = this.clock.now();
    const access = this.tokenGenerator.generate();
    const refresh = this.tokenGenerator.generate();
    const accessExpiresAt = this.expiryFrom(now, this.lifetimes.accessTokenTtlSeconds);
    const refreshExpiresAt = this.expiryFrom(now, this.lifetimes.refreshTokenTtlSeconds);

    const record: SessionRecord = {
      id: this.ids.sessionId(),
      userId: identity.userId,
      organizationId: identity.organizationId,
      roles: [...identity.roles],
      method,
      mfaSatisfied,
      createdAt: now.toISOString(),
      expiresAt: refreshExpiresAt,
      lastActiveAt: now.toISOString(),
      accessTokenHash: this.tokenHasher.hash(access),
      accessTokenExpiresAt: accessExpiresAt,
      refreshTokenHash: this.tokenHasher.hash(refresh),
    };
    if (device?.deviceId !== undefined) record.deviceId = device.deviceId;
    if (device?.deviceName !== undefined) record.deviceName = device.deviceName;

    const stored = await this.sessions.create(record);
    await this.audit.record(this.contextFor(stored), {
      action: 'auth.sign_in',
      resourceType: 'session',
      resourceId: stored.id,
      actorId: stored.userId,
      ...(device?.ip !== undefined ? { ip: device.ip } : {}),
      ...(device?.userAgent !== undefined ? { userAgent: device.userAgent } : {}),
      metadata: { method, mfaSatisfied },
    });

    const tokens: IssuedTokens = { access, accessExpiresAt, refresh, refreshExpiresAt };
    // SECURITY: the raw access + refresh tokens are returned here exactly once.
    return { session: toSession(stored), tokens };
  }

  /**
   * Ensure a verified external identity is associated with its platform user
   * (Req 33.3, 33.4). No-op when the identity carries no provider account.
   */
  private async ensureIdentityLink(identity: VerifiedIdentity | null): Promise<void> {
    if (
      identity === null ||
      identity.provider === undefined ||
      identity.providerAccountId === undefined
    ) {
      return;
    }
    const existing = await this.identityLinks.findByProviderAccount(
      identity.provider,
      identity.providerAccountId,
    );
    if (existing !== null) {
      return;
    }
    const ctx = this.contextFor(identity);
    const link: IdentityLink = {
      id: this.ids.linkId(),
      userId: identity.userId,
      organizationId: identity.organizationId,
      provider: identity.provider,
      providerAccountId: identity.providerAccountId,
      createdAt: this.clock.now().toISOString(),
    };
    await this.identityLinks.insert(ctx, link);
    await this.audit.record(ctx, {
      action: 'auth.identity_link',
      resourceType: 'user',
      resourceId: identity.userId,
      metadata: { provider: identity.provider, providerAccountId: identity.providerAccountId },
    });
  }

  /**
   * Record a failed authentication attempt in the Audit_Service (Req 33.12).
   *
   * SECURITY: the recorded metadata never includes a password, MFA secret, or
   * token — only the method and a coarse, non-secret reason.
   */
  private async recordFailedAuth(
    method: AuthMethod,
    detail: {
      reason: string;
      userId?: string;
      organizationId?: string;
      factorId?: string;
    },
  ): Promise<void> {
    const ctx: TenantContext = {
      organizationId: detail.organizationId ?? '',
      userId: detail.userId ?? '',
    };
    const metadata: Record<string, unknown> = { method, reason: detail.reason };
    if (detail.factorId !== undefined) metadata.factorId = detail.factorId;
    await this.audit.record(ctx, {
      action: 'auth.failed',
      resourceType: 'session',
      resourceId: detail.userId ?? 'unknown',
      ...(detail.userId !== undefined ? { actorId: detail.userId } : {}),
      metadata,
    });
  }

  /** Build the tenant context an audited session effect is scoped to. */
  private contextFor(scope: { organizationId: string; userId: string }): TenantContext {
    return { organizationId: scope.organizationId, userId: scope.userId };
  }

  /** The ISO-8601 instant `ttlSeconds` after `from`. */
  private expiryFrom(from: Date, ttlSeconds: number): string {
    return new Date(from.getTime() + ttlSeconds * 1000).toISOString();
  }

  /** Whether an ISO-8601 instant is at or before "now". */
  private isPast(iso: string, now: Date): boolean {
    return new Date(iso).getTime() <= now.getTime();
  }
}
