/**
 * Auth_Service (Req 33.1-33.9, 33.12, 33.13).
 *
 * The authentication service that authenticates users, establishes and
 * validates sessions, issues and refreshes tokens, associates external
 * identities, and enforces multi-factor authentication. Per Req 33.1 it is
 * built "on BetterAuth": BetterAuth is modelled behind the narrow injectable
 * {@link AuthProvider} seam (it is NOT a compile-time dependency of this
 * package), and the concrete BetterAuth adapter — which owns password hashing
 * and the OAuth/OIDC, SAML 2.0, and MFA-secret flows — is wired in the
 * application layer. This keeps the domain logic pure orchestration and fully
 * unit-testable with the fakes in `./fakes.js`.
 *
 * Surface:
 *   - {@link AuthService} — the service; one method per acceptance criterion:
 *     `signInPassword` (Req 33.2), `signInOAuth` (Req 33.3), and `signInSSO`
 *     (Req 33.4) delegate credential verification to the {@link AuthProvider},
 *     gate on the resolved MFA requirement (Req 33.5-33.7), then issue a
 *     short-lived access token + refresh token (Req 33.8); `requireMfa` exposes
 *     the pure requirement decision; `validate` accepts a live session and
 *     rejects an expired/revoked one (Req 33.8, 33.13); `refresh` reissues an
 *     access token from a valid refresh token (Req 33.9); `signOut` revokes a
 *     session so its tokens are rejected thereafter (Req 33.13);
 *     `associateIdentity`/`listIdentities` manage SSO associations (Req 33.3,
 *     33.4); `beginMfaEnrollment`/`verifyMfaEnrollment`/`listMfaFactors` enroll
 *     and activate second factors (Req 33.5). Every FAILED authentication is
 *     recorded in the Audit_Service (Req 33.12), and sign-in/sign-out are
 *     audited (Req 37.1).
 *   - {@link toSession} — the pure record→masked projection that drops every
 *     token hash so it never crosses the service boundary.
 *   - {@link resolveMfaRequirement} / {@link hasPrivilegedRole} — the pure MFA
 *     requirement core validated by Property 51 (task 20.2).
 *   - the production crypto primitives {@link systemTokenGenerator} /
 *     {@link sha256TokenHasher} / {@link generateOpaqueToken} /
 *     {@link base64UrlEncode}, and the injectable ports the service composes
 *     ({@link AuthProvider}, {@link SessionStore}, {@link IdentityLinkStore},
 *     {@link MfaEnrollmentStore}, {@link TokenGenerator}, {@link TokenHasher},
 *     {@link AuthIdGenerator}, {@link AuthClock}).
 *   - domain types ({@link Session}, {@link SessionRecord}, {@link IssuedTokens},
 *     {@link SessionIdentity}, {@link SignInResult}, {@link VerifiedIdentity},
 *     {@link IdentityLink}, {@link MfaFactorRecord}, {@link MfaEnrollment},
 *     {@link MfaRequirement}, …) and the typed errors
 *     ({@link AuthenticationFailedError}, {@link MfaRequiredError},
 *     {@link InvalidSessionError}, {@link MfaFactorNotFoundError}).
 *
 * The in-memory test fakes live in `./fakes.js` and are intentionally NOT
 * re-exported from this barrel — they would collide with the equally-named
 * audit-recorder/clock fakes of sibling modules at the package barrel.
 * Following the established convention, the tests import them directly from
 * `./fakes.js`. The injectable clock is named {@link AuthClock} (not `Clock`)
 * and the crypto `constantTimeEqual` helper is kept module-private so it never
 * collides with the API_Key_Manager's same-named export at the package barrel.
 */

export { AuthService, toSession, type AuthServiceOptions } from './auth-service.js';

export { resolveMfaRequirement, hasPrivilegedRole } from './mfa.js';

export {
  TOKEN_SECRET_BYTES,
  systemTokenGenerator,
  sha256TokenHasher,
  generateOpaqueToken,
  base64UrlEncode,
} from './auth-crypto.js';

export {
  AuthenticationFailedError,
  MfaRequiredError,
  InvalidSessionError,
  MfaFactorNotFoundError,
  AUTHENTICATION_FAILED_CODE,
  MFA_REQUIRED_CODE,
  INVALID_SESSION_CODE,
  MFA_FACTOR_NOT_FOUND_CODE,
} from './errors.js';

export {
  AUTH_METHODS,
  MFA_FACTOR_TYPES,
  MFA_PRIVILEGED_ROLES,
  DEFAULT_AUTH_LIFETIMES,
  type AuthMethod,
  type DeviceInfo,
  type VerifiedIdentity,
  type PasswordSignInInput,
  type OAuthSignInInput,
  type SamlSignInInput,
  type MfaRequirementInput,
  type MfaRequirementReason,
  type MfaRequirement,
  type MfaFactorType,
  type MfaFactorStatus,
  type MfaEnrollment,
  type MfaFactorRecord,
  type MfaEnrollmentResult,
  type IdentityLink,
  type IdentityLinkInput,
  type SessionRecord,
  type Session,
  type IssuedTokens,
  type SessionIdentity,
  type SignInResult,
  type AuthProvider,
  type SessionStore,
  type IdentityLinkStore,
  type MfaEnrollmentStore,
  type TokenGenerator,
  type TokenHasher,
  type AuthIdGenerator,
  type AuthClock,
  type AuthLifetimes,
} from './types.js';
