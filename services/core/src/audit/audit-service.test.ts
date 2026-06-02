/**
 * Unit tests for the Audit_Service (Req 37).
 *
 * These prove, against a fake {@link SqlClient} that captures every issued SQL
 * text and its positional parameters, that the service:
 *   - records the full tracked-action shape — actor, action, resource type+id,
 *     Organization, timestamp, IP, user agent — across every audited domain
 *     (Req 37.1, 37.2), forcing the Organization from the tenant context;
 *   - exposes an append + query surface with no mutation, and fails closed when
 *     the tenant context is missing (Req 37.3 immutability is also enforced by
 *     the DB trigger and verified in the migration tests);
 *   - builds a sound filtered query with the Organization predicate first and
 *     every supplied dimension bound as a parameter (Req 37.5);
 *   - represents the 7-year retention window and can identify expired records
 *     for the Compliance_Manager without deleting them (Req 37.4).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { MissingTenantContextError } from '../repositories/index.js';
import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import {
  AUDIT_RETENTION_POLICY,
  AUDIT_RETENTION_YEARS,
  AuditService,
  auditRetentionCutoff,
  isWithinAuditRetention,
  type AuditEvent,
  type AuditRecorder,
} from './index.js';

/** A single captured query: its SQL text and bound positional parameters. */
interface CapturedQuery {
  text: string;
  params: unknown[];
}

/**
 * A fake {@link SqlClient} that records every query and returns programmable
 * rows (FIFO). For INSERTs it echoes a row built from the bound parameters so
 * the `RETURNING *` mapper has data to map.
 */
class FakeSqlClient implements SqlClient {
  readonly queries: CapturedQuery[] = [];
  private responses: SqlRow[][] = [];

  queueRows(rows: SqlRow[]): void {
    this.responses.push(rows);
  }

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ text, params });
    const queued = this.responses.shift();
    if (queued !== undefined) return { rows: queued };
    // Default: echo an audit row from the INSERT's columns/params so append()
    // can map a result without each test having to queue one.
    if (/^INSERT INTO/.test(text)) {
      return { rows: [echoInsertRow(text, params)] };
    }
    return { rows: [] };
  }

  get last(): CapturedQuery {
    const q = this.queries[this.queries.length - 1];
    if (q === undefined) throw new Error('no query captured');
    return q;
  }
}

/** Reconstruct the inserted row from the captured INSERT text + params. */
function echoInsertRow(text: string, params: unknown[]): SqlRow {
  // Columns appear as `INSERT INTO audit_logs (a, b, c) VALUES ($1, $2, $3)`.
  const columnList = /\(([^)]+)\) VALUES/.exec(text)?.[1] ?? '';
  const columns = columnList.split(',').map((c) => c.trim().replace(/"/g, ''));
  const row: SqlRow = {};
  columns.forEach((column, index) => {
    row[column] = params[index];
  });
  return row;
}

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };

/** Build a service with deterministic id + clock for assertions. */
function makeService(now = '2026-06-02T12:00:00.000Z'): {
  service: AuditService;
  sql: FakeSqlClient;
} {
  const sql = new FakeSqlClient();
  let counter = 0;
  const service = new AuditService(sql, {
    idFactory: () => `audit-${++counter}`,
    now: () => new Date(now),
  });
  return { service, sql };
}

const baseEvent: AuditEvent = {
  action: 'access.denied',
  resourceType: 'document',
  resourceId: 'doc-1',
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
};

// ---------------------------------------------------------------------------
// record — full tracked-action capture (Req 37.1) and tenant forcing.
// ---------------------------------------------------------------------------

describe('AuditService.record (Req 37.1)', () => {
  it('captures actor, action, resource type+id, organization, timestamp, IP, user agent', async () => {
    const { service, sql } = makeService();

    const record = await service.recordReturning(ctx, baseEvent);

    expect(record).toMatchObject({
      id: 'audit-1',
      organizationId: 'org-1',
      actorId: 'user-1',
      action: 'access.denied',
      resourceType: 'document',
      resourceId: 'doc-1',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      timestamp: '2026-06-02T12:00:00.000Z',
    });

    // organization_id is bound (parameterized) and equals the context org.
    expect(sql.last.text).toMatch(/^INSERT INTO audit_logs/);
    expect(sql.last.text).toContain('RETURNING *');
    expect(sql.last.params[0]).toBe('org-1');
  });

  it('defaults actor to ctx.userId, id to the id factory, and timestamp to now', async () => {
    const { service } = makeService('2026-01-01T00:00:00.000Z');

    const record = await service.recordReturning(ctx, {
      action: 'update',
      resourceType: 'project',
      resourceId: 'proj-9',
    });

    expect(record.actorId).toBe('user-1');
    expect(record.id).toBe('audit-1');
    expect(record.timestamp).toBe('2026-01-01T00:00:00.000Z');
    // IP / user agent default to empty strings when not captured.
    expect(record.ip).toBe('');
    expect(record.userAgent).toBe('');
    expect(record.metadata).toEqual({});
  });

  it('honors an explicit actor, timestamp, and metadata when supplied', async () => {
    const { service } = makeService();

    const record = await service.recordReturning(ctx, {
      actorId: 'admin-7',
      action: 'project.move',
      resourceType: 'project',
      resourceId: 'proj-3',
      timestamp: '2025-12-31T23:59:59.000Z',
      metadata: { fromTeam: 'team-a', toTeam: 'team-b' },
    });

    expect(record.actorId).toBe('admin-7');
    expect(record.timestamp).toBe('2025-12-31T23:59:59.000Z');
    expect(record.metadata).toEqual({ fromTeam: 'team-a', toTeam: 'team-b' });
  });

  it('forces organization_id from the context, not from the event payload', async () => {
    const { service, sql } = makeService();

    await service.record(ctx, {
      action: 'delete',
      resourceType: 'api_key',
      resourceId: 'key-1',
      // @ts-expect-error — organizationId is taken from ctx, never the event.
      organizationId: 'org-EVIL',
    });

    expect(sql.last.params[0]).toBe('org-1');
    expect(sql.last.params).not.toContain('org-EVIL');
  });

  it('record() resolves to void (append-only port shape)', async () => {
    const { service } = makeService();
    const result = await service.record(ctx, baseEvent);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// record — coverage across every tracked domain (Req 37.2).
// ---------------------------------------------------------------------------

describe('AuditService records across all tracked domains (Req 37.2)', () => {
  const domains: Array<[string, AuditEvent]> = [
    ['authentication', { action: 'auth.login.failed', resourceType: 'user', resourceId: 'u-1' }],
    ['administration', { action: 'role.change', resourceType: 'user', resourceId: 'u-2' }],
    ['agents', { action: 'agent.run', resourceType: 'agent_run', resourceId: 'run-1' }],
    ['workflows', { action: 'workflow.execute', resourceType: 'workflow', resourceId: 'wf-1' }],
    ['budgets', { action: 'budget.exceeded', resourceType: 'usage_record', resourceId: 'ur-1' }],
    ['tools', { action: 'tool.invoke', resourceType: 'agent', resourceId: 'a-1' }],
    ['knowledge', { action: 'knowledge.denied', resourceType: 'knowledge_page', resourceId: 'kp-1' }],
    ['messaging', { action: 'message.delete', resourceType: 'channel_message', resourceId: 'cm-1' }],
    ['document management', { action: 'document.denied', resourceType: 'document', resourceId: 'd-1' }],
    ['access decisions', { action: 'access.denied', resourceType: 'project', resourceId: 'p-1' }],
  ];

  it.each(domains)('records a %s event with the full shape', async (_domain, event) => {
    const { service } = makeService();
    const record = await service.recordReturning(ctx, event);

    expect(record.action).toBe(event.action);
    expect(record.resourceType).toBe(event.resourceType);
    expect(record.resourceId).toBe(event.resourceId);
    expect(record.organizationId).toBe('org-1');
    expect(record.actorId).toBe('user-1');
    expect(record.timestamp).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// Immutability surface (Req 37.3) + fail-closed tenant context.
// ---------------------------------------------------------------------------

describe('AuditService is append + query only (Req 37.3)', () => {
  it('exposes no update or delete method', () => {
    const { service } = makeService();
    const surface = service as unknown as Record<string, unknown>;
    expect(typeof surface.record).toBe('function');
    expect(typeof surface.query).toBe('function');
    expect(surface.update).toBeUndefined();
    expect(surface.delete).toBeUndefined();
    expect(surface.remove).toBeUndefined();
  });

  it('satisfies the AuditRecorder port', () => {
    const { service } = makeService();
    const recorder: AuditRecorder = service; // type-level: record(ctx, event)
    expect(typeof recorder.record).toBe('function');
  });

  const missing: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['empty organizationId', { organizationId: '', userId: 'u' }],
    ['missing organizationId', { userId: 'u' }],
    ['empty userId', { organizationId: 'org-1', userId: '' }],
  ];

  it.each(missing)('rejects record with %s context before issuing SQL', async (_label, bad) => {
    const { service, sql } = makeService();
    await expect(
      service.record(bad as TenantContext, baseEvent),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
    expect(sql.queries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// query — filtered, organization-first, parameterized (Req 37.5).
// ---------------------------------------------------------------------------

describe('AuditService.query (Req 37.5)', () => {
  it('scopes by organization first and binds it as $1', async () => {
    const { service, sql } = makeService();
    sql.queueRows([]);

    await service.query({ organizationId: 'org-1' });

    const { text, params } = sql.last;
    expect(text).toMatch(/^SELECT \* FROM audit_logs WHERE organization_id = \$1/);
    expect(params[0]).toBe('org-1');
    expect(text).toContain('ORDER BY "timestamp" DESC');
  });

  it('AND-s every supplied dimension as a bound parameter', async () => {
    const { service, sql } = makeService();
    sql.queueRows([]);

    await service.query({
      organizationId: 'org-1',
      actorId: 'user-9',
      action: 'access.denied',
      resourceType: 'document',
      resourceId: 'doc-7',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-12-31T23:59:59.000Z',
      limit: 50,
      offset: 10,
    });

    const { text, params } = sql.last;
    expect(text).toContain('organization_id = $1');
    expect(text).toContain('actor_id = $2');
    expect(text).toContain('action = $3');
    expect(text).toContain('resource_type = $4');
    expect(text).toContain('resource_id = $5');
    expect(text).toContain('"timestamp" >= $6');
    expect(text).toContain('"timestamp" <= $7');
    expect(text).toContain('LIMIT $8');
    expect(text).toContain('OFFSET $9');
    expect(params).toEqual([
      'org-1',
      'user-9',
      'access.denied',
      'document',
      'doc-7',
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T23:59:59.000Z',
      50,
      10,
    ]);
  });

  it('omits unspecified dimensions so they do not constrain the result', async () => {
    const { service, sql } = makeService();
    sql.queueRows([]);

    await service.query({ organizationId: 'org-1', action: 'role.change' });

    const { text } = sql.last;
    expect(text).toContain('action = $2');
    expect(text).not.toContain('actor_id =');
    expect(text).not.toContain('resource_type =');
    expect(text).not.toContain('"timestamp" >=');
  });

  it('maps returned rows to domain records (including JSONB metadata)', async () => {
    const { service, sql } = makeService();
    sql.queueRows([
      {
        id: 'a-1',
        organization_id: 'org-1',
        actor_id: 'user-1',
        action: 'access.denied',
        resource_type: 'document',
        resource_id: 'doc-1',
        ip: '203.0.113.7',
        user_agent: 'agent',
        timestamp: '2026-06-02T12:00:00.000Z',
        metadata: JSON.stringify({ reason: 'no_grant' }),
      },
    ]);

    const [record] = await service.query({ organizationId: 'org-1' });

    expect(record).toEqual({
      id: 'a-1',
      organizationId: 'org-1',
      actorId: 'user-1',
      action: 'access.denied',
      resourceType: 'document',
      resourceId: 'doc-1',
      ip: '203.0.113.7',
      userAgent: 'agent',
      timestamp: '2026-06-02T12:00:00.000Z',
      metadata: { reason: 'no_grant' },
    });
  });

  it('rejects a query without an organization scope', async () => {
    const { service, sql } = makeService();
    await expect(service.query({ organizationId: '' })).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
    expect(sql.queries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retention — 7-year window (Req 37.4).
// ---------------------------------------------------------------------------

describe('Audit retention policy (Req 37.4)', () => {
  it('declares a 7-year window', () => {
    expect(AUDIT_RETENTION_YEARS).toBe(7);
    expect(AUDIT_RETENTION_POLICY.years).toBe(7);
  });

  it('computes a cutoff exactly 7 years before the reference instant', () => {
    const cutoff = auditRetentionCutoff(new Date('2026-06-02T00:00:00.000Z'));
    expect(cutoff).toBe('2019-06-02T00:00:00.000Z');
  });

  it('classifies records on/after the cutoff as within retention', () => {
    const now = new Date('2026-06-02T00:00:00.000Z');
    expect(isWithinAuditRetention('2019-06-02T00:00:00.000Z', now)).toBe(true); // exactly on cutoff
    expect(isWithinAuditRetention('2026-06-01T00:00:00.000Z', now)).toBe(true);
    expect(isWithinAuditRetention('2019-06-01T23:59:59.000Z', now)).toBe(false); // just past
    expect(isWithinAuditRetention('2010-01-01T00:00:00.000Z', now)).toBe(false);
  });

  it('exposes the retention policy on the service', () => {
    const { service } = makeService();
    expect(service.retention.years).toBe(7);
  });

  it('expiredBefore lists only records older than 7 years and never deletes', async () => {
    const { service, sql } = makeService('2026-06-02T00:00:00.000Z');
    sql.queueRows([
      { id: 'old', organization_id: 'org-1', actor_id: 'u', action: 'a', resource_type: 'project', resource_id: 'x', ip: '', user_agent: '', timestamp: '2010-01-01T00:00:00.000Z', metadata: '{}' },
      { id: 'fresh', organization_id: 'org-1', actor_id: 'u', action: 'a', resource_type: 'project', resource_id: 'y', ip: '', user_agent: '', timestamp: '2025-01-01T00:00:00.000Z', metadata: '{}' },
    ]);

    const expired = await service.expiredBefore('org-1');

    expect(expired.map((r) => r.id)).toEqual(['old']);
    // expiredBefore reads only — no UPDATE/DELETE is ever issued.
    expect(sql.queries.every((q) => /^SELECT/.test(q.text))).toBe(true);
  });
});
