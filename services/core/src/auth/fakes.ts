/**
 * Test fakes and builders for the Auth_Service.
 *
 * The service composes several injected ports — the BetterAuth
 * {@link AuthProvider}, a {@link SessionStore}, an {@link IdentityLinkStore}, an
 * {@link MfaEnrollmentStore}, an {@link AuditRecorder}, a {@link TokenGenerator},
 * a {@link TokenHasher}, an {@link AuthIdGenerator}, and an {@link AuthClock}.
 * These in-memory fakes let unit and property tests drive it deterministically
 * and inspect what was persisted and audited — without the BetterAuth framework,
 * a database, a real RNG, or a network:
 *
 *   - {@link FakeAuthProvider} models the BetterAuth seam: it accepts a table of
 *     valid credentials → {@link VerifiedIdentity} and a set of valid MFA codes,
 *     so a test can simulate a correct/incorrect password, OAuth code, SAML
 *     response, and second factor. It NEVER stores a raw password as anything
 *     other than the test's own expectation table.
 *   - {@link InMemorySessionStore} models the session repository: create, lookup
 *     by id and by access/refresh token hash, update, and per-user listing.
 *   - {@link InMemoryIdentityLinkStore} models the SSO association store.
 *   - {@link InMemoryMfaEnrollmentStore} models the MFA factor store (metadata
 *     only — never a secret).
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert which auth effects (sign-in, sign-out, failed auth, MFA) were
 *     audited (Req 33.12, 37.1).
 *   - {@link SequentialTokenGenerator} hands out distinct, reproducible tokens;
 *     {@link FakeTokenHasher} is an injective, non-cryptographic hash for fast
 *     deterministic tests.
 *   - {@link sequentialAuthIdGenerator}, {@link MutableAuthClock},
 *     {@link makeTenant} are small builders with sensible defaults.
 *
 * These are imported directly from `./fakes.js` by the tests (never from the
 * package barrel), matching the established convention.
 *
 * SECURITY: even the fakes never persist a raw token — {@link InMemorySessionStore}
 * stores {@link SessionRecord}s exactly as given, which carry only token hashes —
 * and the MFA store never holds a shared secret.
 */

import type { TenantContext } from '@auxify/types';

import type {
  AuditEvent,
  AuditRecorder,
  AuthClock,
  AuthIdGenerator,
  AuthProvider,
  IdentityLink,
  IdentityLinkStore,
  MfaEnrollment,
  MfaEnrollmentStore,
  MfaFactorRecord,
  MfaFactorType,
  SessionRecord,
  SessionStore,
  TokenGenerator,
  TokenHasher,
  VerifiedIdentity,
} from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which auth effects were audited (Req 33.12, 37.1).
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

  /** Every recorded event with the given action (e.g. `auth.sign_in`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined`. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/** A password credential entry the {@link FakeAuthProvider} accepts. */
export interface FakePasswordCredential {
  email: string;
  password: string;
  identity: VerifiedIdentity;
}

/** An OAuth credential entry the {@link FakeAuthProvider} accepts. */
export interface FakeOAuthCredential {
  provider: string;
  code: string;
  identity: VerifiedIdentity;
}

/** A SAML credential entry the {@link FakeAuthProvider} accepts. */
export interface FakeSamlCredential {
  samlResponse: string;
  identity: VerifiedIdentity;
}

/** Construction options for the {@link FakeAuthProvider}. */
export interface FakeAuthProviderOptions {
  /** The password credentials that verify successfully. */
  passwords?: FakePasswordCredential[];
  /** The OAuth codes that verify successfully. */
  oauth?: FakeOAuthCredential[];
  /** The SAML responses that verify successfully. */
  saml?: FakeSamlCredential[];
  /** The set of `(userId, code)` pairs accepted as valid second factors. */
  validMfaCodes?: { userId: string; code: string }[];
}

/**
 * A deterministic fake of the BetterAuth {@link AuthProvider} seam.
 *
 * It verifies a credential by matching it against the configured expectation
 * tables and returns the associated {@link VerifiedIdentity}, or `null` on any
 * mismatch — exactly the success/failure contract the real adapter offers. MFA
 * enrollment returns canned non-secret provisioning material, and the shared
 * secret is never modelled, mirroring the real adapter's secret ownership.
 */
export class FakeAuthProvider implements AuthProvider {
  private readonly passwords: FakePasswordCredential[];
  private readonly oauth: FakeOAuthCredential[];
  private readonly saml: FakeSamlCredential[];
  private readonly validMfaCodes: { userId: string; code: string }[];

  constructor(options: FakeAuthProviderOptions = {}) {
    this.passwords = options.passwords ?? [];
    this.oauth = options.oauth ?? [];
    this.saml = options.saml ?? [];
    this.validMfaCodes = options.validMfaCodes ?? [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async verifyPassword(email: string, password: string): Promise<VerifiedIdentity | null> {
    const match = this.passwords.find((c) => c.email === email && c.password === password);
    return match === undefined ? null : { ...match.identity, roles: [...match.identity.roles] };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async verifyOAuth(provider: string, code: string): Promise<VerifiedIdentity | null> {
    const match = this.oauth.find((c) => c.provider === provider && c.code === code);
    return match === undefined ? null : { ...match.identity, roles: [...match.identity.roles] };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async verifySaml(samlResponse: string): Promise<VerifiedIdentity | null> {
    const match = this.saml.find((c) => c.samlResponse === samlResponse);
    return match === undefined ? null : { ...match.identity, roles: [...match.identity.roles] };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async verifyMfaCode(userId: string, code: string): Promise<boolean> {
    return this.validMfaCodes.some((c) => c.userId === userId && c.code === code);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async beginMfaEnrollment(userId: string, factor: MfaFactorType): Promise<MfaEnrollment> {
    if (factor === 'totp') {
      return {
        factor,
        provisioningUri: `otpauth://totp/Auxify:${userId}?secret=TESTONLY&issuer=Auxify`,
        manualEntryKey: 'TESTONLY',
      };
    }
    return { factor };
  }
}

function cloneSession(record: SessionRecord): SessionRecord {
  const copy: SessionRecord = {
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
  if (record.deviceId !== undefined) copy.deviceId = record.deviceId;
  if (record.deviceName !== undefined) copy.deviceName = record.deviceName;
  if (record.revokedAt !== undefined) copy.revokedAt = record.revokedAt;
  if (record.accessTokenHash !== undefined) copy.accessTokenHash = record.accessTokenHash;
  if (record.accessTokenExpiresAt !== undefined)
    copy.accessTokenExpiresAt = record.accessTokenExpiresAt;
  if (record.refreshTokenHash !== undefined) copy.refreshTokenHash = record.refreshTokenHash;
  return copy;
}

/**
 * An in-memory {@link SessionStore}.
 *
 * Lookups by access/refresh token hash are tenant-agnostic, modelling the
 * validation/refresh path that precedes a re-established tenant context. The
 * store persists each {@link SessionRecord} exactly as given (carrying only
 * token hashes, never a raw token).
 */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  /** Seed a fully-formed session record (e.g. for a validation/refresh test). */
  seed(record: SessionRecord): void {
    this.records.set(record.id, cloneSession(record));
  }

  /** Snapshot the record currently stored for `id`, or `undefined`. */
  peek(id: string): SessionRecord | undefined {
    const row = this.records.get(id);
    return row === undefined ? undefined : cloneSession(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async create(record: SessionRecord): Promise<SessionRecord> {
    const row = cloneSession(record);
    this.records.set(row.id, row);
    return cloneSession(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findById(id: string): Promise<SessionRecord | null> {
    const row = this.records.get(id);
    return row === undefined ? null : cloneSession(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findByAccessTokenHash(hash: string): Promise<SessionRecord | null> {
    for (const row of this.records.values()) {
      if (row.accessTokenHash === hash) return cloneSession(row);
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findByRefreshTokenHash(hash: string): Promise<SessionRecord | null> {
    for (const row of this.records.values()) {
      if (row.refreshTokenHash === hash) return cloneSession(row);
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async update(record: SessionRecord): Promise<SessionRecord | null> {
    if (!this.records.has(record.id)) return null;
    const row = cloneSession(record);
    this.records.set(row.id, row);
    return cloneSession(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listByUser(userId: string): Promise<SessionRecord[]> {
    return [...this.records.values()]
      .filter((row) => row.userId === userId)
      .map(cloneSession);
  }
}

function cloneLink(link: IdentityLink): IdentityLink {
  return { ...link };
}

/** An in-memory {@link IdentityLinkStore} modelling the SSO association store. */
export class InMemoryIdentityLinkStore implements IdentityLinkStore {
  private readonly links = new Map<string, IdentityLink>();

  /** Seed a fully-formed identity link. */
  seed(link: IdentityLink): void {
    this.links.set(link.id, cloneLink(link));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async insert(ctx: TenantContext, link: IdentityLink): Promise<IdentityLink> {
    const row = cloneLink({ ...link, organizationId: ctx.organizationId });
    this.links.set(row.id, row);
    return cloneLink(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findByProviderAccount(
    provider: string,
    providerAccountId: string,
  ): Promise<IdentityLink | null> {
    for (const row of this.links.values()) {
      if (row.provider === provider && row.providerAccountId === providerAccountId) {
        return cloneLink(row);
      }
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listByUser(ctx: TenantContext, userId: string): Promise<IdentityLink[]> {
    return [...this.links.values()]
      .filter((row) => row.organizationId === ctx.organizationId && row.userId === userId)
      .map(cloneLink);
  }
}

function cloneFactor(record: MfaFactorRecord): MfaFactorRecord {
  const copy: MfaFactorRecord = {
    id: record.id,
    userId: record.userId,
    organizationId: record.organizationId,
    factor: record.factor,
    status: record.status,
    createdAt: record.createdAt,
  };
  if (record.activatedAt !== undefined) copy.activatedAt = record.activatedAt;
  return copy;
}

/**
 * An in-memory {@link MfaEnrollmentStore} modelling the MFA factor repository.
 *
 * SECURITY: stores factor metadata only — never a shared secret.
 */
export class InMemoryMfaEnrollmentStore implements MfaEnrollmentStore {
  private readonly records = new Map<string, MfaFactorRecord>();

  /** Seed a fully-formed factor record. */
  seed(record: MfaFactorRecord): void {
    this.records.set(record.id, cloneFactor(record));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async insert(ctx: TenantContext, record: MfaFactorRecord): Promise<MfaFactorRecord> {
    const row = cloneFactor({ ...record, organizationId: ctx.organizationId });
    this.records.set(row.id, row);
    return cloneFactor(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findById(ctx: TenantContext, id: string): Promise<MfaFactorRecord | null> {
    const row = this.records.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    return cloneFactor(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async update(ctx: TenantContext, record: MfaFactorRecord): Promise<MfaFactorRecord | null> {
    const row = this.records.get(record.id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    const updated = cloneFactor(record);
    this.records.set(updated.id, updated);
    return cloneFactor(updated);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listByUser(ctx: TenantContext, userId: string): Promise<MfaFactorRecord[]> {
    return [...this.records.values()]
      .filter((row) => row.organizationId === ctx.organizationId && row.userId === userId)
      .map(cloneFactor);
  }
}

/**
 * A deterministic {@link TokenGenerator} handing out distinct, reproducible
 * tokens (`token-1`, `token-2`, …) so issued tokens are unique and assertions
 * are stable. NOT cryptographically secure — for tests only.
 */
export class SequentialTokenGenerator implements TokenGenerator {
  private counter: number;

  constructor(seed = 0, private readonly prefix = 'token') {
    this.counter = seed;
  }

  generate(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}

/**
 * An injective, NON-cryptographic {@link TokenHasher} for fast deterministic
 * tests. It prefixes the token so the "hash" is distinct from the raw value,
 * letting tests assert the stored value is not the raw token while keeping
 * equality checks trivial. For tests that need the real digest, inject
 * {@link import('./auth-crypto.js').sha256TokenHasher}.
 */
export class FakeTokenHasher implements TokenHasher {
  hash(rawToken: string): string {
    return `fakehash:${rawToken}`;
  }
}

/**
 * A deterministic {@link AuthIdGenerator} handing out `sess-1`/`idl-1`/`mfa-1`,
 * … for assertion-friendly tests.
 */
export function sequentialAuthIdGenerator(): AuthIdGenerator {
  let sessions = 0;
  let links = 0;
  let factors = 0;
  return {
    sessionId: () => `sess-${(sessions += 1)}`,
    linkId: () => `idl-${(links += 1)}`,
    factorId: () => `mfa-${(factors += 1)}`,
  };
}

/**
 * A hand-advanced {@link AuthClock} for deterministic token/session expiry
 * tests. Construct at a fixed ISO instant; read "now" with {@link MutableAuthClock.now};
 * move forward with {@link MutableAuthClock.advance} (milliseconds) or set it
 * absolutely with {@link MutableAuthClock.setIso}.
 */
export class MutableAuthClock implements AuthClock {
  private current: number;

  constructor(startIso = '2026-01-01T00:00:00.000Z') {
    this.current = Date.parse(startIso);
  }

  now(): Date {
    return new Date(this.current);
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.current += ms;
  }

  /** Advance the clock by `seconds` seconds. */
  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }

  /** Set the clock to an absolute ISO-8601 instant. */
  setIso(iso: string): void {
    this.current = Date.parse(iso);
  }
}

/** Build a {@link TenantContext} with sensible defaults; override field-by-field. */
export function makeTenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    ...overrides,
  };
}

/** Build a {@link VerifiedIdentity} with sensible defaults; override field-by-field. */
export function makeIdentity(overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@example.com',
    roles: ['standard_user'],
    mfaEnabled: false,
    orgMfaRequired: false,
    ...overrides,
  };
}
