/**
 * Test fakes and builders for the Integration_Service.
 *
 * The service composes its ports — a {@link ConnectorStore}, the shared
 * {@link AuditRecorder}, a {@link SecretStore}, and a {@link ConnectorHealthProber}.
 * These in-memory fakes let unit tests drive the service deterministically and
 * inspect what was persisted, audited, written to the secret store, and probed —
 * without a database, a secret manager, or a network:
 *
 *   - {@link InMemoryConnectorStore} models the tenant-scoped connector
 *     repository: Organization scoping (Req 1.2, 1.4) and the
 *     `(organizationId, type)` upsert key.
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert exactly which enable/disable/credential changes were audited
 *     (Req 37.1).
 *   - {@link InMemorySecretStore} models the platform secret store and lets a
 *     test confirm the raw secret lives ONLY here, keyed by reference, and never
 *     on the connector record (Req 30.5).
 *   - {@link StubConnectorHealthProber} returns a configurable per-type health
 *     outcome and can be told to throw, exercising the graceful-degradation path
 *     (Req 30.3, 30.4).
 *   - {@link makePrincipal} / {@link sequentialIntegrationIdGenerator} /
 *     {@link MutableIntegrationClock} are small builders with sensible defaults.
 *
 * These are imported directly from `./fakes.js` by the unit tests (never from the
 * package barrel), matching the established convention.
 */

import type { Principal, TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type {
  IntegrationClock,
  IntegrationIdGenerator,
} from './integration-service.js';
import {
  connectorKind,
  type ConnectorHealth,
  type ConnectorHealthProber,
  type ConnectorSecret,
  type ConnectorStore,
  type ConnectorType,
  type ConnectorUpsert,
  type CredentialReference,
  type IntegrationConnector,
  type SecretStore,
} from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which management changes were audited (Req 37.1).
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

  /** Every recorded event with the given action (e.g. `integration.connector_enabled`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

function cloneConnector(connector: IntegrationConnector): IntegrationConnector {
  const copy: IntegrationConnector = {
    id: connector.id,
    organizationId: connector.organizationId,
    type: connector.type,
    kind: connector.kind,
    enabled: connector.enabled,
    config: { ...connector.config },
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  };
  if (connector.credentialRef !== undefined) {
    copy.credentialRef = connector.credentialRef;
  }
  return copy;
}

/**
 * An in-memory {@link ConnectorStore} modelling the tenant-scoped connector
 * repository.
 *
 * Rows are confined to their Organization and keyed by `(organizationId, type)`,
 * so {@link upsert} preserves an existing connector's id and `createdAt` while
 * advancing `updatedAt`. A monotonic injected clock makes timestamps strictly
 * increasing so update ordering is observable. The store holds only a credential
 * REFERENCE, never the raw secret (Req 30.5).
 */
export class InMemoryConnectorStore implements ConnectorStore {
  /** Keyed by `${organizationId}:${type}`. */
  private readonly rows = new Map<string, IntegrationConnector>();
  private clock: () => Date;

  /** @param now Injected clock so timestamps are deterministic and strictly increasing. */
  constructor(now: () => Date = monotonicClock()) {
    this.clock = now;
  }

  /** Override the clock. */
  setClock(now: () => Date): void {
    this.clock = now;
  }

  /** Seed a fully-formed connector row (e.g. another tenant's data) for isolation tests. */
  seed(connector: IntegrationConnector): void {
    this.rows.set(this.key(connector.organizationId, connector.type), cloneConnector(connector));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async upsert(ctx: TenantContext, input: ConnectorUpsert): Promise<IntegrationConnector> {
    const key = this.key(ctx.organizationId, input.type);
    const ts = this.clock().toISOString();
    const existing = this.rows.get(key);
    const row: IntegrationConnector = {
      id: existing?.id ?? input.id,
      organizationId: ctx.organizationId,
      type: input.type,
      kind: input.kind,
      enabled: input.enabled,
      config: { ...input.config },
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    if (input.credentialRef !== undefined) {
      row.credentialRef = input.credentialRef;
    }
    this.rows.set(key, row);
    return cloneConnector(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async findByType(ctx: TenantContext, type: ConnectorType): Promise<IntegrationConnector | null> {
    const row = this.rows.get(this.key(ctx.organizationId, type));
    return row !== undefined ? cloneConnector(row) : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async list(ctx: TenantContext): Promise<IntegrationConnector[]> {
    return [...this.rows.values()]
      .filter((r) => r.organizationId === ctx.organizationId)
      .map(cloneConnector);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async setEnabled(
    ctx: TenantContext,
    type: ConnectorType,
    enabled: boolean,
  ): Promise<IntegrationConnector | null> {
    const row = this.rows.get(this.key(ctx.organizationId, type));
    if (row === undefined) return null;
    row.enabled = enabled;
    row.updatedAt = this.clock().toISOString();
    return cloneConnector(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async setCredentialRef(
    ctx: TenantContext,
    type: ConnectorType,
    credentialRef: CredentialReference | null,
  ): Promise<IntegrationConnector | null> {
    const row = this.rows.get(this.key(ctx.organizationId, type));
    if (row === undefined) return null;
    if (credentialRef === null) {
      delete row.credentialRef;
    } else {
      row.credentialRef = credentialRef;
    }
    row.updatedAt = this.clock().toISOString();
    return cloneConnector(row);
  }

  private key(organizationId: string, type: ConnectorType): string {
    return `${organizationId}:${type}`;
  }
}

/** A secret written to the {@link InMemorySecretStore}, with the tenant it was scoped to. */
export interface StoredSecret {
  organizationId: string;
  reference: CredentialReference;
  secret: ConnectorSecret;
}

/**
 * An in-memory {@link SecretStore} so a test can confirm the raw secret lives
 * ONLY here — keyed by `(organizationId, reference)` — and never on the connector
 * record or in an audit event (Req 30.5).
 */
export class InMemorySecretStore implements SecretStore {
  /** Keyed by `${organizationId}:${reference}`. */
  private readonly secrets = new Map<string, StoredSecret>();

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async put(
    ctx: TenantContext,
    reference: CredentialReference,
    secret: ConnectorSecret,
  ): Promise<void> {
    this.secrets.set(this.key(ctx.organizationId, reference), {
      organizationId: ctx.organizationId,
      reference,
      secret: { ...secret },
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async delete(ctx: TenantContext, reference: CredentialReference): Promise<void> {
    this.secrets.delete(this.key(ctx.organizationId, reference));
  }

  /** The raw secret held under a reference within an Organization, or `undefined` (test inspection). */
  get(organizationId: string, reference: CredentialReference): ConnectorSecret | undefined {
    const found = this.secrets.get(this.key(organizationId, reference));
    return found !== undefined ? { ...found.secret } : undefined;
  }

  /** Every stored secret (test inspection). */
  get all(): StoredSecret[] {
    return [...this.secrets.values()].map((s) => ({ ...s, secret: { ...s.secret } }));
  }

  /** The number of secrets currently held (test inspection). */
  get count(): number {
    return this.secrets.size;
  }

  private key(organizationId: string, reference: CredentialReference): string {
    return `${organizationId}:${reference}`;
  }
}

/**
 * A {@link ConnectorHealthProber} returning a configurable per-type health
 * outcome.
 *
 * By default every connector probes healthy. Use {@link setHealth} to mark a
 * specific connector type unavailable, or set {@link throwError} to make every
 * probe reject — exercising the service's defensive degradation, where a thrown
 * probe is reported as `unavailable` rather than propagated (Req 30.3, 30.4).
 * Every probe is captured in {@link probed} for assertions.
 */
export class StubConnectorHealthProber implements ConnectorHealthProber {
  /** Per-type health outcomes; a type with no entry probes healthy by default. */
  private readonly health = new Map<ConnectorType, ConnectorHealth>();
  /** When set, every {@link probe} rejects with this error. */
  throwError: Error | undefined;
  /** Every probed connector type, in order. */
  readonly probed: ConnectorType[] = [];

  constructor(throwError?: Error) {
    this.throwError = throwError;
  }

  /** Set the health outcome a given connector type will report; returns `this` for chaining. */
  setHealth(type: ConnectorType, health: ConnectorHealth): this {
    this.health.set(type, health);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async probe(_ctx: TenantContext, connector: IntegrationConnector): Promise<ConnectorHealth> {
    this.probed.push(connector.type);
    if (this.throwError !== undefined) {
      throw this.throwError;
    }
    return this.health.get(connector.type) ?? { healthy: true, detail: 'reachable' };
  }
}

/** Build a {@link Principal} with sensible defaults; override field-by-field. */
export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    roles: ['admin'],
    teamIds: [],
    projectIds: [],
    allowedModels: [],
    premiumAuthorized: false,
    ...overrides,
  };
}

/**
 * A deterministic {@link IntegrationIdGenerator} handing out `conn-1`, `conn-2`,
 * … connector ids and `ref-1`, `ref-2`, … credential references, for
 * assertion-friendly tests.
 */
export function sequentialIntegrationIdGenerator(): IntegrationIdGenerator {
  let connectorCounter = 0;
  let referenceCounter = 0;
  return {
    connectorId: () => `conn-${(connectorCounter += 1)}`,
    credentialReference: (type) => `ref-${type}-${(referenceCounter += 1)}`,
  };
}

/**
 * A hand-advanceable {@link IntegrationClock} so probe timestamps are
 * deterministic: fix "now" at construction, then {@link advance} it.
 */
export class MutableIntegrationClock implements IntegrationClock {
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
}

/**
 * Build a monotonic clock whose every call returns a strictly-increasing
 * timestamp, so connector `updatedAt` values are observable and ordered.
 */
export function monotonicClock(): () => Date {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
  };
}

/** Build a fully-formed {@link IntegrationConnector} row with sensible defaults (for seeding). */
export function makeConnector(
  overrides: Partial<IntegrationConnector> = {},
): IntegrationConnector {
  const type: ConnectorType = overrides.type ?? 'notion';
  const base: IntegrationConnector = {
    id: overrides.id ?? 'conn-seed',
    organizationId: overrides.organizationId ?? 'org-1',
    type,
    kind: overrides.kind ?? connectorKind(type),
    enabled: overrides.enabled ?? true,
    config: overrides.config ?? {},
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
  if (overrides.credentialRef !== undefined) {
    base.credentialRef = overrides.credentialRef;
  }
  return base;
}
