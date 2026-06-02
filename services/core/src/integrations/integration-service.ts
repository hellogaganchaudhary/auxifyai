/**
 * The Integration_Service (Req 30.1-30.5).
 *
 * The service that manages an Organization's OPTIONAL external interoperability:
 * the supported first-class integrations GitHub, email, and enterprise identity
 * providers (Req 30.1) and the optional interoperability connectors Notion,
 * Slack, Confluence, SharePoint, and Google Drive (Req 30.2). It is built around
 * one guarantee — these integrations are NEVER required for the platform's
 * native operation (Req 30.3): {@link IntegrationService.isAvailable} answers an
 * "is connector X available for this Organization" query that degrades
 * gracefully, reporting `unavailable` (never throwing) when a connector is
 * disabled, unregistered, or unhealthy so a native caller (chat, knowledge,
 * messaging, documents, search) can branch and proceed uninterrupted (Req 30.4).
 *
 * It composes only narrow injected ports so it is pure orchestration and fully
 * unit-testable without a database, a secret manager, or a network:
 *
 *   - a tenant-scoped {@link ConnectorStore} (the connector repository) — every
 *     operation is automatically confined to the caller's Organization
 *     (Req 1.2, 1.4);
 *   - the shared {@link AuditRecorder} — every enable/disable/credentials change
 *     is recorded in the immutable audit trail (Req 37.1);
 *   - the platform {@link SecretStore} — raw connector credentials are written
 *     here under a generated {@link CredentialReference}; only the reference is
 *     stored on the connector record (Req 30.5); and
 *   - an injectable {@link ConnectorHealthProber} — consulted (defensively) to
 *     classify an enabled connector's availability (Req 30.4).
 *
 * SECURITY (Req 30.5): {@link storeCredentials} writes the raw secret to the
 * {@link SecretStore} and persists ONLY the opaque reference on the connector;
 * the secret never enters a connector record, an audit event, a log line, or a
 * status projection. Audit metadata records `hasCredentials: true` and the
 * reference handle — never the secret value.
 *
 * Responsibilities mapped to acceptance criteria:
 *   - {@link enableConnector} — register/enable a connector with its non-secret
 *     config and an optional credential reference, audited (Req 30.1, 30.2);
 *   - {@link disableConnector} — turn a connector off while continuing native
 *     operation, audited (Req 30.3, 30.4);
 *   - {@link storeCredentials} — write raw credentials to the secret store by
 *     reference, excluded from logs/UI, audited (Req 30.5);
 *   - {@link listStatus} — report each connector's enable/availability/health
 *     status (Req 30.4);
 *   - {@link isAvailable} — the graceful "available?" query that never throws
 *     (Req 30.3, 30.4).
 */

import { randomUUID } from 'node:crypto';

import { tenantContextFromPrincipal, type Principal, type TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import { ConnectorNotEnabledError, UnknownConnectorTypeError } from './errors.js';
import {
  connectorKind,
  isConnectorType,
  type ConnectorAvailability,
  type ConnectorAvailabilityResult,
  type ConnectorHealth,
  type ConnectorHealthProber,
  type ConnectorSecret,
  type ConnectorStatus,
  type ConnectorStore,
  type ConnectorType,
  type CredentialReference,
  type EnableConnectorInput,
  type IntegrationConnector,
  type SecretStore,
} from './types.js';

/** Generates unique ids for connector records and credential references (injectable for tests). */
export interface IntegrationIdGenerator {
  /** A unique connector-record id. */
  connectorId(): string;
  /** A unique, non-secret credential-reference handle held in the {@link SecretStore} (Req 30.5). */
  credentialReference(type: ConnectorType): CredentialReference;
}

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: IntegrationIdGenerator = {
  connectorId: () => randomUUID(),
  credentialReference: (type) => `secret:connector:${type}:${randomUUID()}`,
};

/** The clock the service reads for record timestamps and probe times (injectable for tests). */
export interface IntegrationClock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link IntegrationClock}, backed by the global `Date.now`. */
export const systemIntegrationClock: IntegrationClock = { now: () => Date.now() };

/** Construction dependencies for the {@link IntegrationService}. */
export interface IntegrationServiceOptions {
  /** The tenant-scoped connector repository (Req 1.2, 1.4). */
  connectors: ConnectorStore;
  /** The append-only audit sink; every management change is recorded (Req 37.1). */
  audit: AuditRecorder;
  /** The platform secret store holding connector credentials by reference (Req 30.5). */
  secrets: SecretStore;
  /** The connector health prober used to classify availability (Req 30.4). */
  healthProber: ConnectorHealthProber;
  /** Optional id generator (defaults to `crypto.randomUUID`-backed). */
  idGenerator?: IntegrationIdGenerator;
  /** Optional clock (defaults to {@link systemIntegrationClock}). */
  clock?: IntegrationClock;
}

/**
 * The Integration_Service. Construct once with its ports, then call its methods
 * with the acting {@link Principal} (which carries the Organization scope and the
 * default actor for auditing).
 */
export class IntegrationService {
  private readonly connectors: ConnectorStore;
  private readonly audit: AuditRecorder;
  private readonly secrets: SecretStore;
  private readonly healthProber: ConnectorHealthProber;
  private readonly ids: IntegrationIdGenerator;
  private readonly clock: IntegrationClock;

  constructor(options: IntegrationServiceOptions) {
    this.connectors = options.connectors;
    this.audit = options.audit;
    this.secrets = options.secrets;
    this.healthProber = options.healthProber;
    this.ids = options.idGenerator ?? defaultIdGenerator;
    this.clock = options.clock ?? systemIntegrationClock;
  }

  /**
   * Enable (register) an optional connector or supported integration for the
   * Organization (Req 30.1, 30.2).
   *
   * Records the connector's non-secret configuration and, when supplied, an
   * existing credential REFERENCE (never a raw secret — Req 30.5); attach raw
   * credentials with {@link storeCredentials} instead. Enabling is idempotent on
   * `(organizationId, type)`: re-enabling an existing connector flips it on and
   * merges the supplied config. The change is recorded in the Audit_Service.
   *
   * @throws {UnknownConnectorTypeError} when `input.type` is not a supported connector.
   */
  async enableConnector(
    principal: Principal,
    input: EnableConnectorInput,
  ): Promise<IntegrationConnector> {
    const ctx = this.contextFor(principal);
    this.requireKnownType(input.type);

    const existing = await this.connectors.findByType(ctx, input.type);
    const mergedConfig = {
      ...(existing?.config ?? {}),
      ...(input.config ?? {}),
    };
    const credentialRef = input.credentialRef ?? existing?.credentialRef;

    const connector = await this.connectors.upsert(ctx, {
      id: existing?.id ?? input.id ?? this.ids.connectorId(),
      type: input.type,
      kind: connectorKind(input.type),
      enabled: true,
      config: mergedConfig,
      ...(credentialRef !== undefined ? { credentialRef } : {}),
    });

    await this.audit.record(ctx, {
      action: 'integration.connector_enabled',
      resourceType: 'organization',
      resourceId: connector.organizationId,
      actorId: principal.userId,
      metadata: {
        connectorType: connector.type,
        connectorKind: connector.kind,
        hasCredentials: connector.credentialRef !== undefined,
      },
    });
    return connector;
  }

  /**
   * Disable a connector for the Organization (Req 30.3, 30.4).
   *
   * Turning a connector off never affects native operation — the platform's
   * chat, knowledge, messaging, document, and search modules continue
   * uninterrupted (Req 30.3). The credential reference is retained so the
   * connector can be re-enabled without re-supplying credentials; call
   * {@link storeCredentials} to rotate them. The change is audited.
   *
   * @throws {UnknownConnectorTypeError} when `type` is not a supported connector.
   * @throws {ConnectorNotEnabledError} when the Organization has no such connector.
   */
  async disableConnector(principal: Principal, type: ConnectorType): Promise<IntegrationConnector> {
    const ctx = this.contextFor(principal);
    this.requireKnownType(type);

    const updated = await this.connectors.setEnabled(ctx, type, false);
    if (updated === null) {
      throw new ConnectorNotEnabledError(type);
    }
    await this.audit.record(ctx, {
      action: 'integration.connector_disabled',
      resourceType: 'organization',
      resourceId: updated.organizationId,
      actorId: principal.userId,
      metadata: { connectorType: updated.type, connectorKind: updated.kind },
    });
    return updated;
  }

  /**
   * Configure a connector's credentials by writing the raw secret to the platform
   * {@link SecretStore} and storing ONLY a non-secret reference on the connector
   * record (Req 30.5).
   *
   * The raw secret is excluded from the connector record, every audit event, and
   * every status projection — the audit event records only that credentials were
   * configured (`hasCredentials: true`) and the reference handle. A prior
   * credential reference, if any, is removed from the secret store so a rotation
   * leaves no orphaned secret. The connector must already be registered (enable
   * it first).
   *
   * @throws {UnknownConnectorTypeError} when `type` is not a supported connector.
   * @throws {ConnectorNotEnabledError} when the Organization has no such connector.
   */
  async storeCredentials(
    principal: Principal,
    type: ConnectorType,
    secret: ConnectorSecret,
  ): Promise<IntegrationConnector> {
    const ctx = this.contextFor(principal);
    this.requireKnownType(type);

    const existing = await this.connectors.findByType(ctx, type);
    if (existing === null) {
      throw new ConnectorNotEnabledError(type);
    }

    const reference = this.ids.credentialReference(type);
    // Write the raw secret to the secret store under the new reference (Req 30.5).
    await this.secrets.put(ctx, reference, secret);
    // Persist ONLY the reference on the connector record — never the secret.
    const updated = await this.connectors.setCredentialRef(ctx, type, reference);
    if (updated === null) {
      // Existed a moment ago; a null here means it left the tenant scope. Fail closed.
      await this.secrets.delete(ctx, reference);
      throw new ConnectorNotEnabledError(type);
    }
    // Clean up any superseded secret so a rotation leaves no orphaned material.
    if (existing.credentialRef !== undefined && existing.credentialRef !== reference) {
      await this.secrets.delete(ctx, existing.credentialRef);
    }

    await this.audit.record(ctx, {
      action: 'integration.credentials_configured',
      resourceType: 'organization',
      resourceId: updated.organizationId,
      actorId: principal.userId,
      // SECURITY: never record the secret value (Req 30.5) — only that it was set.
      metadata: { connectorType: updated.type, hasCredentials: true },
    });
    return updated;
  }

  /** Fetch the Organization's connector of a given type, or `null` when none is registered. */
  async getConnector(
    principal: Principal,
    type: ConnectorType,
  ): Promise<IntegrationConnector | null> {
    const ctx = this.contextFor(principal);
    if (!isConnectorType(type)) {
      return null;
    }
    return this.connectors.findByType(ctx, type);
  }

  /**
   * Report the status of every connector registered for the Organization
   * (Req 30.4).
   *
   * For each connector, a disabled one is reported as `disabled` without a health
   * probe; an enabled one is probed (defensively — a thrown probe is treated as
   * `unavailable`) and reported `available`/`unavailable`. The projection exposes
   * only a boolean {@link ConnectorStatus.hasCredentials}, never the secret
   * (Req 30.5).
   */
  async listStatus(principal: Principal): Promise<ConnectorStatus[]> {
    const ctx = this.contextFor(principal);
    const connectors = await this.connectors.list(ctx);
    return Promise.all(connectors.map((connector) => this.statusFor(ctx, connector)));
  }

  /**
   * Answer "is connector X available for this Organization?" — the graceful
   * degradation query at the heart of Req 30.3/30.4.
   *
   * NEVER throws: an unknown type, an unregistered or disabled connector, or a
   * failing/throwing health probe all resolve to `available: false` with a
   * classified {@link ConnectorAvailability}, so a native caller can branch on
   * the result and continue operating uninterrupted whether or not the connector
   * is reachable.
   */
  async isAvailable(
    principal: Principal,
    type: ConnectorType,
  ): Promise<ConnectorAvailabilityResult> {
    const ctx = this.contextFor(principal);
    if (!isConnectorType(type)) {
      return {
        type,
        available: false,
        availability: 'disabled',
        detail: 'unknown connector type',
      };
    }

    const connector = await this.connectors.findByType(ctx, type).catch(() => null);
    if (connector === null || !connector.enabled) {
      return {
        type,
        available: false,
        availability: 'disabled',
        detail: connector === null ? 'connector not registered' : 'connector disabled',
      };
    }

    const health = await this.safeProbe(ctx, connector);
    const availability: ConnectorAvailability = health.healthy ? 'available' : 'unavailable';
    const result: ConnectorAvailabilityResult = {
      type,
      available: health.healthy,
      availability,
    };
    if (health.detail !== undefined) {
      result.detail = health.detail;
    }
    return result;
  }

  // --- internals ---------------------------------------------------------

  /** Build the tenant context for the principal (Organization scope + default actor). */
  private contextFor(principal: Principal): TenantContext {
    return tenantContextFromPrincipal(principal);
  }

  /** Reject an unsupported connector type on the management path (Req 30.1, 30.2). */
  private requireKnownType(type: string): asserts type is ConnectorType {
    if (!isConnectorType(type)) {
      throw new UnknownConnectorTypeError(type);
    }
  }

  /** Build the {@link ConnectorStatus} projection for a connector (Req 30.4, 30.5). */
  private async statusFor(
    ctx: TenantContext,
    connector: IntegrationConnector,
  ): Promise<ConnectorStatus> {
    const hasCredentials = connector.credentialRef !== undefined;
    if (!connector.enabled) {
      return {
        type: connector.type,
        kind: connector.kind,
        enabled: false,
        availability: 'disabled',
        hasCredentials,
      };
    }
    const health = await this.safeProbe(ctx, connector);
    const status: ConnectorStatus = {
      type: connector.type,
      kind: connector.kind,
      enabled: true,
      availability: health.healthy ? 'available' : 'unavailable',
      hasCredentials,
    };
    if (health.detail !== undefined) {
      status.detail = health.detail;
    }
    if (health.checkedAt !== undefined) {
      status.checkedAt = health.checkedAt;
    }
    return status;
  }

  /**
   * Probe a connector defensively (Req 30.4): a rejected or malformed probe is
   * caught and reported as unhealthy with a secret-free detail, so a misbehaving
   * prober can never interrupt native operation (Req 30.3).
   */
  private async safeProbe(
    ctx: TenantContext,
    connector: IntegrationConnector,
  ): Promise<ConnectorHealth> {
    const checkedAt = new Date(this.clock.now()).toISOString();
    try {
      const health = await this.healthProber.probe(ctx, connector);
      return {
        healthy: health.healthy === true,
        ...(health.detail !== undefined ? { detail: health.detail } : {}),
        checkedAt: health.checkedAt ?? checkedAt,
      };
    } catch (error) {
      // Graceful degradation: an unavailable connector is reported, never thrown.
      const detail = error instanceof Error ? error.message : 'health probe failed';
      return { healthy: false, detail, checkedAt };
    }
  }
}
