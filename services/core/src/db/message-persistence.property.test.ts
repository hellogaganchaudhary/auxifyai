/**
 * Property-based test for lossless message persistence (the message-persistence
 * round-trip required by the Primary_Database data model).
 *
 * Feature: auxify-ai-platform, Property 57: Message persistence round-trips.
 *
 * Design statement (Property 57): "A message that is persisted and then read
 * back round-trips with its full request outcome intact — the conversation
 * reference, parent reference, role, content, model, token counts, cost, and
 * latency all equal what was written."
 *
 * Validates: Requirements 44.6
 *
 * No live database is available in this environment, so the property is
 * exercised against an {@link InMemoryMessageStore} that faithfully models the
 * persistence contract of the `messages` table defined in
 * `0003_conversations_messages.sql`:
 *   - `content` / `attachments` are JSONB — modelled here by storing the
 *     serialized JSON text and re-parsing on read, so the serialize/deserialize
 *     boundary is what the property actually crosses.
 *   - `cost` is `NUMERIC(18, 8)` — modelled by storing a fixed-scale (8-decimal)
 *     decimal string, the representation `node-postgres` returns for NUMERIC,
 *     so numeric precision is exercised rather than glossed over.
 *   - `input_tokens` / `output_tokens` / `latency_ms` are `INTEGER` (int4).
 *   - `parent_id`, `model`, `cost`, `rating`, and the token/latency columns are
 *     nullable; `content`/`attachments` default to an empty array; `pinned`
 *     defaults to false; `role` and `rating` are constrained enums.
 *
 * The store accepts a domain {@link MessageRecord}, persists it through that
 * contract, and reconstructs it on read; the property asserts the reconstruction
 * equals the original field-for-field. When the repository layer from task 2.4
 * lands, this property can be re-pointed at `MessageRepository` over the same
 * fake `SqlClient` without changing the assertion.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ContentBlock, ContentBlockType, SourceAttribution } from '@auxify/types';
import { CONTENT_BLOCK_TYPES } from '@auxify/types';

/** Minimum generated iterations required for every platform property (>= 100). */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Domain shape — mirrors the `messages` columns (Req 44.6).
// ---------------------------------------------------------------------------

/** The branch-tree roles permitted by the `messages.role` CHECK constraint. */
type MessageRole = 'user' | 'assistant' | 'system';
const MESSAGE_ROLES: readonly MessageRole[] = ['user', 'assistant', 'system'] as const;

/** The values permitted by the `messages.rating` CHECK constraint. */
type MessageRating = 'up' | 'neutral' | 'down';
const MESSAGE_RATINGS: readonly MessageRating[] = ['up', 'neutral', 'down'] as const;

/**
 * A persisted message, carrying the full request outcome required by Req 44.6.
 * Nullable columns are modelled as `T | null` (explicit SQL NULL) rather than
 * optional, so the round-trip preserves the column's presence exactly.
 */
interface MessageRecord {
  id: string;
  conversationId: string;
  /** Self-referential branch parent; NULL for a root message. */
  parentId: string | null;
  role: MessageRole;
  /** JSONB array of renderable blocks. */
  content: ContentBlock[];
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** NUMERIC(18, 8) request cost. */
  cost: number | null;
  latencyMs: number | null;
  rating: MessageRating | null;
  pinned: boolean;
  /** JSONB array of attachment descriptors. */
  attachments: unknown[];
  /** TIMESTAMPTZ, modelled as an ISO-8601 string. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Persistence contract — an in-memory store modelling the `messages` table.
// ---------------------------------------------------------------------------

const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;
/** NUMERIC(18, 8): 18 total digits, 8 after the decimal point. */
const COST_SCALE = 8;

/** The physical row as the database would hold (and `pg` would return) it. */
interface StoredMessageRow {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: string;
  /** JSONB stored as serialized text. */
  content: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** NUMERIC returned by node-postgres as a fixed-scale decimal string. */
  cost: string | null;
  latency_ms: number | null;
  rating: string | null;
  pinned: boolean;
  /** JSONB stored as serialized text. */
  attachments: string;
  created_at: string;
}

class MessagePersistenceError extends Error {}

/** Render a number as a NUMERIC(_, scale) decimal string (what the column holds). */
function toNumericString(value: number, scale: number): string {
  if (!Number.isFinite(value)) {
    throw new MessagePersistenceError(`cost is not a finite number: ${value}`);
  }
  return value.toFixed(scale);
}

/** Enforce the int4 column domain before "writing" a token/latency value. */
function assertInt4(value: number, column: string): void {
  if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    throw new MessagePersistenceError(`${column} is out of INTEGER range: ${value}`);
  }
}

/**
 * Reference {@link MessageRecord} store that mirrors the `messages` persistence
 * contract. `insert` enforces the column domains and serializes JSONB/NUMERIC
 * exactly as PostgreSQL would; `getById` reconstructs the domain record from the
 * stored row, crossing the serialize/parse boundary on the way back.
 */
class InMemoryMessageStore {
  private readonly rows = new Map<string, StoredMessageRow>();

  async insert(message: MessageRecord): Promise<void> {
    if (!MESSAGE_ROLES.includes(message.role)) {
      throw new MessagePersistenceError(`invalid role: ${message.role}`);
    }
    if (message.rating !== null && !MESSAGE_RATINGS.includes(message.rating)) {
      throw new MessagePersistenceError(`invalid rating: ${message.rating}`);
    }
    if (message.inputTokens !== null) assertInt4(message.inputTokens, 'input_tokens');
    if (message.outputTokens !== null) assertInt4(message.outputTokens, 'output_tokens');
    if (message.latencyMs !== null) assertInt4(message.latencyMs, 'latency_ms');

    const row: StoredMessageRow = {
      id: message.id,
      conversation_id: message.conversationId,
      parent_id: message.parentId,
      role: message.role,
      // JSONB write boundary: the value is serialized to text.
      content: JSON.stringify(message.content),
      model: message.model,
      input_tokens: message.inputTokens,
      output_tokens: message.outputTokens,
      cost: message.cost === null ? null : toNumericString(message.cost, COST_SCALE),
      latency_ms: message.latencyMs,
      rating: message.rating,
      pinned: message.pinned,
      attachments: JSON.stringify(message.attachments),
      created_at: message.createdAt,
    };
    this.rows.set(row.id, { ...row });
  }

  async getById(id: string): Promise<MessageRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      parentId: row.parent_id,
      role: row.role as MessageRole,
      // JSONB read boundary: the stored text is parsed back to a value.
      content: JSON.parse(row.content) as ContentBlock[],
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cost: row.cost === null ? null : Number(row.cost),
      latencyMs: row.latency_ms,
      rating: row.rating as MessageRating | null,
      pinned: row.pinned,
      attachments: JSON.parse(row.attachments) as unknown[],
      createdAt: row.created_at,
    };
  }
}

// ---------------------------------------------------------------------------
// Smart generators — constrained to the persistence input space.
// ---------------------------------------------------------------------------

/**
 * A JSON-stable value: strings, integers, booleans, null, and bounded nested
 * arrays/objects. Floats and `undefined` are deliberately excluded so a value
 * is byte-for-byte stable across a JSON serialize/parse round-trip (no `-0`,
 * no float re-rounding, no dropped `undefined` keys) — the value equals itself
 * after persistence, which is exactly what the JSONB contract guarantees.
 */
const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { maxDepth: 3 },
    fc.string(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 4 }),
    fc
      .array(fc.tuple(fc.string(), tie('value')), { maxLength: 4 })
      .map((entries) => Object.fromEntries(entries) as Record<string, unknown>),
  ),
})).value;

/** Complete (never partial) source attribution — every field required (Req 24.4). */
const attributionArb: fc.Arbitrary<SourceAttribution> = fc.record({
  sourceId: fc.string({ minLength: 1, maxLength: 24 }),
  sourceTitle: fc.string(),
  location: fc.string(),
  link: fc.string(),
});

/**
 * A renderable content block. `attribution` is either fully present (an array)
 * or fully absent — never an explicit `undefined` — so the JSON round-trip is
 * exact for both shapes.
 */
const contentBlockArb: fc.Arbitrary<ContentBlock> = fc.oneof(
  fc.record({
    type: fc.constantFrom<ContentBlockType>(...CONTENT_BLOCK_TYPES),
    data: jsonValueArb,
  }),
  fc.record({
    type: fc.constantFrom<ContentBlockType>(...CONTENT_BLOCK_TYPES),
    data: jsonValueArb,
    attribution: fc.array(attributionArb, { maxLength: 3 }),
  }),
);

/** An attachment descriptor (JSONB element), all fields JSON-stable. */
const attachmentArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 16 }),
  name: fc.string(),
  contentType: fc.string(),
  size: fc.integer({ min: 0, max: 100 * 1024 * 1024 }),
  url: fc.string(),
});

/**
 * A NUMERIC(18, 8)-exact cost. Built from an integer and an 8-digit fractional
 * part so the generated value is an exact multiple of 1e-8 within a magnitude
 * (<= ~1e6) where the nearest double round-trips through scale-8 formatting
 * losslessly — precisely the values the column can hold.
 */
const costArb: fc.Arbitrary<number> = fc
  .tuple(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 99_999_999 }))
  .map(([whole, frac]) => Number(`${whole}.${String(frac).padStart(COST_SCALE, '0')}`));

/** A TIMESTAMPTZ value (1970-01-01 .. ~2100), modelled as an ISO-8601 string. */
const createdAtArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 4_102_444_800_000 })
  .map((ms) => new Date(ms).toISOString());

/** Optional column: a generated value or an explicit SQL NULL. */
function nullable<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null> {
  return fc.option(arb, { nil: null });
}

const messageArb: fc.Arbitrary<MessageRecord> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 24 }),
  conversationId: fc.string({ minLength: 1, maxLength: 24 }),
  parentId: nullable(fc.string({ minLength: 1, maxLength: 24 })),
  role: fc.constantFrom<MessageRole>(...MESSAGE_ROLES),
  content: fc.array(contentBlockArb, { maxLength: 6 }),
  model: nullable(fc.string({ minLength: 1, maxLength: 40 })),
  inputTokens: nullable(fc.integer({ min: 0, max: INT32_MAX })),
  outputTokens: nullable(fc.integer({ min: 0, max: INT32_MAX })),
  cost: nullable(costArb),
  latencyMs: nullable(fc.integer({ min: 0, max: INT32_MAX })),
  rating: nullable(fc.constantFrom<MessageRating>(...MESSAGE_RATINGS)),
  pinned: fc.boolean(),
  attachments: fc.array(attachmentArb, { maxLength: 5 }),
  createdAt: createdAtArb,
});

// ---------------------------------------------------------------------------
// Property 57.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 57: Message persistence round-trips', () => {
  it('persists and reads back any message with every field preserved (Validates: Requirements 44.6)', async () => {
    await fc.assert(
      fc.asyncProperty(messageArb, async (message) => {
        const store = new InMemoryMessageStore();

        await store.insert(message);
        const read = await store.getById(message.id);

        // The reconstruction must exist and equal the original field-for-field.
        expect(read).not.toBeNull();
        expect(read).toEqual(message);

        // Explicit per-field round-trip of the Req 44.6 request outcome, so a
        // counterexample names the exact field that failed to round-trip.
        expect(read!.conversationId).toBe(message.conversationId);
        expect(read!.parentId).toBe(message.parentId);
        expect(read!.role).toBe(message.role);
        expect(read!.content).toEqual(message.content);
        expect(read!.model).toBe(message.model);
        expect(read!.inputTokens).toBe(message.inputTokens);
        expect(read!.outputTokens).toBe(message.outputTokens);
        expect(read!.cost).toBe(message.cost);
        expect(read!.latencyMs).toBe(message.latencyMs);
        expect(read!.rating).toBe(message.rating);
        expect(read!.pinned).toBe(message.pinned);
        expect(read!.attachments).toEqual(message.attachments);
        expect(read!.createdAt).toBe(message.createdAt);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Complementary unit examples — concrete shapes and boundary values.
// ---------------------------------------------------------------------------

describe('message persistence round-trip — examples and edge cases (Req 44.6)', () => {
  it('round-trips a fully-populated assistant message with attributed content', async () => {
    const store = new InMemoryMessageStore();
    const message: MessageRecord = {
      id: 'msg_1',
      conversationId: 'conv_1',
      parentId: 'msg_0',
      role: 'assistant',
      content: [
        { type: 'markdown', data: { text: 'Hello' } },
        {
          type: 'search_results',
          data: [{ rank: 1 }],
          attribution: [
            {
              sourceId: 'src_1',
              sourceTitle: 'Doc',
              location: 'p.2',
              link: 'https://example.test/doc#2',
            },
          ],
        },
      ],
      model: 'claude-3-5-sonnet',
      inputTokens: 1200,
      outputTokens: 350,
      cost: 0.01234567,
      latencyMs: 875,
      rating: 'up',
      pinned: true,
      attachments: [
        { id: 'att_1', name: 'a.png', contentType: 'image/png', size: 1024, url: 's3://a' },
      ],
      createdAt: '2026-01-02T03:04:05.000Z',
    };

    await store.insert(message);
    expect(await store.getById('msg_1')).toEqual(message);
  });

  it('round-trips a root user message with all optional columns NULL and empty JSONB arrays', async () => {
    const store = new InMemoryMessageStore();
    const message: MessageRecord = {
      id: 'msg_root',
      conversationId: 'conv_2',
      parentId: null,
      role: 'user',
      content: [],
      model: null,
      inputTokens: null,
      outputTokens: null,
      cost: null,
      latencyMs: null,
      rating: null,
      pinned: false,
      attachments: [],
      createdAt: '1970-01-01T00:00:00.000Z',
    };

    await store.insert(message);
    expect(await store.getById('msg_root')).toEqual(message);
  });

  it('preserves NUMERIC(18,8) cost precision at the smallest representable unit', async () => {
    const store = new InMemoryMessageStore();
    const message: MessageRecord = {
      id: 'msg_cost',
      conversationId: 'conv_3',
      parentId: null,
      role: 'assistant',
      content: [],
      model: 'gpt-4o',
      inputTokens: 0,
      outputTokens: 0,
      cost: 0.00000001,
      latencyMs: 0,
      rating: 'neutral',
      pinned: false,
      attachments: [],
      createdAt: '2025-06-15T12:00:00.000Z',
    };

    await store.insert(message);
    expect((await store.getById('msg_cost'))!.cost).toBe(0.00000001);
  });

  it('returns null for an id that was never persisted', async () => {
    const store = new InMemoryMessageStore();
    expect(await store.getById('missing')).toBeNull();
  });
});
