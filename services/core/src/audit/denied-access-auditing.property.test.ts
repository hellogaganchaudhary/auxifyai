/**
 * Feature: auxify-ai-platform, Property 3: Every denied access is audited.
 *
 * Validates: Requirements 1.7, 19.4, 26.9, 28.8, 33.12
 *
 * The platform is fail-closed: access is denied by default, and *every* denied
 * attempt must leave an immutable trail in the Audit_Service. This principle
 * recurs across the spec — cross-tenant references are denied + audited
 * (Req 1.7), the Policy_Engine denies + audits when no Allow_List grants a
 * permission (Req 19.4), the Knowledge_Hub denies + audits unauthorized page
 * access (Req 26.9), Document_Management denies + audits unauthorized document
 * access (Req 28.8), and the Auth_Service denies + audits failed/again-blocked
 * authentication (Req 33.12).
 *
 * Access_Control (task 3.7), the native modules, and the Auth_Service are not
 * yet implemented, but they will all honor the *same contract* at the audit
 * seam: route every denial through the {@link AuditRecorder} port, and never
 * audit an allowed access. This test pins that contract down at the audit layer
 * so the producers above can be built against a verified target.
 *
 * To stay coupled to the real contract, the test:
 *   - imports the production {@link AuditRecorder} port and {@link AuditEvent}
 *     shape from the Audit_Service module (`./index`);
 *   - exercises a small reference {@link auditedAuthorize} helper that models
 *     "decide, then audit IFF the decision is deny" — exactly what production
 *     Access_Control (3.7) and the native/auth producers implement;
 *   - verifies the property both against an in-memory capturing recorder (to
 *     inspect the recorded events) and against a *real* {@link AuditService}
 *     backed by a fake {@link SqlClient} (to prove denials are actually
 *     persisted as `audit_logs` rows and allowed accesses write nothing).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import { AuditService, type AuditEvent, type AuditRecorder } from './index.js';

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// The access-decision domain modeled by the test.
// ---------------------------------------------------------------------------

/** A binary authorization effect for an attempt. */
type AccessEffect = 'allow' | 'deny';

/**
 * A single access attempt by a principal against a resource. `effect` is the
 * authorization decision the (stubbed) decision function would return for this
 * attempt — modeling an arbitrary allow/deny outcome from Access_Control.
 */
interface AccessAttempt {
  organizationId: string;
  principalId: string;
  resourceType: string;
  resourceId: string;
  action: string;
  effect: AccessEffect;
  /** Why a denial occurred, carried into the audit record's metadata. */
  denyReason: string;
}

/**
 * Reference implementation of the denied-access-auditing contract.
 *
 * Given an authorization decision for an arbitrary (principal, resource,
 * action) and an {@link AuditRecorder}, this records exactly one audit event
 * IFF the decision is `deny`, capturing the actor, action, resource, and
 * Organization; an `allow` decision records nothing. Production Access_Control
 * (task 3.7), the native modules (Req 26.9, 28.8), and the Auth_Service
 * (Req 33.12) implement this same contract by routing their denials through the
 * AuditRecorder port.
 *
 * The Organization scope and default actor are carried on the
 * {@link TenantContext}, exactly as the real Audit_Service requires.
 */
async function auditedAuthorize(
  attempt: AccessAttempt,
  decide: (attempt: AccessAttempt) => AccessEffect,
  recorder: AuditRecorder,
): Promise<AccessEffect> {
  const effect = decide(attempt);
  if (effect === 'deny') {
    const ctx: TenantContext = {
      organizationId: attempt.organizationId,
      userId: attempt.principalId,
    };
    const event: AuditEvent = {
      action: 'access.denied',
      resourceType: attempt.resourceType,
      resourceId: attempt.resourceId,
      actorId: attempt.principalId,
      metadata: { attemptedAction: attempt.action, reason: attempt.denyReason },
    };
    await recorder.record(ctx, event);
  }
  return effect;
}

/** The decision function under the contract: honor each attempt's effect. */
const decideByEffect = (attempt: AccessAttempt): AccessEffect => attempt.effect;

// ---------------------------------------------------------------------------
// Test doubles.
// ---------------------------------------------------------------------------

/** A captured (context, event) pair as seen by the AuditRecorder port. */
interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * An in-memory {@link AuditRecorder} that captures every recorded event so the
 * property can compare the audit trail against the set of denied attempts.
 */
class CapturingAuditRecorder implements AuditRecorder {
  readonly recorded: CapturedAudit[] = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    // Defensive copies so later mutation by callers cannot rewrite the trail.
    this.recorded.push({ ctx: { ...ctx }, event: { ...event } });
  }
}

/** A single captured SQL query: its text and bound positional parameters. */
interface CapturedQuery {
  text: string;
  params: unknown[];
}

/**
 * A fake {@link SqlClient} (mirroring the Audit_Service unit tests) that records
 * every query and echoes a row built from an INSERT's bound parameters, so a
 * real {@link AuditService} can append without a live database.
 */
class FakeSqlClient implements SqlClient {
  readonly queries: CapturedQuery[] = [];

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ text, params });
    if (/^INSERT INTO/.test(text)) {
      return { rows: [echoInsertRow(text, params)] };
    }
    return { rows: [] };
  }

  /** Just the INSERTs issued (one per persisted audit record). */
  get inserts(): CapturedQuery[] {
    return this.queries.filter((q) => /^INSERT INTO audit_logs/.test(q.text));
  }
}

/** Reconstruct an inserted row from the captured INSERT text + params. */
function echoInsertRow(text: string, params: unknown[]): SqlRow {
  const columnList = /\(([^)]+)\) VALUES/.exec(text)?.[1] ?? '';
  const columns = columnList.split(',').map((c) => c.trim().replace(/"/g, ''));
  const row: SqlRow = {};
  columns.forEach((column, index) => {
    row[column] = params[index];
  });
  return row;
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** A non-empty identifier (organization id, principal id, resource id, ...). */
const idArb = fc.string({ minLength: 1, maxLength: 24 });

/** A single access attempt with an arbitrary allow/deny effect. */
const attemptArb: fc.Arbitrary<AccessAttempt> = fc.record({
  organizationId: idArb.map((s) => `org-${s}`),
  principalId: idArb.map((s) => `user-${s}`),
  resourceType: fc.constantFrom(
    'project',
    'team',
    'organization',
    'document',
    'knowledge_page',
    'channel_message',
    'user',
  ),
  resourceId: idArb,
  action: fc.constantFrom('read', 'write', 'delete', 'move', 'login'),
  effect: fc.constantFrom<AccessEffect>('allow', 'deny'),
  denyReason: fc.constantFrom('no_grant', 'cross_tenant', 'not_a_member', 'mfa_required'),
});

/** A sequence of access attempts. */
const attemptsArb = fc.array(attemptArb, { maxLength: 40 });

// ---------------------------------------------------------------------------
// Property 3: Every denied access is audited (and only denied accesses are).
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 3: Every denied access is audited', () => {
  it('records exactly one audit event per denied attempt and none for allowed (Validates: Requirements 1.7, 19.4, 26.9, 28.8, 33.12)', async () => {
    await fc.assert(
      fc.asyncProperty(attemptsArb, async (attempts) => {
        const recorder = new CapturingAuditRecorder();

        const effects: AccessEffect[] = [];
        for (const attempt of attempts) {
          effects.push(await auditedAuthorize(attempt, decideByEffect, recorder));
        }

        const denied = attempts.filter((a) => a.effect === 'deny');
        const allowed = attempts.filter((a) => a.effect === 'allow');

        // Cardinality: one record per denial, zero for the allowed ones, so the
        // audit trail's size equals exactly the number of denied attempts.
        expect(recorder.recorded).toHaveLength(denied.length);
        expect(recorder.recorded.length + allowed.length).toBe(attempts.length);

        // Decisions are unchanged by auditing (auditing is a side effect).
        expect(effects).toEqual(attempts.map((a) => a.effect));

        // Content + order: each recorded event matches its denied attempt and
        // captures actor, action, resource, and Organization.
        denied.forEach((attempt, i) => {
          const { ctx, event } = recorder.recorded[i]!;
          expect(ctx.organizationId).toBe(attempt.organizationId);
          expect(event.actorId).toBe(attempt.principalId);
          expect(event.action).toBe('access.denied');
          expect(event.resourceType).toBe(attempt.resourceType);
          expect(event.resourceId).toBe(attempt.resourceId);
          expect(event.metadata).toMatchObject({
            attemptedAction: attempt.action,
            reason: attempt.denyReason,
          });
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('persists each denial as exactly one immutable audit_logs row through the real Audit_Service, and allowed accesses write nothing (Validates: Requirements 1.7, 19.4, 26.9, 28.8, 33.12)', async () => {
    await fc.assert(
      fc.asyncProperty(attemptsArb, async (attempts) => {
        const sql = new FakeSqlClient();
        let counter = 0;
        // A real Audit_Service implementing the AuditRecorder port — denials are
        // routed through exactly the seam production producers will use.
        const recorder: AuditRecorder = new AuditService(sql, {
          idFactory: () => `audit-${++counter}`,
          now: () => new Date('2026-06-02T12:00:00.000Z'),
        });

        for (const attempt of attempts) {
          await auditedAuthorize(attempt, decideByEffect, recorder);
        }

        const denied = attempts.filter((a) => a.effect === 'deny');

        // One INSERT per denial; allowed accesses issue no SQL at all.
        expect(sql.inserts).toHaveLength(denied.length);
        expect(sql.queries).toHaveLength(denied.length);

        // Each persisted row is append-only (INSERT, never UPDATE/DELETE) and
        // bound to the denying attempt's Organization as its first parameter.
        sql.inserts.forEach((insert, i) => {
          expect(insert.text).toContain('RETURNING *');
          expect(insert.params[0]).toBe(denied[i]!.organizationId);
        });
        expect(sql.queries.every((q) => /^INSERT INTO audit_logs/.test(q.text))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('audits nothing when every access in a sequence is allowed (Validates: Requirements 1.7, 19.4)', async () => {
    const allowedOnlyArb = fc.array(
      attemptArb.map((a) => ({ ...a, effect: 'allow' as const })),
      { maxLength: 40 },
    );

    await fc.assert(
      fc.asyncProperty(allowedOnlyArb, async (attempts) => {
        const recorder = new CapturingAuditRecorder();
        for (const attempt of attempts) {
          await auditedAuthorize(attempt, decideByEffect, recorder);
        }
        expect(recorder.recorded).toHaveLength(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('audits every access in a sequence when every decision is deny (Validates: Requirements 1.7, 19.4, 26.9, 28.8, 33.12)', async () => {
    const deniedOnlyArb = fc.array(
      attemptArb.map((a) => ({ ...a, effect: 'deny' as const })),
      { minLength: 1, maxLength: 40 },
    );

    await fc.assert(
      fc.asyncProperty(deniedOnlyArb, async (attempts) => {
        const recorder = new CapturingAuditRecorder();
        for (const attempt of attempts) {
          await auditedAuthorize(attempt, decideByEffect, recorder);
        }
        // Bijection: |records| === |attempts| when all are denied.
        expect(recorder.recorded).toHaveLength(attempts.length);
        expect(recorder.recorded.every((r) => r.event.action === 'access.denied')).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
