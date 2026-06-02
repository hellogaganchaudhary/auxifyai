/**
 * Property + unit tests for cascade-delete semantics of the Primary_Database
 * schema (Req 44.8 / Property 58).
 *
 * Feature: auxify-ai-platform, Property 58: Parent deletion cascades with no
 * orphans.
 *
 * There is no live database in this environment, so the schema's declared
 * foreign-key semantics are the source of truth: every `ON DELETE CASCADE` /
 * `ON DELETE SET NULL` clause is parsed directly from the migration SQL under
 * `./migrations`. From those edges we build an in-memory foreign-key graph,
 * generate arbitrary populated datasets, simulate a PostgreSQL cascade delete,
 * and assert the no-orphan invariant plus the SET NULL detach behavior.
 *
 * Because the edge set is parsed from the migrations themselves, the test stays
 * faithful to the actual schema: if a containment edge were ever switched from
 * CASCADE to SET NULL (or vice-versa), the classification test below fails and
 * the simulated semantics change accordingly.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { loadMigrations } from './migrations.js';

// ---------------------------------------------------------------------------
// Foreign-key graph parsed from the migration SQL (the source of truth).
// ---------------------------------------------------------------------------

/** ON DELETE actions we expect the schema to declare. */
type OnDelete = 'CASCADE' | 'SET NULL';

/** A foreign-key edge: child.column references parent.column with an action. */
interface FkEdge {
  readonly childTable: string;
  readonly childColumn: string;
  readonly parentTable: string;
  readonly parentColumn: string;
  readonly action: OnDelete;
  /** Whether the child column is NOT NULL (a mandatory reference). */
  readonly notNull: boolean;
}

/**
 * Strip `--` line comments. Migration comments contain commas and sit directly
 * above column definitions, which would otherwise corrupt both the top-level
 * comma split and the column-name extraction below.
 */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Extract every `CREATE TABLE IF NOT EXISTS <name> ( ... )` block body. */
function extractCreateTableBlocks(sql: string): { table: string; body: string }[] {
  const blocks: { table: string; body: string }[] = [];
  const header = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(sql)) !== null) {
    const table = match[1]!;
    const open = header.lastIndex - 1; // index of the opening '('
    let depth = 0;
    let i = open;
    for (; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push({ table, body: sql.slice(open + 1, i) });
  }
  return blocks;
}

/** Split a table body into top-level (depth-0) comma-separated definitions. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

const FK_RE =
  /REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)\s*ON\s+DELETE\s+(CASCADE|SET\s+NULL|NO\s+ACTION|RESTRICT|SET\s+DEFAULT)/i;

/** Parse a single inline foreign-key column definition, if it is one. */
function parseFk(childTable: string, part: string): FkEdge | null {
  const ref = FK_RE.exec(part);
  if (!ref) return null;
  const col = /^\s*"?(\w+)"?/.exec(part);
  if (!col) return null;
  const action = ref[3]!.toUpperCase().replace(/\s+/g, ' ');
  return {
    childTable,
    childColumn: col[1]!,
    parentTable: ref[1]!,
    parentColumn: ref[2]!,
    action: action as OnDelete,
    notNull: /\bNOT\s+NULL\b/i.test(part),
  };
}

/** Parse every foreign-key edge declared across all migrations. */
function parseForeignKeys(): FkEdge[] {
  const edges: FkEdge[] = [];
  for (const migration of loadMigrations()) {
    const sql = stripLineComments(migration.sql);
    for (const { table, body } of extractCreateTableBlocks(sql)) {
      for (const part of splitTopLevel(body)) {
        const fk = parseFk(table, part);
        if (fk) edges.push(fk);
      }
    }
  }
  return edges;
}

const EDGES: FkEdge[] = parseForeignKeys();

/** All tables that participate in the foreign-key graph. */
const TABLES: string[] = [...new Set(EDGES.flatMap((e) => [e.childTable, e.parentTable]))];

/** Foreign-key edges grouped by their owning (child) table. */
const FK_BY_TABLE = new Map<string, FkEdge[]>();
for (const edge of EDGES) {
  const list = FK_BY_TABLE.get(edge.childTable) ?? [];
  list.push(edge);
  FK_BY_TABLE.set(edge.childTable, list);
}

/** Look up the declared ON DELETE action for a child column (test helper). */
function actionOf(childTable: string, childColumn: string): OnDelete {
  const edge = EDGES.find((e) => e.childTable === childTable && e.childColumn === childColumn);
  if (!edge) {
    throw new Error(`No FK on ${childTable}.${childColumn}`);
  }
  return edge.action;
}

/**
 * Order tables so every table appears after the parents it references
 * (ignoring self-references). The schema has no cross-table FK cycles, so a
 * Kahn-style topological sort always terminates.
 */
function topoOrderTables(): string[] {
  const deps = new Map<string, Set<string>>();
  for (const t of TABLES) deps.set(t, new Set());
  for (const e of EDGES) {
    if (e.childTable !== e.parentTable) deps.get(e.childTable)!.add(e.parentTable);
  }
  const order: string[] = [];
  const remaining = new Set(TABLES);
  while (remaining.size > 0) {
    let progressed = false;
    for (const t of [...remaining]) {
      const ready = [...deps.get(t)!].every((p) => !remaining.has(p));
      if (ready) {
        order.push(t);
        remaining.delete(t);
        progressed = true;
      }
    }
    if (!progressed) {
      throw new Error('Unexpected FK cycle across tables');
    }
  }
  return order;
}

const TABLE_ORDER: string[] = topoOrderTables();

// ---------------------------------------------------------------------------
// In-memory dataset model + cascade-delete simulation.
// ---------------------------------------------------------------------------

/** A concrete foreign-key value held by a row. */
interface FkValue {
  readonly parentTable: string;
  value: string | null;
  readonly action: OnDelete;
}

/** A row: a stable id plus the value of each of its foreign keys. */
interface Row {
  readonly table: string;
  readonly id: string;
  readonly fk: Record<string, FkValue>;
}

/** Global identity of a row, used as a Set/Map key. */
function rowKey(table: string, id: string): string {
  return `${table}\u0000${id}`;
}

/**
 * A deterministic "entropy tape": a finite list of integers consumed in order
 * (wrapping when exhausted). fast-check supplies the tape so generated datasets
 * are reproducible and shrinkable.
 */
class Tape {
  private cursor = 0;
  constructor(private readonly values: number[]) {}
  /** Return a value in `[0, bound)`. */
  next(bound: number): number {
    if (bound <= 0) return 0;
    const v = this.values[this.cursor % this.values.length]!;
    this.cursor += 1;
    return v % bound;
  }
}

const MAX_ROWS_PER_TABLE = 4;

/**
 * Build an arbitrary, referentially-valid dataset. Tables are populated in
 * topological order so a child can only reference parents that already exist;
 * self-references point to strictly-earlier rows of the same table, which keeps
 * every self-referential tree a finite forest.
 */
function buildDataset(tape: Tape): Row[] {
  const idsByTable = new Map<string, string[]>();
  const rows: Row[] = [];
  for (const t of TABLE_ORDER) idsByTable.set(t, []);

  for (const table of TABLE_ORDER) {
    const fks = FK_BY_TABLE.get(table) ?? [];
    const count = tape.next(MAX_ROWS_PER_TABLE + 1); // 0..MAX_ROWS_PER_TABLE
    for (let i = 0; i < count; i++) {
      const fkValues: Record<string, FkValue> = {};
      let skip = false;
      for (const fk of fks) {
        const candidates =
          fk.parentTable === table
            ? [...idsByTable.get(table)!] // only earlier rows of this table
            : (idsByTable.get(fk.parentTable) ?? []);
        const canBeNull = !fk.notNull;
        if (candidates.length === 0) {
          if (canBeNull) {
            fkValues[fk.childColumn] = {
              parentTable: fk.parentTable,
              value: null,
              action: fk.action,
            };
            continue;
          }
          // Mandatory reference with no available parent: this row cannot exist.
          skip = true;
          break;
        }
        // Nullable references are sometimes left null to exercise SET NULL.
        if (canBeNull && tape.next(3) === 0) {
          fkValues[fk.childColumn] = {
            parentTable: fk.parentTable,
            value: null,
            action: fk.action,
          };
        } else {
          const chosen = candidates[tape.next(candidates.length)]!;
          fkValues[fk.childColumn] = {
            parentTable: fk.parentTable,
            value: chosen,
            action: fk.action,
          };
        }
      }
      if (skip) continue;
      const id = `${table}#${i}`;
      rows.push({ table, id, fk: fkValues });
      idsByTable.get(table)!.push(id);
    }
  }
  return rows;
}

/** Result of simulating a cascade delete. */
interface DeleteResult {
  /** Global keys of every row removed (CASCADE transitive closure). */
  readonly deleted: Set<string>;
  /** Surviving rows whose SET NULL pointer was detached (column -> null). */
  readonly nulled: { row: Row; column: string }[];
}

/**
 * Simulate PostgreSQL `DELETE` of a single target row under the parsed FK
 * semantics: CASCADE edges propagate the delete to children (transitively),
 * SET NULL edges detach surviving children by nulling the referencing column.
 */
function simulateDelete(rows: Row[], target: Row): DeleteResult {
  // Reverse adjacency: parentKey -> referencing { row, column, action }.
  const reverse = new Map<string, { row: Row; column: string; action: OnDelete }[]>();
  for (const row of rows) {
    for (const [column, fkv] of Object.entries(row.fk)) {
      if (fkv.value === null) continue;
      const pk = rowKey(fkv.parentTable, fkv.value);
      const list = reverse.get(pk) ?? [];
      list.push({ row, column, action: fkv.action });
      reverse.set(pk, list);
    }
  }

  // CASCADE closure from the target.
  const deleted = new Set<string>();
  const stack = [rowKey(target.table, target.id)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (deleted.has(current)) continue;
    deleted.add(current);
    for (const dep of reverse.get(current) ?? []) {
      if (dep.action === 'CASCADE') {
        const depKey = rowKey(dep.row.table, dep.row.id);
        if (!deleted.has(depKey)) stack.push(depKey);
      }
    }
  }

  // SET NULL detach pass for rows that survive but reference a deleted parent.
  const nulled: { row: Row; column: string }[] = [];
  for (const row of rows) {
    if (deleted.has(rowKey(row.table, row.id))) continue;
    for (const [column, fkv] of Object.entries(row.fk)) {
      if (fkv.value === null) continue;
      if (!deleted.has(rowKey(fkv.parentTable, fkv.value))) continue;
      if (fkv.action === 'SET NULL') {
        fkv.value = null;
        nulled.push({ row, column });
      }
    }
  }

  return { deleted, nulled };
}

// ---------------------------------------------------------------------------
// Schema classification (unit tests).
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, cascade-delete schema (Req 44.8)', () => {
  it('parses a foreign-key graph from the migrations', () => {
    expect(EDGES.length).toBeGreaterThan(20);
    expect(TABLES).toContain('organizations');
    expect(TABLES).toContain('messages');
  });

  it('declares only CASCADE or SET NULL — never a delete-blocking action', () => {
    for (const edge of EDGES) {
      expect(['CASCADE', 'SET NULL']).toContain(edge.action);
    }
  });

  it('uses SET NULL only for the documented non-containment references', () => {
    const setNull = EDGES.filter((e) => e.action === 'SET NULL')
      .map((e) => `${e.childTable}.${e.childColumn} -> ${e.parentTable}`)
      .sort();
    expect(setNull).toEqual([
      'documents.folder_id -> folders',
      'invitations.accepted_user_id -> users',
      'invitations.invited_by -> users',
      'knowledge_documents.duplicate_of -> knowledge_documents',
    ]);
  });

  it('cascades tenancy containment, owner/aggregate, and self-referential trees', () => {
    // Tenancy containment.
    expect(actionOf('teams', 'organization_id')).toBe('CASCADE');
    expect(actionOf('projects', 'team_id')).toBe('CASCADE');
    expect(actionOf('conversations', 'project_id')).toBe('CASCADE');
    // Owner / aggregate edges.
    expect(actionOf('messages', 'conversation_id')).toBe('CASCADE');
    expect(actionOf('agent_runs', 'agent_id')).toBe('CASCADE');
    expect(actionOf('agent_steps', 'run_id')).toBe('CASCADE');
    expect(actionOf('knowledge_chunks', 'document_id')).toBe('CASCADE');
    // Self-referential trees.
    expect(actionOf('messages', 'parent_id')).toBe('CASCADE');
    expect(actionOf('knowledge_pages', 'parent_id')).toBe('CASCADE');
    expect(actionOf('channel_messages', 'parent_id')).toBe('CASCADE');
    expect(actionOf('folders', 'parent_id')).toBe('CASCADE');
  });
});

// ---------------------------------------------------------------------------
// Concrete cascade scenarios (unit tests).
// ---------------------------------------------------------------------------

/** Construct a row whose FK actions are taken from the parsed schema. */
function makeRow(
  table: string,
  id: string,
  refs: Record<string, { parentTable: string; value: string | null }>,
): Row {
  const fk: Record<string, FkValue> = {};
  for (const [column, ref] of Object.entries(refs)) {
    fk[column] = { ...ref, action: actionOf(table, column) };
  }
  return { table, id, fk };
}

describe('Feature: auxify-ai-platform, cascade-delete scenarios (Req 44.8)', () => {
  it('removes the whole tenancy + conversation subtree when an organization is deleted', () => {
    const org = makeRow('organizations', 'o1', {});
    const team = makeRow('teams', 't1', {
      organization_id: { parentTable: 'organizations', value: 'o1' },
    });
    const user = makeRow('users', 'u1', {
      organization_id: { parentTable: 'organizations', value: 'o1' },
    });
    const project = makeRow('projects', 'p1', {
      organization_id: { parentTable: 'organizations', value: 'o1' },
      team_id: { parentTable: 'teams', value: 't1' },
    });
    const conversation = makeRow('conversations', 'c1', {
      organization_id: { parentTable: 'organizations', value: 'o1' },
      project_id: { parentTable: 'projects', value: 'p1' },
      owner_id: { parentTable: 'users', value: 'u1' },
    });
    const m1 = makeRow('messages', 'm1', {
      conversation_id: { parentTable: 'conversations', value: 'c1' },
      parent_id: { parentTable: 'messages', value: null },
    });
    const m2 = makeRow('messages', 'm2', {
      conversation_id: { parentTable: 'conversations', value: 'c1' },
      parent_id: { parentTable: 'messages', value: 'm1' },
    });
    const rows = [org, team, user, project, conversation, m1, m2];

    const { deleted } = simulateDelete(rows, org);

    // Every row transitively owned by the organization is gone — no orphan.
    expect(deleted.size).toBe(rows.length);
    for (const row of rows) {
      expect(deleted.has(rowKey(row.table, row.id))).toBe(true);
    }
  });

  it('removes only the descending branch when a message subtree root is deleted', () => {
    const conversation = makeRow('conversations', 'c1', {
      organization_id: { parentTable: 'organizations', value: 'o1' },
      project_id: { parentTable: 'projects', value: 'p1' },
      owner_id: { parentTable: 'users', value: 'u1' },
    });
    const root = makeRow('messages', 'm1', {
      conversation_id: { parentTable: 'conversations', value: 'c1' },
      parent_id: { parentTable: 'messages', value: null },
    });
    const child = makeRow('messages', 'm2', {
      conversation_id: { parentTable: 'conversations', value: 'c1' },
      parent_id: { parentTable: 'messages', value: 'm1' },
    });
    const grandchild = makeRow('messages', 'm3', {
      conversation_id: { parentTable: 'conversations', value: 'c1' },
      parent_id: { parentTable: 'messages', value: 'm2' },
    });
    const sibling = makeRow('messages', 's1', {
      conversation_id: { parentTable: 'conversations', value: 'c1' },
      parent_id: { parentTable: 'messages', value: null },
    });
    const rows = [conversation, root, child, grandchild, sibling];

    const { deleted } = simulateDelete(rows, root);

    // The branch under m1 is removed; the conversation and sibling survive.
    expect(deleted.has(rowKey('messages', 'm1'))).toBe(true);
    expect(deleted.has(rowKey('messages', 'm2'))).toBe(true);
    expect(deleted.has(rowKey('messages', 'm3'))).toBe(true);
    expect(deleted.has(rowKey('messages', 's1'))).toBe(false);
    expect(deleted.has(rowKey('conversations', 'c1'))).toBe(false);
  });

  it('detaches (SET NULL) a document when its folder is deleted, without deleting the document', () => {
    const folder = makeRow('folders', 'f1', {
      organization_id: { parentTable: 'organizations', value: 'o1' },
      project_id: { parentTable: 'projects', value: 'p1' },
      parent_id: { parentTable: 'folders', value: null },
    });
    const document = makeRow('documents', 'd1', {
      organization_id: { parentTable: 'organizations', value: 'o1' },
      project_id: { parentTable: 'projects', value: 'p1' },
      owner_id: { parentTable: 'users', value: 'u1' },
      folder_id: { parentTable: 'folders', value: 'f1' },
    });
    const rows = [folder, document];

    const { deleted, nulled } = simulateDelete(rows, folder);

    // The document survives with its folder reference nulled (moved to unfiled).
    expect(deleted.has(rowKey('folders', 'f1'))).toBe(true);
    expect(deleted.has(rowKey('documents', 'd1'))).toBe(false);
    expect(document.fk.folder_id!.value).toBeNull();
    expect(nulled).toEqual([{ row: document, column: 'folder_id' }]);
  });
});

// ---------------------------------------------------------------------------
// Property 58 (property-based test).
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 58: Parent deletion cascades with no orphans', () => {
  // Validates: Requirements 44.8
  it('leaves no orphaned row and detaches SET NULL references after any parent delete', () => {
    fc.assert(
      fc.property(
        // Entropy tape driving dataset shape and FK selections.
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
          minLength: 400,
          maxLength: 400,
        }),
        // Selector for the row to delete.
        fc.nat(),
        (tapeValues, targetSeed) => {
          const rows = buildDataset(new Tape(tapeValues));
          if (rows.length === 0) return; // nothing to delete this run

          const target = rows[targetSeed % rows.length]!;
          const { deleted, nulled } = simulateDelete(rows, target);

          // The target itself is always removed.
          expect(deleted.has(rowKey(target.table, target.id))).toBe(true);

          for (const row of rows) {
            const isDeleted = deleted.has(rowKey(row.table, row.id));
            if (isDeleted) {
              if (row === target) continue;
              // Soundness: a cascade-deleted row must be justified by a CASCADE
              // edge to some other deleted row (nothing unrelated is removed).
              const justified = Object.values(row.fk).some(
                (fkv) =>
                  fkv.action === 'CASCADE' &&
                  fkv.value !== null &&
                  deleted.has(rowKey(fkv.parentTable, fkv.value)),
              );
              expect(justified).toBe(true);
            } else {
              // No-orphan invariant: a surviving row must not reference any
              // deleted row through a CASCADE edge. The only way it may have
              // referenced a deleted parent is a SET NULL edge, which the
              // simulation detaches to null.
              for (const fkv of Object.values(row.fk)) {
                if (fkv.value !== null && deleted.has(rowKey(fkv.parentTable, fkv.value))) {
                  expect(fkv.action).toBe('SET NULL');
                }
              }
            }
          }

          // Every detached reference belongs to a surviving row and is now null.
          for (const { row, column } of nulled) {
            expect(deleted.has(rowKey(row.table, row.id))).toBe(false);
            expect(row.fk[column]!.value).toBeNull();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
