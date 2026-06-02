/**
 * Test fakes and builders for the API_Key_Manager.
 *
 * The manager composes several injected ports — a tenant-scoped
 * {@link ApiKeyStore}, an {@link AuditRecorder}, a {@link KeyRandomSource}
 * (CSPRNG), a {@link KeyHasher}, a {@link KeyIdGenerator}, a clock, and an
 * optional {@link ProviderCredentialRotator}. These in-memory fakes let unit and
 * property tests drive it deterministically and inspect what was persisted,
 * audited, and rotated — without a database, a real RNG, or a network:
 *
 *   - {@link InMemoryApiKeyStore} models the tenant-scoped `api_keys`
 *     repository's observable behaviour: Organization scoping (Req 1.2, 1.4),
 *     hash lookup for authentication, activation/revocation, and per-key usage
 *     records for rate-limit counting (Req 21.7).
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert exactly which mutations were audited (Req 37.1).
 *   - {@link SequentialRandomSource} returns deterministic, distinct byte
 *     sequences so generated keys are unique and reproducible in tests — it is
 *     NOT cryptographically secure and is for tests only.
 *   - {@link FakeKeyHasher} is an injective, non-cryptographic hash for fast,
 *     deterministic tests; {@link sha256KeyHasher} (the real hasher) is used
 *     where the actual digest matters.
 *   - {@link CapturingProviderCredentialRotator} records each rotated
 *     Organization (Req 21.6).
 *   - {@link sequentialKeyIdGenerator}, {@link fixedClock}, {@link makeTenant}
 *     are small builders with sensible defaults.
 *
 * These are imported directly from `./fakes.js` by the unit and property tests
 * (never from the package barrel), matching the established convention.
 *
 * SECURITY: even the test fakes never store a raw key — {@link InMemoryApiKeyStore}
 * persists {@link ApiKeyRecord}s exactly as given, which carry only the hash.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type {
  ApiKeyRecord,
  ApiKeyStore,
  KeyHasher,
  KeyIdGenerator,
  KeyRandomSource,
  KeyScope,
  ProviderCredentialRotator,
} from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which key mutations were audited (Req 37.1).
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

  /** Every recorded event with the given action (e.g. `api_key.create`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined`. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

function cloneRecord(record: ApiKeyRecord): ApiKeyRecord {
  const copy: ApiKeyRecord = {
    id: record.id,
    organizationId: record.organizationId,
    ownerId: record.ownerId,
    name: record.name,
    prefix: record.prefix,
    hash: record.hash,
    active: record.active,
    rateLimit: { ...record.rateLimit },
    createdAt: record.createdAt,
  };
  if (record.expiresAt !== undefined) copy.expiresAt = record.expiresAt;
  if (record.revokedAt !== undefined) copy.revokedAt = record.revokedAt;
  if (record.lastUsedAt !== undefined) copy.lastUsedAt = record.lastUsedAt;
  if (record.rotatedFromId !== undefined) copy.rotatedFromId = record.rotatedFromId;
  return copy;
}

/**
 * An in-memory {@link ApiKeyStore} modelling the tenant-scoped `api_keys`
 * repository.
 *
 * Records are confined to their Organization on every tenant-scoped method
 * (Req 1.2, 1.4); {@link findByHash} is intentionally tenant-agnostic, modelling
 * the authentication lookup that precedes a tenant context (Req 21.3). Per-key
 * usage timestamps are retained so {@link countUsagesSince} can drive
 * rate-limit enforcement (Req 21.7). The store never stores a raw key — only the
 * given {@link ApiKeyRecord}, which carries the hash.
 */
export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly records = new Map<string, ApiKeyRecord>();
  private readonly usages = new Map<string, string[]>();

  /** Seed a fully-formed record (e.g. another tenant's key). */
  seed(record: ApiKeyRecord): void {
    this.records.set(record.id, cloneRecord(record));
  }

  /** Seed recorded usage timestamps for a key (for rate-limit tests). */
  seedUsages(keyId: string, timestamps: string[]): void {
    this.usages.set(keyId, [...(this.usages.get(keyId) ?? []), ...timestamps]);
  }

  /** Snapshot the record currently stored for `id`, or `undefined`. */
  peek(id: string): ApiKeyRecord | undefined {
    const row = this.records.get(id);
    return row === undefined ? undefined : cloneRecord(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async insert(ctx: TenantContext, record: ApiKeyRecord): Promise<ApiKeyRecord> {
    const row = cloneRecord({ ...record, organizationId: ctx.organizationId });
    this.records.set(row.id, row);
    return cloneRecord(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findById(ctx: TenantContext, id: string): Promise<ApiKeyRecord | null> {
    const row = this.records.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    return cloneRecord(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async listByScope(ctx: TenantContext, scope?: KeyScope): Promise<ApiKeyRecord[]> {
    return [...this.records.values()]
      .filter((row) => row.organizationId === ctx.organizationId)
      .filter((row) => (scope?.ownerId === undefined ? true : row.ownerId === scope.ownerId))
      .filter((row) => (scope?.activeOnly === true ? row.active : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map(cloneRecord);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async setActive(
    ctx: TenantContext,
    id: string,
    active: boolean,
    revokedAt?: string,
  ): Promise<ApiKeyRecord | null> {
    const row = this.records.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    row.active = active;
    if (!active && revokedAt !== undefined) {
      row.revokedAt = revokedAt;
    }
    if (active) {
      delete row.revokedAt;
    }
    return cloneRecord(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async recordUsage(ctx: TenantContext, id: string, at: string): Promise<ApiKeyRecord | null> {
    const row = this.records.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    const list = this.usages.get(id) ?? [];
    list.push(at);
    this.usages.set(id, list);
    row.lastUsedAt = at;
    return cloneRecord(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async countUsagesSince(ctx: TenantContext, id: string, sinceIso: string): Promise<number> {
    const row = this.records.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return 0;
    const since = new Date(sinceIso).getTime();
    return (this.usages.get(id) ?? []).filter((t) => new Date(t).getTime() >= since).length;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    for (const row of this.records.values()) {
      if (row.hash === hash) return cloneRecord(row);
    }
    return null;
  }
}

/**
 * A deterministic, NON-cryptographic {@link KeyRandomSource} for tests.
 *
 * Each call returns a distinct, reproducible byte sequence derived from an
 * internal counter, so generated keys are unique and assertions are stable.
 * It must never be used outside tests — production uses the CSPRNG-backed
 * {@link import('./key-crypto.js').systemKeyRandomSource}.
 */
export class SequentialRandomSource implements KeyRandomSource {
  private counter: number;

  constructor(seed = 1) {
    this.counter = seed;
  }

  randomBytes(byteLength: number): Uint8Array {
    const out = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i += 1) {
      // A simple, deterministic byte stream that varies per call and position.
      out[i] = (this.counter * 31 + i * 7) % 256;
    }
    this.counter += 1;
    return out;
  }
}

/**
 * An injective, NON-cryptographic {@link KeyHasher} for fast deterministic
 * tests. It prefixes the plaintext so the "hash" is reversible-looking yet
 * distinct from the raw value, letting tests assert that the stored value is not
 * the raw key while keeping equality checks trivial. For tests that need the
 * real digest, inject {@link import('./key-crypto.js').sha256KeyHasher}.
 */
export class FakeKeyHasher implements KeyHasher {
  hash(plaintext: string): string {
    return `fakehash:${plaintext}`;
  }
}

/**
 * A capturing {@link ProviderCredentialRotator} recording each rotated
 * Organization (Req 21.6).
 */
export class CapturingProviderCredentialRotator implements ProviderCredentialRotator {
  /** Every Organization id passed to {@link rotate}, in order. */
  readonly rotated: string[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async rotate(organizationId: string): Promise<void> {
    this.rotated.push(organizationId);
  }
}

/**
 * A deterministic {@link KeyIdGenerator} handing out `key-1`, `key-2`, … for
 * assertion-friendly tests.
 */
export function sequentialKeyIdGenerator(): KeyIdGenerator {
  let counter = 0;
  return { id: () => `key-${(counter += 1)}` };
}

/** A fixed clock returning the same instant on every call (for deterministic tests). */
export function fixedClock(iso = '2026-01-01T00:00:00.000Z'): () => Date {
  return () => new Date(iso);
}

/** Build a {@link TenantContext} with sensible defaults; override field-by-field. */
export function makeTenant(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    ...overrides,
  };
}
