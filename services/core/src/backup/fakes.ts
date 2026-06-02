/**
 * Test fakes and builders for the Backup_Service (Req 39.1-39.4).
 *
 * The Backup_Service composes its ports — a per-target {@link BackupSource}
 * registry, the shared {@link ObjectStore}, a {@link BackupRecordStore}, the
 * shared {@link AuditRecorder}, and a {@link BackupClock}. These in-memory fakes
 * let unit and property tests drive the service deterministically and inspect
 * what was snapshotted, persisted, audited, and aged out — without a database,
 * an object store, or a network:
 *
 *   - {@link InMemoryBackupSource} models a durable store whose mutable state is
 *     a single byte buffer: {@link InMemoryBackupSource.capture} serializes the
 *     current state and {@link InMemoryBackupSource.restore} replaces it, so a
 *     backup → mutate → restore sequence round-trips (Property 59). Its state is
 *     keyed per Organization, so a capture/restore never crosses a tenant
 *     boundary.
 *   - {@link InMemoryBackupRecordStore} models the tenant-scoped catalog: entries
 *     are confined to their Organization (Req 1.4).
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert exactly which backup actions were audited (Req 39.2).
 *   - {@link MutableBackupClock} is a hand-advanceable clock so retention is
 *     fully testable: fix "now", then advance it across a backup's retention
 *     deadline.
 *   - {@link makeTenantContext} / {@link makeBytes} /
 *     {@link sequentialBackupIdGenerator} are small builders with sensible
 *     defaults.
 *
 * These are imported directly from `./fakes.js` by the unit and property tests
 * (never from the package barrel), matching the established convention.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import { InMemoryObjectStore } from '../storage/index.js';
import type { BackupIdGenerator } from './backup-service.js';
import type {
  BackupClock,
  BackupRecord,
  BackupRecordStore,
  BackupSource,
  BackupTargetKind,
} from './types.js';

/** Re-export the shared in-memory Object_Store as the test byte backend. */
export { InMemoryObjectStore };

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  /** The tenant context the event was scoped to. */
  ctx: TenantContext;
  /** The recorded event. */
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which backup actions were audited (Req 39.2).
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

  /** Every recorded event with the given action (e.g. `backup.capture`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/**
 * A hand-advanceable {@link BackupClock}, so retention is fully testable: fix
 * "now" at construction, then {@link advance} it across a backup's retention
 * deadline (or {@link set} an absolute instant).
 */
export class MutableBackupClock implements BackupClock {
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

/**
 * An in-memory {@link BackupSource} modelling a durable store whose mutable
 * state is a single byte buffer, keyed per Organization.
 *
 * {@link capture} returns a copy of the Organization's current state and
 * {@link restore} replaces it with a copy of the supplied snapshot, so a
 * backup → mutate → restore sequence round-trips exactly (Property 59). State is
 * confined to its Organization, so a capture/restore never crosses a tenant
 * boundary (Req 1.4).
 */
export class InMemoryBackupSource implements BackupSource {
  private readonly state = new Map<string, Uint8Array>();

  /** Seed (or overwrite) an Organization's current state (test setup). */
  setState(ctx: TenantContext, bytes: Uint8Array): void {
    this.state.set(ctx.organizationId, Uint8Array.from(bytes));
  }

  /** Read an Organization's current state (test inspection). */
  getState(ctx: TenantContext): Uint8Array {
    return Uint8Array.from(this.state.get(ctx.organizationId) ?? new Uint8Array());
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async capture(ctx: TenantContext): Promise<Uint8Array> {
    return Uint8Array.from(this.state.get(ctx.organizationId) ?? new Uint8Array());
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async restore(ctx: TenantContext, snapshot: Uint8Array): Promise<void> {
    this.state.set(ctx.organizationId, Uint8Array.from(snapshot));
  }
}

function cloneRecord(record: BackupRecord): BackupRecord {
  return { ...record };
}

/**
 * An in-memory {@link BackupRecordStore} modelling the tenant-scoped backup
 * catalog.
 *
 * Entries are confined to their Organization (Req 1.4): a `findById` / `remove`
 * for an id owned by another Organization resolves to `null`, and `list` only
 * ever returns the caller's Organization's backups (optionally for one target).
 */
export class InMemoryBackupRecordStore implements BackupRecordStore {
  private readonly records = new Map<string, BackupRecord>();

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async put(ctx: TenantContext, record: BackupRecord): Promise<void> {
    this.records.set(this.key(ctx.organizationId, record.id), cloneRecord(record));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findById(ctx: TenantContext, id: string): Promise<BackupRecord | null> {
    const found = this.records.get(this.key(ctx.organizationId, id));
    return found !== undefined ? cloneRecord(found) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async list(ctx: TenantContext, target?: BackupTargetKind): Promise<BackupRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.organizationId === ctx.organizationId)
      .filter((r) => (target === undefined ? true : r.target === target))
      .map(cloneRecord);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async remove(ctx: TenantContext, id: string): Promise<BackupRecord | null> {
    const mapKey = this.key(ctx.organizationId, id);
    const found = this.records.get(mapKey);
    if (found === undefined) {
      return null;
    }
    this.records.delete(mapKey);
    return cloneRecord(found);
  }

  /** The number of catalog entries across every Organization (test inspection). */
  get count(): number {
    return this.records.size;
  }

  private key(organizationId: string, id: string): string {
    return `${organizationId}\u0000${id}`;
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

/** Build a deterministic byte payload of `text` (UTF-8 encoded). */
export function makeBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * A deterministic {@link BackupIdGenerator} handing out `backup-1`, `backup-2`,
 * … ids, for assertion-friendly tests.
 */
export function sequentialBackupIdGenerator(): BackupIdGenerator {
  let counter = 0;
  return {
    backupId: () => `backup-${(counter += 1)}`,
  };
}
