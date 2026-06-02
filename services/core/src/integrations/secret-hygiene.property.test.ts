/**
 * Property-based test for secret hygiene on the Integration_Service surface.
 *
 * Feature: auxify-ai-platform, Property 49: Secrets never appear in logs or user
 * interfaces.
 *
 * Validates: Requirements 30.5, 34.7.
 *
 * Design statement (Property 49): "For any operation that uses a stored secret
 * (connector credentials, provider keys, or other secret-store values), no
 * emitted log entry and no user-facing projection contains the secret's value."
 *
 * This file covers the connector-credentials slice. The Integration_Service
 * writes the raw secret to the platform secret store BY REFERENCE and persists
 * only an opaque {@link CredentialReference} on the connector record, so the
 * secret must be absent from every user-facing / loggable surface:
 *
 *   - the {@link IntegrationConnector} record returned from `storeCredentials`
 *     and `getConnector`,
 *   - the {@link ConnectorStatus} projection returned from `listStatus` (which
 *     exposes only a boolean `hasCredentials`),
 *   - every captured audit event (recorded only `hasCredentials: true` + the
 *     reference, never the secret value).
 *
 * The platform secret store is the ONE place the raw secret legitimately lives,
 * so it is intentionally not asserted as a leak surface; instead we prove the
 * connector still works BY REFERENCE — the secret is resolvable from the store
 * under the connector's `credentialRef`.
 *
 * For an arbitrary credential (long, unicode, JSON-looking, base64-looking,
 * hex-looking field values) NO field value may appear as a substring of any of
 * those projection / audit serializations. The (vanishingly rare) input that
 * happens to coincide with a NON-secret value the caller supplied or the system
 * stamps in the clear (the connector config, the generated reference, the
 * connector type/kind, ids, or timestamps) is skipped — such a coincidence is
 * not a secret leak.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { IntegrationService } from './integration-service.js';
import {
  CapturingAuditRecorder,
  InMemoryConnectorStore,
  InMemorySecretStore,
  StubConnectorHealthProber,
  makePrincipal,
  sequentialIntegrationIdGenerator,
} from './fakes.js';
import { OPTIONAL_CONNECTOR_TYPES, type ConnectorSecret, type ConnectorType } from './types.js';

/** At least 100 generated iterations, per the spec's PBT minimum. */
const NUM_RUNS = 200;

/** Non-secret connector configuration recorded on the connector record. */
const CONFIG = { workspaceId: 'ws-acme', baseUrl: 'https://acme.example' } as const;

/** Tricky individual credential field values (long, unicode, base64/hex/json-looking). */
const secretValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 8, maxLength: 160 }),
  fc.fullUnicodeString({ minLength: 8, maxLength: 160 }),
  fc.string({ minLength: 256, maxLength: 768 }),
  fc.base64String({ minLength: 16, maxLength: 128 }),
  fc.hexaString({ minLength: 16, maxLength: 64 }),
  fc
    .record({ token: fc.string({ minLength: 8, maxLength: 48 }), n: fc.integer() })
    .map((o) => JSON.stringify(o)),
);

/** An arbitrary bag of named credential fields (e.g. token, clientId, clientSecret). */
const secretArb: fc.Arbitrary<ConnectorSecret> = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 16 }),
  secretValueArb,
  { minKeys: 1, maxKeys: 5 },
);

describe('Feature: auxify-ai-platform, Property 49: Secrets never appear in logs or user interfaces', () => {
  it('stores connector credentials by reference: no field value appears in the connector record, status projection, or any audit event — yet the connector resolves by reference (Validates: Requirements 30.5, 34.7)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<ConnectorType>(...OPTIONAL_CONNECTOR_TYPES),
        secretArb,
        async (type, secret) => {
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
          const principal = makePrincipal();

          await service.enableConnector(principal, { type, config: { ...CONFIG } });
          const updated = await service.storeCredentials(principal, type, secret);

          // Non-secret values the caller supplied or the system stamped in the
          // clear; a generated secret coinciding with one is not a leak.
          const knownNonSecret = JSON.stringify([
            updated.credentialRef,
            updated.type,
            updated.kind,
            updated.id,
            updated.organizationId,
            updated.createdAt,
            updated.updatedAt,
            CONFIG,
          ]);
          const values = Object.values(secret);
          fc.pre(values.every((value) => !knownNonSecret.includes(value)));

          const status = await service.listStatus(principal);
          const fetched = await service.getConnector(principal, type);

          // EVERY user-facing / loggable surface (NOT the secret store itself).
          const surfaces: string[] = [
            JSON.stringify(updated),
            JSON.stringify(fetched),
            JSON.stringify(status),
            JSON.stringify(audit.recorded),
          ];
          for (const value of values) {
            for (const surface of surfaces) {
              expect(surface.includes(value)).toBe(false);
            }
          }

          // The status projection exposes only the boolean flag, never the secret.
          const projected = status.find((s) => s.type === type);
          expect(projected?.hasCredentials).toBe(true);

          // Hygiene must not break function: the connector resolves BY REFERENCE.
          expect(updated.credentialRef).toBeDefined();
          const ref = updated.credentialRef as string;
          expect(secrets.get(principal.organizationId, ref)).toEqual(secret);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
