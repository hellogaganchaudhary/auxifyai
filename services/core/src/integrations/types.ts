/**
 * Integration_Service domain types and injectable ports (Req 30.1-30.5).
 *
 * The Integration_Service manages an Organization's OPTIONAL external
 * interoperability — the supported first-class integrations GitHub, email, and
 * enterprise identity providers (Req 30.1) and the optional interoperability
 * connectors Notion, Slack, Confluence, SharePoint, and Google Drive (Req 30.2).
 * It registers (enables) a connector with its non-secret configuration and a
 * credential REFERENCE, disables it, reports each connector's enable/health
 * status (Req 30.4), and answers an "is connector X available for this
 * Organization" query that fails gracefully — returning `unavailable` rather
 * than throwing so the platform's native modules (chat, knowledge, messaging,
 * documents, search) keep operating uninterrupted whether or not any connector
 * is reachable (Req 30.3, 30.4).
 *
 * SECURITY (Req 30.5): a connector holds third-party credentials. The stored
 * {@link IntegrationConnector} record carries only a {@link CredentialReference}
 * (an opaque, non-secret handle) — never the raw secret material. The raw secret
 * is written to the platform {@link SecretStore} under that reference and
 * resolved at use-time; it is excluded from every persisted record, audit event,
 * and status projection. The reported {@link ConnectorStatus} exposes only a
 * boolean `hasCredentials`, never the secret.
 *
 * These are the camelCase domain shapes the service returns to its callers. The
 * service composes only the narrow ports declared here — a tenant-scoped
 * {@link ConnectorStore}, the shared
 * {@link import('../audit/index.js').AuditRecorder}, an injectable
 * {@link ConnectorHealthProber}, and the platform {@link SecretStore} — so it is
 * pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`.
 *
 * Tenancy: every connector carries its `organizationId`; the
 * {@link ConnectorStore} requires a {@link TenantContext} on every method and
 * confines the operation to the caller's Organization (Req 1.2, 1.4), so a
 * connector enabled by one Organization is never visible to another.
 */

import type { Principal, TenantContext } from '@auxify/types';

/**
 * The supported first-class integrations every deployment ships (Req 30.1).
 *
 * GitHub, email, and an enterprise identity provider are supported integrations
 * the platform offers directly; like the optional connectors they are never
 * required for the platform's native operation (Req 30.3).
 */
export type SupportedIntegrationType = 'github' | 'email' | 'idp';

/** All {@link SupportedIntegrationType} values, for iteration, validation, and tests. */
export const SUPPORTED_INTEGRATION_TYPES: readonly SupportedIntegrationType[] = [
  'github',
  'email',
  'idp',
] as const;

/**
 * The optional interoperability connectors an Organization may enable (Req 30.2).
 *
 * These connect to external products and are deliberately optional: when one is
 * unavailable the platform keeps serving its native modules without interruption
 * (Req 30.3, 30.4). They are never required for platform operation.
 */
export type OptionalConnectorType =
  | 'notion'
  | 'slack'
  | 'confluence'
  | 'sharepoint'
  | 'google_drive';

/** All {@link OptionalConnectorType} values, for iteration, validation, and tests. */
export const OPTIONAL_CONNECTOR_TYPES: readonly OptionalConnectorType[] = [
  'notion',
  'slack',
  'confluence',
  'sharepoint',
  'google_drive',
] as const;

/** Any external integration the Integration_Service manages (Req 30.1, 30.2). */
export type ConnectorType = SupportedIntegrationType | OptionalConnectorType;

/** All {@link ConnectorType} values, for iteration, validation, and test generators. */
export const CONNECTOR_TYPES: readonly ConnectorType[] = [
  ...SUPPORTED_INTEGRATION_TYPES,
  ...OPTIONAL_CONNECTOR_TYPES,
] as const;

/**
 * Whether a connector is a supported first-class integration (Req 30.1) or an
 * optional interoperability connector (Req 30.2). Both are optional for native
 * operation (Req 30.3); the distinction is reported in {@link ConnectorStatus}.
 */
export type ConnectorKind = 'supported_integration' | 'optional_connector';

/** True iff `type` is a known {@link ConnectorType} (defensive runtime guard for untyped input). */
export function isConnectorType(type: string): type is ConnectorType {
  return (CONNECTOR_TYPES as readonly string[]).includes(type);
}

/** True iff `type` is one of the optional interoperability connectors (Req 30.2). */
export function isOptionalConnectorType(type: ConnectorType): type is OptionalConnectorType {
  return (OPTIONAL_CONNECTOR_TYPES as readonly string[]).includes(type);
}

/** The {@link ConnectorKind} a {@link ConnectorType} belongs to. */
export function connectorKind(type: ConnectorType): ConnectorKind {
  return (SUPPORTED_INTEGRATION_TYPES as readonly string[]).includes(type)
    ? 'supported_integration'
    : 'optional_connector';
}

/**
 * The reported availability of a connector (Req 30.4).
 *
 * - `disabled` — the connector is not enabled for the Organization; no health
 *   probe is performed.
 * - `available` — the connector is enabled and its most recent health probe
 *   reported healthy.
 * - `unavailable` — the connector is enabled but its health probe reported
 *   unhealthy, was unreachable, or could not be performed. This is the
 *   gracefully-degraded outcome: it is reported, never thrown, so native
 *   operation continues uninterrupted (Req 30.3, 30.4).
 */
export type ConnectorAvailability = 'available' | 'unavailable' | 'disabled';

/** All {@link ConnectorAvailability} values, for iteration and test generators. */
export const CONNECTOR_AVAILABILITIES: readonly ConnectorAvailability[] = [
  'available',
  'unavailable',
  'disabled',
] as const;

/**
 * An opaque, NON-SECRET handle to a connector's credentials held in the platform
 * {@link SecretStore} (Req 30.5).
 *
 * The {@link IntegrationConnector} record stores only this reference; the raw
 * secret material lives in the secret store under it and is resolved at use-time.
 * A reference is safe to persist, audit, and surface in a status projection — it
 * is not itself a secret.
 */
export type CredentialReference = string;

/**
 * Raw third-party credential material supplied to
 * {@link import('./integration-service.js').IntegrationService.storeCredentials}
 * (Req 30.5).
 *
 * Modelled as a bag of named secret fields (for example `token`, `clientId`,
 * `clientSecret`) so a connector can carry whatever its product needs. This
 * value is written to the {@link SecretStore} and is NEVER persisted in the
 * connector record, recorded in an audit event, echoed in a log, or returned in
 * a {@link ConnectorStatus}.
 */
export type ConnectorSecret = Record<string, string>;

/**
 * A registered external integration for an Organization (the design's
 * `Connector`, Req 30.1, 30.2, 30.5).
 *
 * Holds the connector's non-secret {@link config} (for example a workspace id or
 * base URL) and, when credentials have been configured, only a
 * {@link CredentialReference} — never the raw secret (Req 30.5). {@link enabled}
 * records whether the Organization currently has the connector turned on.
 */
export interface IntegrationConnector {
  /** The connector record's stable unique id. */
  id: string;
  /** The Organization that owns the connector (its tenant scope). */
  organizationId: string;
  /** The kind of external product (native-supported or optional connector). */
  type: ConnectorType;
  /** Whether the connector is a supported integration (Req 30.1) or optional connector (Req 30.2). */
  kind: ConnectorKind;
  /** Whether the Organization currently has the connector enabled. */
  enabled: boolean;
  /** Non-secret connector configuration (e.g. workspace id, base URL, scopes). */
  config: Record<string, unknown>;
  /**
   * The non-secret handle to the connector's credentials in the {@link SecretStore}
   * (Req 30.5); `undefined` when no credentials have been configured. NEVER the
   * raw secret.
   */
  credentialRef?: CredentialReference;
  /** The ISO-8601 instant the connector was first registered. */
  createdAt: string;
  /** The ISO-8601 instant the connector was last updated. */
  updatedAt: string;
}

/**
 * The outcome of a single connector health probe (Req 30.4).
 *
 * Returned by the injectable {@link ConnectorHealthProber}. `healthy` is `true`
 * only when the external product is reachable and operating; `detail` carries a
 * secret-free, human-readable explanation suitable for a status projection.
 */
export interface ConnectorHealth {
  /** Whether the external product is reachable and operating. */
  healthy: boolean;
  /** A secret-free, human-readable detail (e.g. the failure reason when unhealthy). */
  detail?: string;
  /** The ISO-8601 instant the probe was performed, when known. */
  checkedAt?: string;
}

/**
 * The reported status of a connector (the design's `ConnectorStatus`, Req 30.4).
 *
 * Surfaces the connector's kind, whether it is enabled, its current
 * {@link ConnectorAvailability}, and a boolean {@link hasCredentials} — and
 * deliberately NOTHING else about the credentials, so the secret is never
 * exposed in a status projection (Req 30.5).
 */
export interface ConnectorStatus {
  /** The kind of external product. */
  type: ConnectorType;
  /** Whether the connector is a supported integration or an optional connector. */
  kind: ConnectorKind;
  /** Whether the Organization currently has the connector enabled. */
  enabled: boolean;
  /** The connector's current availability (Req 30.4). */
  availability: ConnectorAvailability;
  /** Whether credentials have been configured (a reference exists) — never the secret (Req 30.5). */
  hasCredentials: boolean;
  /** A secret-free health/availability detail, when known. */
  detail?: string;
  /** The ISO-8601 instant availability was last evaluated, when a probe ran. */
  checkedAt?: string;
}

/**
 * The gracefully-degraded result of an "is connector X available for this
 * Organization" query (Req 30.3, 30.4).
 *
 * Returned by {@link import('./integration-service.js').IntegrationService.isAvailable},
 * which NEVER throws — an unknown type, an unregistered or disabled connector,
 * or a failing health probe all resolve to `available: false` so a native caller
 * can branch on the result and proceed uninterrupted.
 */
export interface ConnectorAvailabilityResult {
  /** The connector type the query was for. */
  type: ConnectorType;
  /** Whether the connector is currently available for use. */
  available: boolean;
  /** The detailed availability classification (Req 30.4). */
  availability: ConnectorAvailability;
  /** A secret-free explanation, when one is available. */
  detail?: string;
}

/**
 * Fields supplied to
 * {@link import('./integration-service.js').IntegrationService.enableConnector}
 * (Req 30.2, 30.5).
 *
 * Carries the connector type, its optional non-secret {@link config}, and — when
 * credentials have already been written to the {@link SecretStore} out of band —
 * an optional credential REFERENCE (never a raw secret, Req 30.5). To attach
 * credentials from raw secret material instead, call
 * {@link import('./integration-service.js').IntegrationService.storeCredentials}.
 */
export interface EnableConnectorInput {
  /** The connector to enable. */
  type: ConnectorType;
  /** Optional non-secret configuration to record on the connector. */
  config?: Record<string, unknown>;
  /** An optional pre-existing credential reference (a non-secret handle, Req 30.5). */
  credentialRef?: CredentialReference;
  /** An explicit connector record id (defaults to a generated id). */
  id?: string;
}

/** Fields the {@link ConnectorStore} needs to create or replace a connector record. */
export interface ConnectorUpsert {
  /** The connector record id (the store preserves an existing record's id on replace). */
  id: string;
  /** The connector type. */
  type: ConnectorType;
  /** The connector kind. */
  kind: ConnectorKind;
  /** Whether the connector is enabled. */
  enabled: boolean;
  /** Non-secret connector configuration. */
  config: Record<string, unknown>;
  /** The non-secret credential reference, when configured (Req 30.5). */
  credentialRef?: CredentialReference;
}

/**
 * The tenant-scoped persistence port for connector records (Req 30.1, 30.2,
 * 30.5).
 *
 * Every method takes the caller's {@link TenantContext} so persistence is
 * automatically scoped to the Organization (Req 1.2, 1.4) — the service never
 * touches a backend directly. The concrete implementation is the tenant-scoped
 * connector repository; tests substitute the in-memory
 * {@link import('./fakes.js').InMemoryConnectorStore}. A record holds only a
 * credential REFERENCE, never the raw secret (Req 30.5).
 */
export interface ConnectorStore {
  /**
   * Create or replace the Organization's connector of a given type, keyed by
   * `(organizationId, type)`. Preserves an existing record's id and `createdAt`
   * and advances `updatedAt`. Returns the persisted record.
   */
  upsert(ctx: TenantContext, input: ConnectorUpsert): Promise<IntegrationConnector>;
  /** Fetch the Organization's connector of a given type, or `null` when none is registered. */
  findByType(ctx: TenantContext, type: ConnectorType): Promise<IntegrationConnector | null>;
  /** List every connector registered for the Organization. */
  list(ctx: TenantContext): Promise<IntegrationConnector[]>;
  /**
   * Set a connector's `enabled` flag. Returns the updated record, or `null` when
   * no connector of that type is registered for the Organization.
   */
  setEnabled(
    ctx: TenantContext,
    type: ConnectorType,
    enabled: boolean,
  ): Promise<IntegrationConnector | null>;
  /**
   * Set (or clear, with `null`) a connector's credential reference (Req 30.5).
   * Returns the updated record, or `null` when no connector of that type is
   * registered for the Organization.
   */
  setCredentialRef(
    ctx: TenantContext,
    type: ConnectorType,
    credentialRef: CredentialReference | null,
  ): Promise<IntegrationConnector | null>;
}

/**
 * The platform secret store seam used to hold connector credentials by reference
 * (Req 30.5).
 *
 * The Integration_Service writes raw secret material here under a generated
 * {@link CredentialReference} and stores only that reference on the connector
 * record, so the secret is excluded from every persisted record, audit event,
 * and status projection. Modelling it as a narrow port keeps the service
 * decoupled from the concrete secret manager (AWS Secrets Manager, Azure Key
 * Vault, …); tests substitute the in-memory
 * {@link import('./fakes.js').InMemorySecretStore}.
 */
export interface SecretStore {
  /**
   * Write secret material under `reference` within the caller's Organization
   * (Req 30.5). Implementations MUST NOT log or echo the secret value.
   */
  put(ctx: TenantContext, reference: CredentialReference, secret: ConnectorSecret): Promise<void>;
  /** Remove the secret material held under `reference` (e.g. when credentials are replaced). */
  delete(ctx: TenantContext, reference: CredentialReference): Promise<void>;
}

/**
 * The injectable connector health prober (Req 30.4).
 *
 * Production wires a prober that performs a lightweight reachability/health check
 * against the external product; tests substitute a deterministic fake. The
 * Integration_Service ALWAYS calls the prober defensively — any thrown error is
 * caught and reported as `unavailable` — so a misbehaving prober can never
 * interrupt native operation (Req 30.3, 30.4).
 */
export interface ConnectorHealthProber {
  /**
   * Probe a connector's external product for health (Req 30.4).
   *
   * @param ctx The tenant scope the connector belongs to.
   * @param connector The enabled connector to probe.
   * @returns The {@link ConnectorHealth} outcome. Implementations may reject; the
   *   service treats a rejection as `unavailable` and never propagates it.
   */
  probe(ctx: TenantContext, connector: IntegrationConnector): Promise<ConnectorHealth>;
}

/** Re-export {@link Principal} for convenience to callers building service inputs. */
export type { Principal };
