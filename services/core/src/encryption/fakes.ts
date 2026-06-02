/**
 * Test fakes and builders for the encryption + secret-storage module
 * (Req 34.7, 35.1, 35.3, 35.5).
 *
 * The {@link import('./encrypted-secret-store.js').EncryptedSecretStore}
 * composes its ports — a {@link KeyProvider} (the KMS / Key-Vault seam), a
 * {@link SecretBackend} (the Secrets-Manager / Key-Vault seam), an optional
 * {@link ResidencyResolver}, and an {@link EncryptionClock}. These in-memory
 * fakes let unit tests drive the store deterministically — exercising
 * encryption round-trips, key rotation, tenant scoping, and residency pinning —
 * without a cloud KMS, a secret manager, or a network:
 *
 *   - {@link InMemoryKeyProvider} holds one or more {@link DataKey}s with a
 *     designated active key, supports {@link InMemoryKeyProvider.addKey} /
 *     {@link InMemoryKeyProvider.rotateTo} to add a rotated key and switch the
 *     active one, and resolves a key by id — throwing
 *     {@link UnknownEncryptionKeyError} for an id it does not hold (Req 35.1).
 *   - {@link InMemorySecretBackend} is a tenant-scoped Map keyed by
 *     `${organizationId}::${reference}` that only ever holds ciphertext
 *     envelopes, enforcing tenant scoping like the sibling fakes (Req 1.4, 34.7).
 *   - {@link FixedResidencyResolver} returns a configured region (or none) so
 *     residency pinning is testable (Req 35.5).
 *   - {@link MutableEncryptionClock} is a hand-advanceable clock so record
 *     timestamps are deterministic.
 *   - {@link makeTenantContext} / {@link makeDataKey} are small builders with
 *     sensible defaults.
 *
 * These are imported directly from `./fakes.js` by the tests (never from the
 * package barrel), matching the established convention.
 */

import { randomBytes } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import { UnknownEncryptionKeyError } from './errors.js';
import {
  DATA_KEY_BYTES,
  type DataKey,
  type EncryptionClock,
  type KeyProvider,
  type ResidencyResolver,
  type SecretBackend,
  type SecretReference,
  type StoredSecretRecord,
} from './types.js';

/**
 * Build a {@link DataKey} with the given id and either supplied material or a
 * fresh random {@link DATA_KEY_BYTES}-byte key.
 *
 * @param keyId The key's stable id.
 * @param material Optional explicit key bytes (must be {@link DATA_KEY_BYTES}); a
 *   fresh random key is generated when omitted.
 */
export function makeDataKey(keyId: string, material?: Uint8Array): DataKey {
  return {
    keyId,
    material: material !== undefined ? Uint8Array.from(material) : Uint8Array.from(randomBytes(DATA_KEY_BYTES)),
  };
}

/**
 * An in-memory {@link KeyProvider} holding one or more {@link DataKey}s with a
 * designated active key (Req 35.1).
 *
 * New encryptions draw {@link activeKey}; decryptions resolve {@link keyById}.
 * A rotation is modelled by {@link addKey} (register a new key) and
 * {@link rotateTo} (make a registered key the active one), so a value encrypted
 * under the old active key still decrypts after the active key changes — and an
 * id the provider does not hold fails closed with {@link UnknownEncryptionKeyError}.
 */
export class InMemoryKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, DataKey>();
  private activeKeyId: string;

  /**
   * @param active The initial active key. When omitted, a single random key with
   *   id `key-1` is created and made active.
   * @param extra Additional keys to pre-register (e.g. retired keys).
   */
  constructor(active?: DataKey, extra: DataKey[] = []) {
    const initial = active ?? makeDataKey('key-1');
    this.register(initial);
    for (const key of extra) {
      this.register(key);
    }
    this.activeKeyId = initial.keyId;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async activeKey(): Promise<DataKey> {
    return this.cloneKey(this.mustGet(this.activeKeyId));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async keyById(keyId: string): Promise<DataKey> {
    const found = this.keys.get(keyId);
    if (found === undefined) {
      throw new UnknownEncryptionKeyError(keyId);
    }
    return this.cloneKey(found);
  }

  /**
   * Register an additional data key (does not change which key is active).
   *
   * @param key The key to register; a fresh random key is created from an id-only
   *   call via {@link makeDataKey} at the call site.
   * @returns The registered key.
   */
  addKey(key: DataKey): DataKey {
    this.register(key);
    return this.cloneKey(key);
  }

  /**
   * Make a registered key the active key (the rotation step), registering it
   * first when a full {@link DataKey} is supplied.
   *
   * @param key The key id to activate, or a {@link DataKey} to register-and-activate.
   * @returns The now-active key.
   */
  rotateTo(key: string | DataKey): DataKey {
    if (typeof key === 'string') {
      this.mustGet(key);
      this.activeKeyId = key;
    } else {
      this.register(key);
      this.activeKeyId = key.keyId;
    }
    return this.cloneKey(this.mustGet(this.activeKeyId));
  }

  /** The id of the currently active key (test inspection). */
  get activeId(): string {
    return this.activeKeyId;
  }

  private register(key: DataKey): void {
    this.keys.set(key.keyId, this.cloneKey(key));
  }

  private mustGet(keyId: string): DataKey {
    const found = this.keys.get(keyId);
    if (found === undefined) {
      throw new UnknownEncryptionKeyError(keyId);
    }
    return found;
  }

  private cloneKey(key: DataKey): DataKey {
    return { keyId: key.keyId, material: Uint8Array.from(key.material) };
  }
}

/**
 * An in-memory {@link SecretBackend} modelling the tenant-scoped secret store
 * (Req 34.7, 1.4).
 *
 * Records are confined to their Organization via a Map keyed by
 * `${organizationId}::${reference}`, so one Organization can never read, write,
 * or delete another's secret. The backend only ever holds the serialized
 * ciphertext envelope — it never sees a plaintext secret or any key material.
 */
export class InMemorySecretBackend implements SecretBackend {
  private readonly records = new Map<string, StoredSecretRecord>();

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async put(ctx: TenantContext, record: StoredSecretRecord): Promise<void> {
    this.records.set(this.key(ctx.organizationId, record.reference), { ...record });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async get(ctx: TenantContext, reference: SecretReference): Promise<StoredSecretRecord | null> {
    const found = this.records.get(this.key(ctx.organizationId, reference));
    return found !== undefined ? { ...found } : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async delete(ctx: TenantContext, reference: SecretReference): Promise<void> {
    this.records.delete(this.key(ctx.organizationId, reference));
  }

  /** The raw stored record under a reference within an Organization, or `undefined` (test inspection). */
  peek(organizationId: string, reference: SecretReference): StoredSecretRecord | undefined {
    const found = this.records.get(this.key(organizationId, reference));
    return found !== undefined ? { ...found } : undefined;
  }

  /** Every stored record across every Organization (test inspection). */
  get all(): StoredSecretRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /** The number of stored records across every Organization (test inspection). */
  get count(): number {
    return this.records.size;
  }

  private key(organizationId: string, reference: SecretReference): string {
    return `${organizationId}::${reference}`;
  }
}

/**
 * A {@link ResidencyResolver} that returns a fixed region for every context (or
 * `undefined` for "no residency constraint"), so residency pinning is testable
 * (Req 35.5).
 */
export class FixedResidencyResolver implements ResidencyResolver {
  private region: string | undefined;

  /** @param region The region to return for every context, or `undefined` for unconstrained. */
  constructor(region?: string) {
    this.region = region;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async regionFor(_ctx: TenantContext): Promise<string | undefined> {
    return this.region;
  }

  /** Change the region the resolver reports (test setup). */
  setRegion(region: string | undefined): void {
    this.region = region;
  }
}

/**
 * A hand-advanceable {@link EncryptionClock} so record timestamps are
 * deterministic: fix "now" at construction, then {@link advance} it (or
 * {@link set} an absolute instant).
 */
export class MutableEncryptionClock implements EncryptionClock {
  private current: number;

  /** @param startMs The initial "now" in epoch milliseconds (default 2026-01-01T00:00:00Z). */
  constructor(startMs: number = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.current = startMs;
  }

  /** The current time in milliseconds since the Unix epoch. */
  now(): number {
    return this.current;
  }

  /** Advance the clock by `deltaMs` milliseconds. */
  advance(deltaMs: number): void {
    this.current += deltaMs;
  }

  /** Set the clock to an absolute epoch-millisecond instant. */
  set(absoluteMs: number): void {
    this.current = absoluteMs;
  }
}

/** Build a {@link TenantContext} with sensible defaults; override field-by-field. */
export function makeTenantContext(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    ...overrides,
  };
}
