/**
 * Auth_Service domain types and injectable ports (Req 33.1-33.9, 33.12, 33.13).
 *
 * The Auth_Service authenticates users, establishes and validates sessions, and
 * enforces multi-factor authentication. The requirements mandate that it is
 * "built on BetterAuth" (Req 33.1). BetterAuth is not a compile-time dependency
 * of this package; instead it is modelled behind a narrow injectable
 * {@link AuthProvider} seam so the service stays pure orchestration and fully
 * unit-testable with a fake. The concrete BetterAuth adapter (which owns
 * password hashing, the OAuth/OIDC and SAML 2.0 flows, and the MFA shared
 * secrets) is wired in the application layer and implements this port. The
 * "on BetterAuth" requirement is therefore satisfied by the adapter seam.
 *
 * The service composes only the narrow ports declared here:
 *   - {@link AuthProvider} — the BetterAuth seam: verifies credentials
 *     (password / OAuth-OIDC / SAML) and second factors, and begins MFA
 *     enrollment. It is the ONLY thing that ever touches a raw password or an
 *     MFA shared secret (Req 33.2, 33.3, 33.4, 33.5).
 *   - {@link SessionStore} — tenant-aware persistence for sessions and the
 *     hashes of their issued tokens (Req 33.8, 33.9, 33.13).
 *   - {@link IdentityLinkStore} — persistence for SSO / identity-provider
 *     associations (Req 33.3, 33.4).
 *   - {@link MfaEnrollmentStore} — persistence for a user's enrolled MFA
 *     factors (factor metadata only — never a secret) (Req 33.5).
 *   - the shared {@link AuditRecorder} — records failed authentication and
 *     sign-out immutably (Req 33.12, 37.1).
 *   - {@link TokenGenerator} / {@link TokenHasher} — mint high-entropy token
 *     secrets and hash them for storage; the production implementations live in
 *     `./auth-crypto.js`.
 *   - {@link AuthClock} — the injectable clock that fixes "now" so token and
 *     session expiry are deterministic in tests.
 *
 * SECURITY: this module never persists, logs, or echoes a raw password, MFA
 * secret, or session token. Credential and second-factor verification are
 * delegated entirely to the {@link AuthProvider}; only one-way token hashes are
 * stored on a {@link SessionRecord}, and a raw token is returned to the caller
 * EXACTLY ONCE at issuance (mirroring the API_Key_Manager's discipline).
 */

import type { Role, TenantContext } from '@auxify/types';

export type { AuditRecorder, AuditEvent } from '../audit/index.js';

// ---------------------------------------------------------------------------
// Sign-in inputs and verified identity (Req 33.2, 33.3, 33.4)
// ---------------------------------------------------------------------------

/** The means by which a user authenticated (Req 33.2, 33.3, 33.4). */
export type AuthMethod = 'password' | 'oauth' | 'saml';

/** All {@link AuthMethod} values, for iteration, validation, and test generators. */
export const AUTH_METHODS: readonly AuthMethod[] = ['password', 'oauth', 'saml'] as const;

/**
 * Optional device/connection metadata captured with a session.
 *
 * It is recorded on the {@link SessionRecord} so the Device_Manager (task 20.3)
 * can list a user's active devices with their last-active time (Req 33.10) and
 * revoke a single device's tokens (Req 33.11). All fields are optional and
 * non-secret.
 */
export interface DeviceInfo {
  /** A stable device identifier supplied by the client, when known. */
  deviceId?: string;
  /** A human-friendly device label (e.g. "Chrome on macOS"). */
  deviceName?: string;
  /** The originating IP address, recorded for the audit trail (Req 37.1). */
  ip?: string;
  /** The originating user agent, recorded for the audit trail (Req 37.1). */
  userAgent?: string;
}

/**
 * The identity the {@link AuthProvider} resolves from verified credentials.
 *
 * It carries exactly the facts the Auth_Service needs to resolve the MFA
 * requirement and establish a session: the authenticated user and Organization,
 * the user's roles (for the privileged-role MFA condition, Req 33.6), whether
 * the user has MFA enabled (Req 33.5), and whether the user's Organization
 * mandates MFA (Req 33.7). For an OAuth/OIDC or SAML sign-in it also carries the
 * provider and the provider-side account id so the session can be associated
 * with the identity provider (Req 33.3, 33.4).
 *
 * SECURITY: a {@link VerifiedIdentity} is produced by the BetterAuth adapter
 * only AFTER credentials are verified; it never carries a password or secret.
 */
export interface VerifiedIdentity {
  /** The authenticated user's id. */
  userId: string;
  /** The Organization the user belongs to. */
  organizationId: string;
  /** The user's email, when known. */
  email?: string;
  /** The user's roles (drives the privileged-role MFA condition, Req 33.6). */
  roles: Role[];
  /** Whether MFA is enabled for this user (Req 33.5). */
  mfaEnabled: boolean;
  /** Whether the user's Organization mandates MFA for users in scope (Req 33.7). */
  orgMfaRequired: boolean;
  /** The identity provider for an OAuth/OIDC or SAML sign-in (Req 33.3, 33.4). */
  provider?: string;
  /** The provider-side account id for an external sign-in (Req 33.3, 33.4). */
  providerAccountId?: string;
}

/** Fields supplied for a password sign-in (Req 33.2). */
export interface PasswordSignInInput {
  /** The user's email. */
  email: string;
  /** The user's raw password — passed straight to the {@link AuthProvider}, never stored. */
  password: string;
  /** A second-factor code, supplied when MFA is required for the user (Req 33.5). */
  mfaCode?: string;
  /** Optional device/connection metadata for the session. */
  device?: DeviceInfo;
}

/** Fields supplied for an OAuth/OIDC sign-in (Req 33.3). */
export interface OAuthSignInInput {
  /** The configured OAuth/OIDC provider id. */
  provider: string;
  /** The authorization code returned by the provider. */
  code: string;
  /** A second-factor code, supplied when MFA is required for the user (Req 33.5). */
  mfaCode?: string;
  /** Optional device/connection metadata for the session. */
  device?: DeviceInfo;
}

/** Fields supplied for an enterprise SSO (SAML 2.0) sign-in (Req 33.4). */
export interface SamlSignInInput {
  /** The base64 SAML response returned by the configured identity provider. */
  samlResponse: string;
  /** A second-factor code, supplied when MFA is required for the user (Req 33.5). */
  mfaCode?: string;
  /** Optional device/connection metadata for the session. */
  device?: DeviceInfo;
}

// ---------------------------------------------------------------------------
// MFA requirement resolution (Req 33.5, 33.6, 33.7)
// ---------------------------------------------------------------------------

/**
 * The facts that determine whether a second factor is required (Req 33.5-33.7).
 *
 * MFA is required if and only if at least one condition holds: it is enabled for
 * the user (Req 33.5), the user holds a privileged role of `super_admin` or
 * `admin` (Req 33.6), or the user's Organization mandates MFA (Req 33.7). This
 * is the input to the pure {@link resolveMfaRequirement} core that Property 51
 * (task 20.2) validates.
 */
export interface MfaRequirementInput {
  /** The user's roles (the privileged-role condition checks for `super_admin`/`admin`). */
  roles: Role[];
  /** Whether MFA is enabled for the user (Req 33.5). */
  userMfaEnabled: boolean;
  /** Whether the user's Organization mandates MFA (Req 33.7). */
  orgMfaRequired: boolean;
}

/** The reason an MFA requirement was triggered (Req 33.5, 33.6, 33.7). */
export type MfaRequirementReason = 'user_enabled' | 'privileged_role' | 'org_policy';

/**
 * The verdict from {@link resolveMfaRequirement}: whether a second factor is
 * required, and which condition(s) triggered it. `required` is `true` whenever
 * `reasons` is non-empty.
 */
export interface MfaRequirement {
  /** Whether a second factor must be presented before a session is established. */
  required: boolean;
  /** Every condition that triggered the requirement (empty when not required). */
  reasons: MfaRequirementReason[];
}

/** The privileged roles that always require MFA (Req 33.6). */
export const MFA_PRIVILEGED_ROLES: readonly Role[] = ['super_admin', 'admin'] as const;

// ---------------------------------------------------------------------------
// MFA enrollment (Req 33.5)
// ---------------------------------------------------------------------------

/** A supported multi-factor authentication factor kind (Req 33.5). */
export type MfaFactorType = 'totp' | 'webauthn' | 'sms';

/** All {@link MfaFactorType} values, for iteration, validation, and test generators. */
export const MFA_FACTOR_TYPES: readonly MfaFactorType[] = ['totp', 'webauthn', 'sms'] as const;

/** The lifecycle status of an enrolled MFA factor. */
export type MfaFactorStatus = 'pending' | 'active';

/**
 * The non-secret provisioning material the {@link AuthProvider} returns when MFA
 * enrollment begins (Req 33.5).
 *
 * For TOTP this is the otpauth URI and/or a manual-entry key the client renders
 * as a QR code; the AuthProvider (BetterAuth) retains the actual shared secret.
 * The Auth_Service forwards this to the caller once and never stores it.
 */
export interface MfaEnrollment {
  /** The factor being enrolled. */
  factor: MfaFactorType;
  /** A provisioning URI the client renders (e.g. an otpauth URI for TOTP), when applicable. */
  provisioningUri?: string;
  /** A manual-entry provisioning key, when applicable. */
  manualEntryKey?: string;
}

/**
 * A persisted record of a user's enrolled MFA factor (Req 33.5).
 *
 * SECURITY: this record carries only the factor kind and lifecycle status —
 * NEVER the shared secret, which lives behind the {@link AuthProvider}
 * (BetterAuth) alone.
 */
export interface MfaFactorRecord {
  /** The factor's stable id. */
  id: string;
  /** The user the factor belongs to. */
  userId: string;
  /** The Organization the user belongs to. */
  organizationId: string;
  /** The factor kind. */
  factor: MfaFactorType;
  /** `pending` until the first code is verified, then `active`. */
  status: MfaFactorStatus;
  /** The ISO-8601 enrollment timestamp. */
  createdAt: string;
  /** The ISO-8601 activation timestamp, set when the factor is verified. */
  activatedAt?: string;
}

// ---------------------------------------------------------------------------
// Identity-provider association (Req 33.3, 33.4)
// ---------------------------------------------------------------------------

/**
 * A persisted association between a platform user and an external identity
 * provider account (Req 33.3, 33.4).
 *
 * It records that "user U in Organization O is the provider P account A", so a
 * subsequent OAuth/OIDC or SAML sign-in resolves to the same platform user. It
 * carries no provider tokens or secrets.
 */
export interface IdentityLink {
  /** The link's stable id. */
  id: string;
  /** The platform user the external account maps to. */
  userId: string;
  /** The Organization the user belongs to. */
  organizationId: string;
  /** The identity provider id (e.g. `okta`, `google`, `azure-ad`). */
  provider: string;
  /** The provider-side account id. */
  providerAccountId: string;
  /** The ISO-8601 creation timestamp. */
  createdAt: string;
}

/** Fields supplied to associate an external identity with a user (Req 33.3, 33.4). */
export interface IdentityLinkInput {
  /** The platform user to associate. */
  userId: string;
  /** The identity provider id. */
  provider: string;
  /** The provider-side account id. */
  providerAccountId: string;
  /** An explicit link id (defaults to a generated id). */
  id?: string;
}

// ---------------------------------------------------------------------------
// Sessions and tokens (Req 33.8, 33.9, 33.13)
// ---------------------------------------------------------------------------

/**
 * A persisted session record — the system of record for an authenticated
 * session (Req 33.8, 33.9, 33.13).
 *
 * SECURITY: the record stores only the one-way HASHES of the issued access and
 * refresh tokens (Req 35.4 discipline), never the raw tokens. A session is
 * usable only while it has not been revoked ({@link revokedAt} unset) and has
 * not expired ({@link expiresAt} in the future); an access token is additionally
 * gated by {@link accessTokenExpiresAt} so it is short-lived independently of
 * the session (Req 33.8).
 */
export interface SessionRecord {
  /** The session's stable id. */
  id: string;
  /** The authenticated user. */
  userId: string;
  /** The user's Organization (the session tenant scope). */
  organizationId: string;
  /** The user's roles at sign-in time. */
  roles: Role[];
  /** The method used to authenticate (Req 33.2, 33.3, 33.4). */
  method: AuthMethod;
  /** Whether a required second factor was satisfied for this session (Req 33.5). */
  mfaSatisfied: boolean;
  /** The device this session is bound to, when known (Req 33.10, 33.11). */
  deviceId?: string;
  /** A human-friendly device label, when known. */
  deviceName?: string;
  /** The ISO-8601 session creation timestamp. */
  createdAt: string;
  /** The ISO-8601 session expiry (the refresh-token lifetime). */
  expiresAt: string;
  /** The ISO-8601 timestamp of the session's most recent validated use (Req 33.10). */
  lastActiveAt: string;
  /** The ISO-8601 revocation timestamp; when set, the session is rejected (Req 33.13). */
  revokedAt?: string;
  /** The SHA-256 hash of the current access token; the raw token is NEVER stored (Req 33.8). */
  accessTokenHash?: string;
  /** The ISO-8601 expiry of the current access token (short-lived, Req 33.8). */
  accessTokenExpiresAt?: string;
  /** The SHA-256 hash of the refresh token; the raw token is NEVER stored (Req 33.9). */
  refreshTokenHash?: string;
}

/**
 * The masked, secret-free projection of a session returned to callers.
 *
 * It deliberately OMITS every token hash, so a session view can never be used to
 * reconstruct or compare a token.
 */
export interface Session {
  /** The session's stable id. */
  id: string;
  /** The authenticated user. */
  userId: string;
  /** The user's Organization. */
  organizationId: string;
  /** The user's roles at sign-in time. */
  roles: Role[];
  /** The method used to authenticate. */
  method: AuthMethod;
  /** Whether a required second factor was satisfied for this session. */
  mfaSatisfied: boolean;
  /** The device this session is bound to, when known. */
  deviceId?: string;
  /** A human-friendly device label, when known. */
  deviceName?: string;
  /** The ISO-8601 session creation timestamp. */
  createdAt: string;
  /** The ISO-8601 session expiry. */
  expiresAt: string;
  /** The ISO-8601 last-active timestamp. */
  lastActiveAt: string;
  /** The ISO-8601 revocation timestamp, when revoked. */
  revokedAt?: string;
}

/**
 * A freshly-issued token pair (Req 33.8) or a refreshed access token (Req 33.9).
 *
 * SECURITY: {@link access} and {@link refresh} are raw secrets, returned EXACTLY
 * ONCE here and never persisted or returned again — only their hashes are stored
 * on the {@link SessionRecord}. A refresh ({@link import('./auth-service.js').AuthService.refresh})
 * returns only a new {@link access} token and omits {@link refresh}.
 */
export interface IssuedTokens {
  /** The raw short-lived access token (Req 33.8). */
  access: string;
  /** The ISO-8601 access-token expiry. */
  accessExpiresAt: string;
  /** The raw refresh token (Req 33.8); omitted by a refresh, which reissues only the access token. */
  refresh?: string;
  /** The ISO-8601 refresh-token expiry, present when {@link refresh} is. */
  refreshExpiresAt?: string;
}

/**
 * The authenticated identity resolved from a valid access token (Req 33.8).
 *
 * It is the minimal, auth-established identity — the acting user, Organization,
 * roles, and originating session — that downstream layers compose with the user
 * record to build the full {@link import('@auxify/types').Principal}.
 */
export interface SessionIdentity {
  /** The acting user's id. */
  userId: string;
  /** The user's Organization. */
  organizationId: string;
  /** The user's roles. */
  roles: Role[];
  /** The originating session id. */
  sessionId: string;
}

/**
 * The result of a successful sign-in (Req 33.2-33.4, 33.8).
 *
 * Authentication succeeding issues a short-lived access token and a refresh
 * token (Req 33.8), so a sign-in returns both the masked {@link Session} and the
 * one-time {@link IssuedTokens}. The raw tokens in {@link tokens} are returned
 * EXACTLY ONCE here.
 */
export interface SignInResult {
  /** The masked, secret-free established session. */
  session: Session;
  /** The one-time issued access + refresh tokens (Req 33.8). */
  tokens: IssuedTokens;
}

/** The result of beginning MFA enrollment (Req 33.5). */
export interface MfaEnrollmentResult {
  /** The persisted (pending) factor record — metadata only, never a secret. */
  record: MfaFactorRecord;
  /** The non-secret provisioning material to forward to the client once. */
  enrollment: MfaEnrollment;
}

// ---------------------------------------------------------------------------
// Injectable ports
// ---------------------------------------------------------------------------

/**
 * The BetterAuth seam (Req 33.1).
 *
 * Every credential- and secret-handling operation is delegated to this port so
 * the Auth_Service body never touches a raw password or an MFA shared secret.
 * The production implementation is the BetterAuth adapter wired in the
 * application layer; tests substitute a deterministic fake.
 *
 * Each verification returns the resolved {@link VerifiedIdentity} on success or
 * `null` on failure, so a failed authentication is an ordinary, auditable
 * outcome rather than a thrown error and never leaks whether the account exists
 * (Req 33.12).
 */
export interface AuthProvider {
  /**
   * Verify email/password credentials (Req 33.2).
   *
   * @param email The user's email.
   * @param password The user's raw password (never stored by the service).
   * @returns The verified identity, or `null` when the credentials are invalid.
   */
  verifyPassword(email: string, password: string): Promise<VerifiedIdentity | null>;
  /**
   * Verify an OAuth/OIDC authorization code through the configured provider
   * (Req 33.3).
   *
   * @param provider The configured OAuth/OIDC provider id.
   * @param code The authorization code returned by the provider.
   * @returns The verified identity, or `null` when verification fails.
   */
  verifyOAuth(provider: string, code: string): Promise<VerifiedIdentity | null>;
  /**
   * Verify a SAML 2.0 response through the configured enterprise IdP (Req 33.4).
   *
   * @param samlResponse The base64 SAML response.
   * @returns The verified identity, or `null` when verification fails.
   */
  verifySaml(samlResponse: string): Promise<VerifiedIdentity | null>;
  /**
   * Verify a second-factor code for a user (Req 33.5).
   *
   * @param userId The user presenting the second factor.
   * @param code The submitted second-factor code.
   * @returns `true` when the code is valid for the user.
   */
  verifyMfaCode(userId: string, code: string): Promise<boolean>;
  /**
   * Begin MFA enrollment for a user, returning non-secret provisioning material
   * (Req 33.5). The provider retains the shared secret.
   *
   * @param userId The user enrolling the factor.
   * @param factor The factor kind to enroll.
   * @returns The non-secret provisioning material for the client.
   */
  beginMfaEnrollment(userId: string, factor: MfaFactorType): Promise<MfaEnrollment>;
}

/**
 * Tenant-aware persistence for sessions and their issued-token hashes
 * (Req 33.8, 33.9, 33.13).
 *
 * The session lookups by token hash are deliberately tenant-agnostic:
 * validation and refresh run before a tenant context is re-established, so a
 * presented token is resolved to its session by its hash alone — mirroring the
 * API_Key_Manager's `findByHash`. The store persists the {@link SessionRecord}
 * exactly as given, which already carries only token hashes.
 */
export interface SessionStore {
  /** Persist a new session record. */
  create(record: SessionRecord): Promise<SessionRecord>;
  /** Fetch a session by id, or `null`. */
  findById(id: string): Promise<SessionRecord | null>;
  /** Resolve a session by its current access-token hash, or `null` (Req 33.8). */
  findByAccessTokenHash(hash: string): Promise<SessionRecord | null>;
  /** Resolve a session by its refresh-token hash, or `null` (Req 33.9). */
  findByRefreshTokenHash(hash: string): Promise<SessionRecord | null>;
  /** Persist an updated session record; returns the updated record, or `null` if absent. */
  update(record: SessionRecord): Promise<SessionRecord | null>;
  /** List a user's sessions, for device management (Req 33.10). */
  listByUser(userId: string): Promise<SessionRecord[]>;
}

/**
 * Tenant-scoped persistence for SSO / identity-provider associations
 * (Req 33.3, 33.4).
 */
export interface IdentityLinkStore {
  /** Persist a new identity link within the caller's Organization. */
  insert(ctx: TenantContext, link: IdentityLink): Promise<IdentityLink>;
  /**
   * Resolve the link for a `(provider, providerAccountId)` pair, across
   * Organizations, used while resolving an external sign-in (which precedes a
   * tenant context). Returns the link, or `null`.
   */
  findByProviderAccount(provider: string, providerAccountId: string): Promise<IdentityLink | null>;
  /** List a user's identity links within the caller's Organization. */
  listByUser(ctx: TenantContext, userId: string): Promise<IdentityLink[]>;
}

/**
 * Tenant-scoped persistence for a user's enrolled MFA factors (Req 33.5).
 *
 * SECURITY: stores factor metadata only — never a shared secret.
 */
export interface MfaEnrollmentStore {
  /** Persist a new factor record within the caller's Organization. */
  insert(ctx: TenantContext, record: MfaFactorRecord): Promise<MfaFactorRecord>;
  /** Fetch a factor by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<MfaFactorRecord | null>;
  /** Persist an updated factor record; returns the updated record, or `null` if absent. */
  update(ctx: TenantContext, record: MfaFactorRecord): Promise<MfaFactorRecord | null>;
  /** List a user's enrolled factors within the caller's Organization. */
  listByUser(ctx: TenantContext, userId: string): Promise<MfaFactorRecord[]>;
}

/**
 * A cryptographically-secure generator of opaque token secrets (Req 33.8) —
 * injectable so tests can supply a deterministic source. The production
 * implementation ({@link import('./auth-crypto.js').systemTokenGenerator}) draws
 * from `node:crypto`'s CSPRNG.
 */
export interface TokenGenerator {
  /** Mint a fresh, high-entropy, URL-safe token secret. */
  generate(): string;
}

/**
 * A one-way hasher for token secrets (Req 33.8, 35.4) — injectable so tests can
 * substitute a deterministic hasher. Tokens are high-entropy secrets, so the
 * production implementation ({@link import('./auth-crypto.js').sha256TokenHasher})
 * is a fast SHA-256 digest (a slow password KDF is unnecessary).
 */
export interface TokenHasher {
  /** Compute the stored hash of a raw token. */
  hash(rawToken: string): string;
}

/** Generates unique ids for sessions, identity links, and MFA factors (injectable). */
export interface AuthIdGenerator {
  /** A unique id for a new session. */
  sessionId(): string;
  /** A unique id for a new identity link. */
  linkId(): string;
  /** A unique id for a new MFA factor enrollment. */
  factorId(): string;
}

/**
 * The injectable clock that fixes "now" for token and session expiry (Req 33.8,
 * 33.9). Named `AuthClock` (not `Clock`) so it never collides with sibling
 * modules' clocks at the package barrel — the same disambiguation the
 * Cache_Manager, Scheduler, Budget_Manager, and Integration_Service made.
 */
export interface AuthClock {
  /** The current instant. */
  now(): Date;
}

/**
 * The configurable token and session lifetimes (Req 33.8).
 *
 * Access tokens are deliberately short-lived; the refresh token's lifetime
 * bounds the session.
 */
export interface AuthLifetimes {
  /** The access-token lifetime in seconds (short-lived, Req 33.8). */
  accessTokenTtlSeconds: number;
  /** The refresh-token lifetime in seconds, which also bounds the session (Req 33.9). */
  refreshTokenTtlSeconds: number;
}

/** The default token/session lifetimes: a 15-minute access token, a 30-day refresh token. */
export const DEFAULT_AUTH_LIFETIMES: AuthLifetimes = {
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
};
