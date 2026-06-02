/**
 * Property 1 — Tenant isolation: no query crosses an Organization boundary.
 *
 * Feature: auxify-ai-platform, Property 1: Tenant isolation — no query crosses
 * an Organization boundary.
 * Validates: Requirements 1.4
 *
 * Where the companion `tenant-scoping.property.test.ts` proves the *shape* of
 * every emitted statement (each SQL text carries an `organization_id` predicate
 * bound to the context), this test proves the *end-to-end behaviour* the design
 * promises (design "Multi-Tenancy Model", Req 1.4): for ANY arbitrary
 * multi-organization dataset and ANY query issued through the repository layer,
 * a query in Organization A's {@link TenantContext} returns ONLY org-A rows and
 * can never read, mutate, or attach to an org-B row.
 *
 * To exercise the repository's scoping for real (rather than trivially
 * partitioning by org outside the SQL), the test runs the repositories against
 * an {@link InMemoryTenantDatabase} — a fake {@link SqlClient} that holds a
 * multi-tenant dataset and FAITHFULLY interprets the exact SQL the repository
 * emits: it reads the Organization value from the statement's *bound parameters*
 * (the `$n` placeholders) and applies the same `organization_id = $n` direct
 * predicate and `fk IN (SELECT id FROM parent WHERE organization_id = $n)`
 * parent predicate the base repository (and the RLS migration) produce. The
 * isolation guarantee therefore comes from the repository's own predicate, not
 * from the harness.
 *
 * The test additionally asserts (complementing the application-layer proof) that
 * the RLS migration 0015 covers the tables exercised here, mirroring the
 * database-enforcement arm of the same invariant.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { loadMigrations } from '../db/migrations.js';
import type { SqlClient, SqlQueryResult, SqlRow } from '../storage/pgvector.js';
import { ConversationRepository, CrossTenantReferenceError, MessageRepository } from './index.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

/** Fixed timestamp used for seeded/inserted rows (values are never asserted). */
const TS = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// A faithful in-memory SqlClient that interprets the repository's emitted SQL.
//
// It understands exactly the statement shapes the base repository produces for
// the conversations (direct scope) and messages (parent scope) tables, and
// enforces the Organization predicate by reading the bound `$n` parameters —
// the same way PostgreSQL + RLS would.
// ---------------------------------------------------------------------------

/** Resolve a `$n` placeholder against the positional parameter array. */
function resolveParam(placeholder: string, params: readonly unknown[]): unknown {
  return params[Number.parseInt(placeholder.slice(1), 10) - 1];
}

/** Split a SQL conjunction on top-level ` AND ` (ignoring parenthesised subqueries). */
function splitTopLevelAnd(condition: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < condition.length; i += 1) {
    const ch = condition[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth === 0 && condition.startsWith(' AND ', i)) {
      parts.push(current);
      current = '';
      i += ' AND '.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const EQUALITY_RE = /^(\w+)\s*=\s*(\$\d+)$/;
const MEMBERSHIP_RE = /^(\w+) IN \(SELECT (\w+) FROM (\w+) WHERE (\w+)\s*=\s*(\$\d+)\)$/;

const DIRECT_INSERT_RE = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\) RETURNING \*$/;
const PARENT_INSERT_RE =
  /^INSERT INTO (\w+) \(([^)]+)\) SELECT (.+?) WHERE EXISTS \(SELECT 1 FROM (\w+) WHERE (\w+)\s*=\s*(\$\d+) AND (\w+)\s*=\s*(\$\d+)\) RETURNING \*$/;
const SELECT_RE = /^SELECT \* FROM (\w+) WHERE ([\s\S]+)$/;
const UPDATE_RE = /^UPDATE (\w+) SET ([\s\S]+) RETURNING \*$/;
const DELETE_RE = /^DELETE FROM (\w+) WHERE ([\s\S]+) RETURNING (\w+)$/;

/**
 * An in-memory, multi-tenant database that enforces exactly the tenant
 * predicate carried by the repository's SQL. Tables are `id → row` maps; the
 * `id` column is the primary key for every table this test exercises.
 */
class InMemoryTenantDatabase implements SqlClient {
  private readonly tables = new Map<string, Map<string, SqlRow>>();

  /** Seed ground-truth rows for a table (models pre-existing DB content). */
  seed(table: string, rows: SqlRow[]): void {
    const map = this.table(table);
    for (const row of rows) map.set(String(row.id), { ...row });
  }

  /** Read a stored row by id (for asserting a foreign row was untouched). */
  getRow(table: string, id: string): SqlRow | undefined {
    return this.tables.get(table)?.get(id);
  }

  /** Count stored rows in a table (for asserting no write occurred). */
  count(table: string): number {
    return this.tables.get(table)?.size ?? 0;
  }

  private table(name: string): Map<string, SqlRow> {
    let map = this.tables.get(name);
    if (map === undefined) {
      map = new Map<string, SqlRow>();
      this.tables.set(name, map);
    }
    return map;
  }

  async query(text: string, params: unknown[] = []): Promise<SqlQueryResult> {
    const sql = text.trim().replace(/\s+/g, ' ');

    const parentInsert = PARENT_INSERT_RE.exec(sql);
    if (parentInsert) return this.runParentInsert(parentInsert, params);

    const directInsert = DIRECT_INSERT_RE.exec(sql);
    if (directInsert) return this.runDirectInsert(directInsert, params);

    const select = SELECT_RE.exec(sql);
    if (select) return this.runSelect(select, params);

    const update = UPDATE_RE.exec(sql);
    if (update) return this.runUpdate(update, params);

    const del = DELETE_RE.exec(sql);
    if (del) return this.runDelete(del, params);

    throw new Error(`InMemoryTenantDatabase: unsupported statement: ${sql}`);
  }

  /** Evaluate a single conjunct (`col = $n` or the parent membership subquery). */
  private matchesConjunct(conjunct: string, params: readonly unknown[], row: SqlRow): boolean {
    const eq = EQUALITY_RE.exec(conjunct);
    if (eq) {
      return row[eq[1]!] === resolveParam(eq[2]!, params);
    }
    const member = MEMBERSHIP_RE.exec(conjunct);
    if (member) {
      const [, column, subIdColumn, subTable, subTenantColumn, placeholder] = member;
      const tenantValue = resolveParam(placeholder!, params);
      const parentMap = this.tables.get(subTable!);
      const allowedIds = new Set<unknown>();
      if (parentMap) {
        for (const parentRow of parentMap.values()) {
          if (parentRow[subTenantColumn!] === tenantValue) {
            allowedIds.add(parentRow[subIdColumn!]);
          }
        }
      }
      return allowedIds.has(row[column!]);
    }
    if (conjunct === 'FALSE') return false;
    throw new Error(`InMemoryTenantDatabase: unsupported predicate: ${conjunct}`);
  }

  private matchesWhere(whereBody: string, params: readonly unknown[], row: SqlRow): boolean {
    return splitTopLevelAnd(whereBody).every((c) => this.matchesConjunct(c, params, row));
  }

  /** Strip trailing ORDER BY / LIMIT / OFFSET clauses, leaving only the WHERE body. */
  private static whereBodyOf(rest: string): string {
    let body = rest;
    for (const keyword of [' ORDER BY ', ' LIMIT ', ' OFFSET ']) {
      const idx = body.indexOf(keyword);
      if (idx !== -1) body = body.slice(0, idx);
    }
    return body.trim();
  }

  private runDirectInsert(match: RegExpExecArray, params: unknown[]): SqlQueryResult {
    const [, table, columnList, placeholderList] = match;
    const columns = columnList!.split(',').map((s) => s.trim());
    const placeholders = placeholderList!.split(',').map((s) => s.trim());
    const row: SqlRow = {};
    columns.forEach((column, i) => {
      row[column] = resolveParam(placeholders[i]!, params);
    });
    if (!('created_at' in row)) row.created_at = TS;
    if (table === 'conversations' && !('updated_at' in row)) row.updated_at = TS;
    this.table(table!).set(String(row.id), row);
    return { rows: [{ ...row }] };
  }

  private runParentInsert(match: RegExpExecArray, params: unknown[]): SqlQueryResult {
    const [
      ,
      table,
      columnList,
      valueList,
      parentTable,
      parentIdColumn,
      parentIdPlaceholder,
      parentTenantColumn,
      parentTenantPlaceholder,
    ] = match;
    const fkValue = resolveParam(parentIdPlaceholder!, params);
    const tenantValue = resolveParam(parentTenantPlaceholder!, params);

    const parentMap = this.tables.get(parentTable!);
    const exists =
      parentMap !== undefined &&
      [...parentMap.values()].some(
        (parentRow) =>
          parentRow[parentIdColumn!] === fkValue && parentRow[parentTenantColumn!] === tenantValue,
      );
    // The EXISTS guard matched nothing → the repository raises
    // CrossTenantReferenceError (a child can never attach to a foreign parent).
    if (!exists) return { rows: [] };

    const columns = columnList!.split(',').map((s) => s.trim());
    const values = valueList!.split(',').map((s) => s.trim());
    const row: SqlRow = {};
    columns.forEach((column, i) => {
      row[column] = resolveParam(values[i]!, params);
    });
    if (!('created_at' in row)) row.created_at = TS;
    this.table(table!).set(String(row.id), row);
    return { rows: [{ ...row }] };
  }

  private runSelect(match: RegExpExecArray, params: unknown[]): SqlQueryResult {
    const [, table, rest] = match;
    const whereBody = InMemoryTenantDatabase.whereBodyOf(rest!);
    const map = this.tables.get(table!);
    if (map === undefined) return { rows: [] };
    const rows = [...map.values()]
      .filter((row) => this.matchesWhere(whereBody, params, row))
      .map((row) => ({ ...row }));
    return { rows };
  }

  private runUpdate(match: RegExpExecArray, params: unknown[]): SqlQueryResult {
    const [, table, body] = match;
    const whereIdx = body!.indexOf(' WHERE ');
    const setClause = body!.slice(0, whereIdx);
    const whereBody = body!.slice(whereIdx + ' WHERE '.length);
    const assignments = setClause.split(',').map((piece) => {
      const eq = EQUALITY_RE.exec(piece.trim());
      if (!eq) throw new Error(`InMemoryTenantDatabase: bad SET assignment: ${piece}`);
      return { column: eq[1]!, placeholder: eq[2]! };
    });
    const map = this.tables.get(table!);
    if (map === undefined) return { rows: [] };
    const matched = [...map.values()].filter((row) => this.matchesWhere(whereBody, params, row));
    for (const row of matched) {
      for (const { column, placeholder } of assignments) {
        row[column] = resolveParam(placeholder, params);
      }
    }
    return { rows: matched.map((row) => ({ ...row })) };
  }

  private runDelete(match: RegExpExecArray, params: unknown[]): SqlQueryResult {
    const [, table, whereBody, idColumn] = match;
    const map = this.tables.get(table!);
    if (map === undefined) return { rows: [] };
    const matched = [...map.values()].filter((row) => this.matchesWhere(whereBody!, params, row));
    for (const row of matched) map.delete(String(row.id));
    return { rows: matched.map((row) => ({ [idColumn!]: row[idColumn!] })) };
  }
}

// ---------------------------------------------------------------------------
// Generators: an arbitrary dataset spanning multiple Organizations.
// ---------------------------------------------------------------------------

interface Dataset {
  orgIds: string[];
  conversations: SqlRow[];
  messages: SqlRow[];
}

/** Build conversation/message rows with globally unique ids (PK semantics). */
function buildDataset(orgIds: string[], conversationsPerOrg: number[][]): Dataset {
  const conversations: SqlRow[] = [];
  const messages: SqlRow[] = [];

  orgIds.forEach((organizationId, orgIndex) => {
    const messageCounts = conversationsPerOrg[orgIndex]!;
    messageCounts.forEach((messageCount, convIndex) => {
      const conversationId = `conv_${orgIndex}_${convIndex}`;
      conversations.push({
        id: conversationId,
        organization_id: organizationId,
        project_id: `proj_${orgIndex}`,
        owner_id: `user_${orgIndex}`,
        title: `title_${orgIndex}_${convIndex}`,
        folder_id: null,
        archived: false,
        share_token: null,
        share_mode: null,
        persona_id: null,
        active_model_id: null,
        created_at: TS,
        updated_at: TS,
      });
      for (let k = 0; k < messageCount; k += 1) {
        messages.push({
          id: `msg_${orgIndex}_${convIndex}_${k}`,
          conversation_id: conversationId,
          parent_id: null,
          role: 'user',
          content: '[]',
          model: null,
          input_tokens: null,
          output_tokens: null,
          cost: null,
          latency_ms: null,
          rating: null,
          pinned: false,
          attachments: '[]',
          created_at: TS,
        });
      }
    });
  });

  return { orgIds, conversations, messages };
}

const datasetArb: fc.Arbitrary<Dataset> = fc
  .uniqueArray(
    fc.string({ minLength: 1, maxLength: 6 }).map((s) => `org_${s}`),
    { minLength: 2, maxLength: 4 },
  )
  .chain((orgIds) =>
    fc
      .tuple(
        ...orgIds.map(() =>
          // Each org: 1..3 conversations, each with 0..3 messages.
          fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 3 }),
        ),
      )
      .map((conversationsPerOrg) => buildDataset(orgIds, conversationsPerOrg as number[][])),
  );

// ---------------------------------------------------------------------------
// Property 1.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 1: Tenant isolation — no query crosses an Organization boundary', () => {
  it('a query under org A reads/mutates only org-A rows and never an org-B row, for any multi-org dataset (Validates: Requirements 1.4)', async () => {
    await fc.assert(
      fc.asyncProperty(datasetArb, async (dataset) => {
        const db = new InMemoryTenantDatabase();
        db.seed('conversations', dataset.conversations);
        db.seed('messages', dataset.messages);

        const conversationRepo = new ConversationRepository(db);
        const messageRepo = new MessageRepository(db);

        const conversationById = new Map(
          dataset.conversations.map((c) => [String(c.id), c] as const),
        );

        for (const actorOrg of dataset.orgIds) {
          const ctx: TenantContext = { organizationId: actorOrg, userId: `${actorOrg}_user` };

          // 1. findById on a direct-scoped table: an org-A read returns the row
          //    iff it belongs to org A — even when the id exists under org B.
          for (const conv of dataset.conversations) {
            const found = await conversationRepo.findById(ctx, String(conv.id));
            if (conv.organization_id === actorOrg) {
              expect(found).not.toBeNull();
              expect(found?.id).toBe(conv.id);
              expect(found?.organizationId).toBe(actorOrg);
            } else {
              expect(found).toBeNull();
            }
          }

          // 2. list returns exactly org-A's conversations and nothing foreign.
          const listed = await conversationRepo.list(ctx);
          const listedIds = new Set(listed.map((c) => c.id));
          const expectedIds = new Set(
            dataset.conversations
              .filter((c) => c.organization_id === actorOrg)
              .map((c) => String(c.id)),
          );
          expect(listedIds).toEqual(expectedIds);
          for (const c of listed) expect(c.organizationId).toBe(actorOrg);

          // 3. Parent-scoped reads: a message is reachable under org A iff its
          //    owning conversation belongs to org A.
          for (const msg of dataset.messages) {
            const owningConv = conversationById.get(String(msg.conversation_id))!;
            const found = await messageRepo.findById(ctx, String(msg.id));
            if (owningConv.organization_id === actorOrg) {
              expect(found?.id).toBe(msg.id);
            } else {
              expect(found).toBeNull();
            }
          }
          for (const conv of dataset.conversations) {
            const msgs = await messageRepo.listByConversation(ctx, String(conv.id));
            if (conv.organization_id === actorOrg) {
              const expectedMsgIds = new Set(
                dataset.messages
                  .filter((m) => m.conversation_id === conv.id)
                  .map((m) => String(m.id)),
              );
              expect(new Set(msgs.map((m) => m.id))).toEqual(expectedMsgIds);
            } else {
              // A query under org A cannot reach messages whose conversation
              // belongs to org B.
              expect(msgs).toEqual([]);
            }
          }

          // 4. Cross-tenant mutation cannot affect an org-B row. (Every actor
          //    has a foreign conversation, since there are >= 2 orgs each with
          //    >= 1 conversation.)
          const foreignConv = dataset.conversations.find((c) => c.organization_id !== actorOrg)!;
          const foreignId = String(foreignConv.id);
          const titleBefore = db.getRow('conversations', foreignId)?.title;

          const updated = await conversationRepo.update(ctx, foreignId, { title: 'HACKED' });
          expect(updated).toBeNull();
          expect(db.getRow('conversations', foreignId)?.title).toBe(titleBefore);

          const deleted = await conversationRepo.delete(ctx, foreignId);
          expect(deleted).toBe(false);
          expect(db.getRow('conversations', foreignId)).toBeDefined();

          // 5. Inserting a message that references an org-B conversation under
          //    org A's context is rejected and writes nothing.
          const messagesBefore = db.count('messages');
          await expect(
            messageRepo.create(ctx, {
              id: `intruder_${actorOrg}`,
              conversationId: foreignId,
              role: 'user',
            }),
          ).rejects.toBeInstanceOf(CrossTenantReferenceError);
          expect(db.count('messages')).toBe(messagesBefore);

          // 6. Positive controls: a conversation created under org A is visible
          //    to A and invisible to any other org, and a message can attach to
          //    A's own conversation.
          const newConvId = `new_${actorOrg}`;
          await conversationRepo.create(ctx, {
            id: newConvId,
            projectId: 'proj_new',
            ownerId: ctx.userId,
            title: 'mine',
          });
          expect((await conversationRepo.findById(ctx, newConvId))?.id).toBe(newConvId);

          const otherOrg = dataset.orgIds.find((o) => o !== actorOrg)!;
          const otherCtx: TenantContext = { organizationId: otherOrg, userId: `${otherOrg}_user` };
          expect(await conversationRepo.findById(otherCtx, newConvId)).toBeNull();

          const ownConv = dataset.conversations.find((c) => c.organization_id === actorOrg)!;
          const inserted = await messageRepo.create(ctx, {
            id: `m_new_${actorOrg}`,
            conversationId: String(ownConv.id),
            role: 'user',
          });
          expect(inserted.conversationId).toBe(String(ownConv.id));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Complementary assertion: the database-enforcement arm (RLS migration 0015)
  // covers the same tables this property exercises (Req 1.4).
  it('RLS migration 0015 enforces tenant isolation on the conversations and messages tables (Validates: Requirements 1.4)', () => {
    const rls = loadMigrations().find((m) => m.id.endsWith('row_level_security'));
    expect(rls).toBeDefined();
    const sql = rls!.sql;

    // conversations: direct organization_id scoping, forced for all roles.
    expect(sql).toContain('ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE conversations FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('CREATE POLICY conversations_tenant_isolation ON conversations');

    // messages: scoped through the parent conversation, forced for all roles.
    expect(sql).toContain('ALTER TABLE messages ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE messages FORCE ROW LEVEL SECURITY;');
    expect(sql).toMatch(
      /messages_tenant_isolation[\s\S]*conversation_id IN \(\s*SELECT id FROM conversations/,
    );
  });
});
