/**
 * Integration_Service (Req 30.1-30.5): the service that manages an
 * Organization's OPTIONAL external interoperability.
 *
 * The Integration_Service offers the supported first-class integrations GitHub,
 * email, and enterprise identity providers (Req 30.1) and lets an Organization
 * enable the optional interoperability connectors Notion, Slack, Confluence,
 * SharePoint, and Google Drive (Req 30.2). Its defining guarantee is that NONE of
 * these is ever required for the platform's native operation: the platform
 * delivers chat, knowledge, messaging, documents, and search through native
 * modules with no required external connector (Req 30.3), and when a connector
 * or supported integration is unavailable the native modules keep operating
 * uninterrupted while the connector's status is reported (Req 30.4).
 *
 * Surface:
 *   - {@link IntegrationService} — the service; `enableConnector` registers/turns
 *     on a connector with non-secret config and an optional credential reference
 *     (Req 30.1, 30.2), `disableConnector` turns one off without affecting native
 *     operation (Req 30.3, 30.4), `storeCredentials` writes raw credentials to
 *     the secret store by reference (Req 30.5), `listStatus` reports each
 *     connector's enable/availability/health status (Req 30.4), and the
 *     never-throwing `isAvailable` answers "is connector X available for this
 *     Organization?" by degrading gracefully (Req 30.3, 30.4).
 *   - {@link IntegrationServiceOptions} / {@link IntegrationIdGenerator} /
 *     {@link IntegrationClock} / {@link systemIntegrationClock} — construction
 *     dependencies and the injectable id/clock seams.
 *   - The injectable ports the service composes — {@link ConnectorStore},
 *     {@link SecretStore}, {@link ConnectorHealthProber} — and the shared
 *     {@link import('../audit/index.js').AuditRecorder}.
 *   - The domain types — {@link IntegrationConnector}, {@link ConnectorStatus},
 *     {@link ConnectorAvailabilityResult}, {@link ConnectorHealth},
 *     {@link ConnectorType} / {@link SupportedIntegrationType} /
 *     {@link OptionalConnectorType} / {@link ConnectorKind} /
 *     {@link ConnectorAvailability}, {@link ConnectorSecret} /
 *     {@link CredentialReference}, {@link EnableConnectorInput},
 *     {@link ConnectorUpsert} — with the {@link CONNECTOR_TYPES} /
 *     {@link SUPPORTED_INTEGRATION_TYPES} / {@link OPTIONAL_CONNECTOR_TYPES} /
 *     {@link CONNECTOR_AVAILABILITIES} value lists and the
 *     {@link isConnectorType} / {@link isOptionalConnectorType} /
 *     {@link connectorKind} helpers.
 *   - {@link UnknownConnectorTypeError} / {@link ConnectorNotEnabledError} — the
 *     typed management-path errors, each projecting into a serializable
 *     {@link import('@auxify/types').PlatformError} (Req 46.8).
 *
 * SECURITY (Req 30.5): a connector holds third-party credentials. The stored
 * {@link IntegrationConnector} record carries ONLY a non-secret
 * {@link CredentialReference}; the raw secret is written to the platform
 * {@link SecretStore} under that reference, resolved at use-time, and excluded
 * from every persisted record, audit event, log line, and status projection.
 *
 * The in-memory test fakes (a {@link ConnectorStore}, a capturing audit recorder,
 * a {@link SecretStore}, a health prober, and the builders) live in `./fakes.js`
 * and are intentionally NOT re-exported from this barrel — they would collide
 * with the equally-named audit-recorder fakes of sibling modules at the package
 * barrel. Following the established convention, the unit tests here import them
 * directly from `./fakes.js`. The injectable clock is surfaced as
 * {@link IntegrationClock} / {@link systemIntegrationClock} (not `Clock` /
 * `systemClock`) so the names never collide with sibling modules' clocks in the
 * shared `@auxify/core` barrel; the domain names are otherwise
 * `Integration`-/`Connector`-prefixed for the same reason.
 */

export {
  IntegrationService,
  systemIntegrationClock,
  type IntegrationServiceOptions,
  type IntegrationIdGenerator,
  type IntegrationClock,
} from './integration-service.js';

export {
  UnknownConnectorTypeError,
  ConnectorNotEnabledError,
  UNKNOWN_CONNECTOR_TYPE_CODE,
  CONNECTOR_NOT_ENABLED_CODE,
} from './errors.js';

export {
  SUPPORTED_INTEGRATION_TYPES,
  OPTIONAL_CONNECTOR_TYPES,
  CONNECTOR_TYPES,
  CONNECTOR_AVAILABILITIES,
  isConnectorType,
  isOptionalConnectorType,
  connectorKind,
  type SupportedIntegrationType,
  type OptionalConnectorType,
  type ConnectorType,
  type ConnectorKind,
  type ConnectorAvailability,
  type CredentialReference,
  type ConnectorSecret,
  type IntegrationConnector,
  type ConnectorHealth,
  type ConnectorStatus,
  type ConnectorAvailabilityResult,
  type EnableConnectorInput,
  type ConnectorUpsert,
  type ConnectorStore,
  type SecretStore,
  type ConnectorHealthProber,
} from './types.js';
