/**
 * Unit tests for the Integration_Service (Req 30.1-30.5).
 *
 * These exercise the management and graceful-degradation surface through
 * {@link IntegrationService} with the in-memory fakes:
 *   - enabling a supported integration (Req 30.1) and an optional connector
 *     (Req 30.2), each recorded in the Audit_Service (Req 37.1);
 *   - disabling a connector while native operation is unaffected (Req 30.3,
 *     30.4), audited;
 *   - listing connector status with availability/health (Req 30.4);
 *   - an enabled-but-unhealthy connector reported as `unavailable` — never
 *     thrown — so native operation continues (Req 30.3, 30.4);
 *   - a throwing health prober degrading gracefully to `unavailable`
 *     (Req 30.3, 30.4);
 *   - `isAvailable` returning `false` for unknown/unregistered/disabled
 *     connectors without throwing (Req 30.3, 30.4);
 *   - tenant isolation: a connector enabled by one Organization is invisible to
 *     another (Req 1.2, 1.4); and
 *   - credentials stored BY REFERENCE — the raw secret lives only in the secret
 *     store, never on the connector record, never in an audit event (Req 30.5).
 */

import { describe, expect, it } from 'vitest';

import { IntegrationService } from './integration-service.js';
import { ConnectorNotEnabledError, UnknownConnectorTypeError } from './errors.js';
import {
  CapturingAuditRecorder,
  InMemoryConnectorStore,
  InMemorySecretStore,
  StubConnectorHealthProber,
  makeConnector,
  makePrincipal,
  sequentialIntegrationIdGenerator,
} from './fakes.js';
import type { ConnectorType } from './types.js';

/** Build an Integration_Service over fresh fakes; return the service and its doubles. */
function makeService(): {
  service: IntegrationService;
  connectors: InMemoryConnectorStore;
  audit: CapturingAuditRecorder;
  secrets: InMemorySecretStore;
  prober: StubConnectorHealthProber;
} {
  const connectors = new InMemoryConnectorStore();
  const audit = new CapturingAuditRecorder();
  const secrets = new InMemorySecretStore();
  const prober = new StubConnectorHealthProber();
  const service = new IntegrationService({
    connectors,
    audit,
    secrets,
    healthProber: prober,
    idGenerator: sequentialIntegrationIdGenerator(),
  });
  return { service, connectors, audit, secrets, prober };
}

// ---------------------------------------------------------------------------
// enableConnector + audit (Req 30.1, 30.2, 37.1)
// ---------------------------------------------------------------------------

describe('IntegrationService.enableConnector (Req 30.1, 30.2)', () => {
  it('enables a supported integration (github) and records it as enabled + audited', async () => {
    const { service, audit } = makeService();
    const principal = makePrincipal();

    const connector = await service.enableConnector(principal, {
      type: 'github',
      config: { org: 'acme' },
    });

    expect(connector.type).toBe('github');
    expect(connector.kind).toBe('supported_integration');
    expect(connector.enabled).toBe(true);
    expect(connector.config).toEqual({ org: 'acme' });
    expect(connector.credentialRef).toBeUndefined();

    const audited = audit.withAction('integration.connector_enabled');
    expect(audited).toHaveLength(1);
    expect(audited[0]?.event.metadata).toMatchObject({
      connectorType: 'github',
      connectorKind: 'supported_integration',
      hasCredentials: false,
    });
    expect(audited[0]?.ctx.organizationId).toBe('org-1');
  });

  it('enables an optional connector (notion) classified as an optional_connector', async () => {
    const { service } = makeService();
    const connector = await service.enableConnector(makePrincipal(), { type: 'notion' });
    expect(connector.kind).toBe('optional_connector');
    expect(connector.enabled).toBe(true);
  });

  it('is idempotent on (org, type): re-enabling merges config and keeps the same record id', async () => {
    const { service } = makeService();
    const principal = makePrincipal();

    const first = await service.enableConnector(principal, {
      type: 'slack',
      config: { workspace: 'w1' },
    });
    const second = await service.enableConnector(principal, {
      type: 'slack',
      config: { channel: 'general' },
    });

    expect(second.id).toBe(first.id);
    expect(second.config).toEqual({ workspace: 'w1', channel: 'general' });
  });

  it('rejects an unsupported connector type with UnknownConnectorTypeError', async () => {
    const { service } = makeService();
    await expect(
      service.enableConnector(makePrincipal(), { type: 'dropbox' as ConnectorType }),
    ).rejects.toBeInstanceOf(UnknownConnectorTypeError);
  });
});

// ---------------------------------------------------------------------------
// disableConnector — native operation unaffected (Req 30.3, 30.4)
// ---------------------------------------------------------------------------

describe('IntegrationService.disableConnector (Req 30.3, 30.4)', () => {
  it('disables an enabled connector and audits it', async () => {
    const { service, audit } = makeService();
    const principal = makePrincipal();
    await service.enableConnector(principal, { type: 'confluence' });

    const disabled = await service.disableConnector(principal, 'confluence');

    expect(disabled.enabled).toBe(false);
    expect(audit.withAction('integration.connector_disabled')).toHaveLength(1);
  });

  it('reports a disabled connector as unavailable without throwing (native operation continues)', async () => {
    const { service } = makeService();
    const principal = makePrincipal();
    await service.enableConnector(principal, { type: 'notion' });
    await service.disableConnector(principal, 'notion');

    const result = await service.isAvailable(principal, 'notion');
    expect(result.available).toBe(false);
    expect(result.availability).toBe('disabled');
  });

  it('throws ConnectorNotEnabledError when disabling an unregistered connector', async () => {
    const { service } = makeService();
    await expect(service.disableConnector(makePrincipal(), 'sharepoint')).rejects.toBeInstanceOf(
      ConnectorNotEnabledError,
    );
  });
});

// ---------------------------------------------------------------------------
// listStatus with availability/health (Req 30.4)
// ---------------------------------------------------------------------------

describe('IntegrationService.listStatus (Req 30.4)', () => {
  it('reports enabled connectors with their probed availability', async () => {
    const { service, prober } = makeService();
    const principal = makePrincipal();
    prober.setHealth('notion', { healthy: true, detail: 'ok' });
    prober.setHealth('slack', { healthy: false, detail: 'workspace unreachable' });
    await service.enableConnector(principal, { type: 'notion' });
    await service.enableConnector(principal, { type: 'slack' });

    const statuses = await service.listStatus(principal);
    const byType = new Map(statuses.map((s) => [s.type, s]));

    expect(byType.get('notion')?.availability).toBe('available');
    expect(byType.get('slack')?.availability).toBe('unavailable');
    expect(byType.get('slack')?.detail).toBe('workspace unreachable');
  });

  it('reports a disabled connector as disabled and does not probe it', async () => {
    const { service, prober } = makeService();
    const principal = makePrincipal();
    await service.enableConnector(principal, { type: 'google_drive' });
    await service.disableConnector(principal, 'google_drive');

    const [status] = await service.listStatus(principal);
    expect(status?.availability).toBe('disabled');
    expect(prober.probed).not.toContain('google_drive');
  });
});

// ---------------------------------------------------------------------------
// Unavailable connector reported as unavailable (Req 30.3, 30.4) — graceful
// ---------------------------------------------------------------------------

describe('IntegrationService graceful degradation (Req 30.3, 30.4)', () => {
  it('reports an enabled-but-unhealthy connector as unavailable, never throwing', async () => {
    const { service, prober } = makeService();
    const principal = makePrincipal();
    prober.setHealth('confluence', { healthy: false, detail: 'down for maintenance' });
    await service.enableConnector(principal, { type: 'confluence' });

    const result = await service.isAvailable(principal, 'confluence');
    expect(result.available).toBe(false);
    expect(result.availability).toBe('unavailable');
    expect(result.detail).toBe('down for maintenance');
  });

  it('degrades gracefully when the health prober throws (reports unavailable)', async () => {
    const { service, prober } = makeService();
    const principal = makePrincipal();
    prober.throwError = new Error('connection timed out');
    await service.enableConnector(principal, { type: 'notion' });

    const result = await service.isAvailable(principal, 'notion');
    expect(result.available).toBe(false);
    expect(result.availability).toBe('unavailable');
    expect(result.detail).toBe('connection timed out');
  });

  it('isAvailable returns false (disabled) for an unknown connector type without throwing', async () => {
    const { service } = makeService();
    const result = await service.isAvailable(makePrincipal(), 'dropbox' as ConnectorType);
    expect(result.available).toBe(false);
    expect(result.availability).toBe('disabled');
  });

  it('isAvailable returns false for a never-registered connector without throwing', async () => {
    const { service } = makeService();
    const result = await service.isAvailable(makePrincipal(), 'sharepoint');
    expect(result.available).toBe(false);
    expect(result.availability).toBe('disabled');
    expect(result.detail).toBe('connector not registered');
  });

  it('reports a healthy enabled connector as available', async () => {
    const { service } = makeService();
    const principal = makePrincipal();
    await service.enableConnector(principal, { type: 'notion' });
    const result = await service.isAvailable(principal, 'notion');
    expect(result.available).toBe(true);
    expect(result.availability).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (Req 1.2, 1.4)
// ---------------------------------------------------------------------------

describe('IntegrationService tenant isolation (Req 1.2, 1.4)', () => {
  it('does not expose a connector enabled by another Organization', async () => {
    const { service } = makeService();
    const orgA = makePrincipal({ organizationId: 'org-a', userId: 'user-a' });
    const orgB = makePrincipal({ organizationId: 'org-b', userId: 'user-b' });

    await service.enableConnector(orgA, { type: 'notion' });

    expect(await service.getConnector(orgB, 'notion')).toBeNull();
    expect(await service.listStatus(orgB)).toHaveLength(0);
    const result = await service.isAvailable(orgB, 'notion');
    expect(result.available).toBe(false);
  });

  it('does not disable another Organization\'s connector', async () => {
    const { service, connectors } = makeService();
    connectors.seed(makeConnector({ organizationId: 'org-a', type: 'slack' }));
    const orgB = makePrincipal({ organizationId: 'org-b' });

    await expect(service.disableConnector(orgB, 'slack')).rejects.toBeInstanceOf(
      ConnectorNotEnabledError,
    );
  });
});

// ---------------------------------------------------------------------------
// Credentials stored BY REFERENCE (Req 30.5)
// ---------------------------------------------------------------------------

describe('IntegrationService.storeCredentials — secret by reference only (Req 30.5)', () => {
  it('writes the raw secret to the secret store and stores ONLY a reference on the record', async () => {
    const { service, secrets } = makeService();
    const principal = makePrincipal();
    await service.enableConnector(principal, { type: 'notion' });

    const updated = await service.storeCredentials(principal, 'notion', {
      token: 'super-secret-token',
    });

    // The connector record carries a reference, not the secret.
    expect(updated.credentialRef).toBeDefined();
    expect(JSON.stringify(updated)).not.toContain('super-secret-token');

    // The raw secret lives only in the secret store, keyed by the reference.
    const stored = secrets.get('org-1', updated.credentialRef!);
    expect(stored).toEqual({ token: 'super-secret-token' });
    expect(secrets.count).toBe(1);
  });

  it('never records the raw secret in an audit event (Req 30.5)', async () => {
    const { service, audit } = makeService();
    const principal = makePrincipal();
    await service.enableConnector(principal, { type: 'slack' });
    await service.storeCredentials(principal, 'slack', { apiKey: 'leak-me-not' });

    const audited = audit.withAction('integration.credentials_configured');
    expect(audited).toHaveLength(1);
    expect(audited[0]?.event.metadata).toMatchObject({ connectorType: 'slack', hasCredentials: true });
    expect(JSON.stringify(audit.recorded)).not.toContain('leak-me-not');
  });

  it('rotating credentials replaces the secret and leaves no orphaned material', async () => {
    const { service, secrets } = makeService();
    const principal = makePrincipal();
    await service.enableConnector(principal, { type: 'confluence' });

    const first = await service.storeCredentials(principal, 'confluence', { token: 'v1' });
    const second = await service.storeCredentials(principal, 'confluence', { token: 'v2' });

    expect(second.credentialRef).not.toBe(first.credentialRef);
    // Only the current secret remains.
    expect(secrets.count).toBe(1);
    expect(secrets.get('org-1', first.credentialRef!)).toBeUndefined();
    expect(secrets.get('org-1', second.credentialRef!)).toEqual({ token: 'v2' });
  });

  it('reports hasCredentials in status without exposing the secret (Req 30.5)', async () => {
    const { service } = makeService();
    const principal = makePrincipal();
    await service.enableConnector(principal, { type: 'notion' });
    await service.storeCredentials(principal, 'notion', { token: 'do-not-show' });

    const [status] = await service.listStatus(principal);
    expect(status?.hasCredentials).toBe(true);
    expect(JSON.stringify(status)).not.toContain('do-not-show');
  });

  it('throws ConnectorNotEnabledError when storing credentials for an unregistered connector', async () => {
    const { service } = makeService();
    await expect(
      service.storeCredentials(makePrincipal(), 'notion', { token: 'x' }),
    ).rejects.toBeInstanceOf(ConnectorNotEnabledError);
  });

  it('rejects credentials for an unsupported connector type', async () => {
    const { service } = makeService();
    await expect(
      service.storeCredentials(makePrincipal(), 'dropbox' as ConnectorType, { token: 'x' }),
    ).rejects.toBeInstanceOf(UnknownConnectorTypeError);
  });
});
