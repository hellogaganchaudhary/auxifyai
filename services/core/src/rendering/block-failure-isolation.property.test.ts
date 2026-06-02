/**
 * Property-based test for **Property 23: Block render failure is isolated**
 * (Req 8.7), the per-block failure isolation guarantee of the Output_Renderer
 * (Req 8.1-8.7), implemented by {@link OutputRenderer} at
 * `services/core/src/rendering` (task 8.9).
 *
 * Validates: Requirements 8.7
 *
 * Requirement 8.7: _IF rendering of a content block fails, THEN THE
 * Output_Renderer SHALL display the raw content for that block and SHALL render
 * the remaining response._
 *
 * Property statement (design.md): _for any_ response composed of content blocks
 * where an arbitrary subset fails to render, the Output_Renderer emits the raw
 * content for each failing block and successfully renders every other block.
 *
 * The test drives {@link OutputRenderer.renderAll} with an arbitrary, arbitrarily
 * interleaved mix of:
 *
 *   - **valid** blocks — well-formed payloads for each {@link ContentBlockType}
 *     (markdown, code, mermaid, latex, table, artifact, search_results) that are
 *     guaranteed to render to their matching non-`raw` kind, and
 *   - **invalid** blocks — unknown types, missing/non-string types, malformed
 *     payloads, and definitions that fail the Mermaid/LaTeX validity checks, all
 *     guaranteed to fall back to a `raw` block.
 *
 * Each generated block is tagged with whether it *should* render or fall back,
 * so after rendering we can assert, per position:
 *
 *   1. one rendered block per input block, in the same order (length + order),
 *   2. every valid block renders to its expected non-`raw` kind, no matter how
 *      many siblings are invalid,
 *   3. every invalid block becomes a `raw` fallback carrying the original block
 *      and a non-empty reason, and
 *   4. the set of positions that fell back equals *exactly* the set of invalid
 *      blocks — no valid block is collateral-damaged, no invalid block silently
 *      succeeds (the isolation guarantee).
 *
 * It also asserts {@link OutputRenderer.render} never throws for any generated
 * block (the totality the isolation relies on). The renderer is exercised
 * through its real public surface — no mocks — so the assertions test the
 * production rendering path end to end.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ContentBlock } from '@auxify/types';

import { OutputRenderer } from './output-renderer.js';
import type { RawRenderedBlock, RenderedBlock, RenderedBlockKind } from './types.js';

const renderer = new OutputRenderer();

/** Minimum generated iterations for every property (>= 100). */
const NUM_RUNS = 300;

/** Build a {@link ContentBlock} with the given (possibly unknown) type and payload. */
function block(type: string, data: unknown): ContentBlock {
  return { type: type as ContentBlock['type'], data };
}

/**
 * A generated block tagged with its expected rendering outcome: a valid block
 * carries the non-`raw` kind it must render to; an invalid block must fall back
 * to `raw`.
 */
type TaggedBlock =
  | { block: ContentBlock; valid: true; expectedKind: RenderedBlockKind }
  | { block: ContentBlock; valid: false };

// ---------------------------------------------------------------------------
// Known-valid block generators — payloads guaranteed to render to a non-raw kind.
// ---------------------------------------------------------------------------

/** Mermaid definitions whose first token is a recognized diagram type (valid). */
const VALID_MERMAID = [
  'flowchart TD\n  A --> B',
  'graph LR\n  X --> Y',
  'sequenceDiagram\n  A->>B: hi',
  'classDiagram\n  A <|-- B',
  'pie\n  "a" : 1',
] as const;

/** LaTeX expressions with balanced braces/environments (valid). */
const VALID_LATEX = [
  'E = mc^2',
  'a + b = c',
  '\\frac{1}{2}',
  'x^2 + y^2 = z^2',
  '\\sqrt{x + 1}',
  '\\sum_{i=1}^{n} i',
] as const;

const validMarkdown: fc.Arbitrary<TaggedBlock> = fc.oneof(
  fc
    .string()
    .map(
      (s): TaggedBlock => ({ block: block('markdown', s), valid: true, expectedKind: 'markdown' }),
    ),
  fc
    .string()
    .map(
      (s): TaggedBlock => ({
        block: block('markdown', { markdown: s }),
        valid: true,
        expectedKind: 'markdown',
      }),
    ),
  fc
    .string()
    .map(
      (s): TaggedBlock => ({
        block: block('markdown', { text: s }),
        valid: true,
        expectedKind: 'markdown',
      }),
    ),
);

const validCode: fc.Arbitrary<TaggedBlock> = fc.oneof(
  fc
    .string()
    .map((s): TaggedBlock => ({ block: block('code', s), valid: true, expectedKind: 'code' })),
  fc
    .record({
      code: fc.string(),
      language: fc.option(fc.constantFrom('ts', 'py', 'js', 'go'), { nil: undefined }),
    })
    .map(
      (data): TaggedBlock => ({ block: block('code', data), valid: true, expectedKind: 'code' }),
    ),
);

const validMermaid: fc.Arbitrary<TaggedBlock> = fc.oneof(
  fc
    .constantFrom(...VALID_MERMAID)
    .map(
      (s): TaggedBlock => ({ block: block('mermaid', s), valid: true, expectedKind: 'mermaid' }),
    ),
  fc
    .constantFrom(...VALID_MERMAID)
    .map(
      (s): TaggedBlock => ({
        block: block('mermaid', { source: s }),
        valid: true,
        expectedKind: 'mermaid',
      }),
    ),
);

const validLatex: fc.Arbitrary<TaggedBlock> = fc.oneof(
  fc
    .constantFrom(...VALID_LATEX)
    .map((s): TaggedBlock => ({ block: block('latex', s), valid: true, expectedKind: 'latex' })),
  fc
    .record({ latex: fc.constantFrom(...VALID_LATEX), display: fc.boolean() })
    .map(
      (data): TaggedBlock => ({ block: block('latex', data), valid: true, expectedKind: 'latex' }),
    ),
);

const validTable: fc.Arbitrary<TaggedBlock> = fc
  .record({
    columns: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 4 }),
    rows: fc.array(fc.array(fc.oneof(fc.string(), fc.integer()), { maxLength: 4 }), {
      maxLength: 5,
    }),
  })
  .map(
    (data): TaggedBlock => ({ block: block('table', data), valid: true, expectedKind: 'table' }),
  );

const validArtifact: fc.Arbitrary<TaggedBlock> = fc
  .record({
    content: fc.string(),
    artifactType: fc.option(fc.constantFrom('document', 'code', 'diagram', 'html'), {
      nil: undefined,
    }),
    title: fc.option(fc.string(), { nil: undefined }),
  })
  .map(
    (data): TaggedBlock => ({
      block: block('artifact', data),
      valid: true,
      expectedKind: 'artifact',
    }),
  );

const searchResultItem = fc.record({
  title: fc.string({ maxLength: 20 }),
  url: fc.webUrl(),
  snippet: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
});

const validSearch: fc.Arbitrary<TaggedBlock> = fc.array(searchResultItem, { maxLength: 5 }).map(
  (results): TaggedBlock => ({
    block: block('search_results', { results }),
    valid: true,
    expectedKind: 'search_results',
  }),
);

/** Any well-formed block guaranteed to render to its matching non-`raw` kind. */
const validBlockArb: fc.Arbitrary<TaggedBlock> = fc.oneof(
  validMarkdown,
  validCode,
  validMermaid,
  validLatex,
  validTable,
  validArtifact,
  validSearch,
);

// ---------------------------------------------------------------------------
// Known-invalid block generators — payloads guaranteed to fall back to `raw`.
// ---------------------------------------------------------------------------

/** Non-string, non-record scalars that never satisfy any renderer's payload contract. */
const scalarJunk: fc.Arbitrary<unknown> = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null));

/** A block of a type with no registered renderer → unsupported-type fallback. */
const unknownTypeBlock: fc.Arbitrary<TaggedBlock> = fc
  .record({
    type: fc.constantFrom('video', 'audio', 'unknown', 'foobar', 'widget', 'chart3d'),
    data: fc.oneof(
      scalarJunk,
      fc.string(),
      fc.array(fc.integer()),
      fc.record({ any: fc.string() }),
    ),
  })
  .map(({ type, data }): TaggedBlock => ({ block: block(type, data), valid: false }));

/** A block missing a string `type` → missing-type fallback. */
const malformedTypeBlock: fc.Arbitrary<TaggedBlock> = fc
  .oneof(
    fc.record({ data: fc.string() }),
    fc.record({ type: fc.integer(), data: fc.string() }),
    fc.record({ type: fc.constant(null), data: fc.string() }),
  )
  .map((value): TaggedBlock => ({ block: value as unknown as ContentBlock, valid: false }));

const invalidMarkdown: fc.Arbitrary<TaggedBlock> = fc
  .oneof(
    scalarJunk,
    fc.array(fc.string()),
    fc.constant({ foo: 'bar' }),
    fc.record({ markdown: fc.integer() }),
    fc.record({ text: fc.boolean() }),
  )
  .map((data): TaggedBlock => ({ block: block('markdown', data), valid: false }));

const invalidCode: fc.Arbitrary<TaggedBlock> = fc
  .oneof(
    scalarJunk,
    fc.array(fc.integer()),
    fc.constant({ language: 'ts' }),
    fc.record({ code: fc.integer() }),
  )
  .map((data): TaggedBlock => ({ block: block('code', data), valid: false }));

const invalidMermaid: fc.Arbitrary<TaggedBlock> = fc
  .oneof(
    fc.constantFrom(
      'not a diagram',
      'hello world',
      'lorem ipsum dolor',
      'just some text',
      'random content',
    ),
    scalarJunk,
    fc.record({ source: fc.constantFrom('plain text', 'not a diagram', 'nonsense here') }),
    fc.constant({ notSource: 'x' }),
  )
  .map((data): TaggedBlock => ({ block: block('mermaid', data), valid: false }));

const invalidLatex: fc.Arbitrary<TaggedBlock> = fc
  .oneof(
    fc.constantFrom('\\frac{1}{2', '{unbalanced', 'a}', '\\begin{matrix} x', '   ', '(((', '))'),
    scalarJunk,
    fc.record({ latex: fc.constantFrom('\\frac{1}{2', '{{{', '\\end{x}') }),
    fc.constant({ notLatex: 'x' }),
  )
  .map((data): TaggedBlock => ({ block: block('latex', data), valid: false }));

const invalidTable: fc.Arbitrary<TaggedBlock> = fc
  .oneof(
    scalarJunk,
    fc.string(),
    fc.constant({ foo: 'bar' }),
    fc.record({ columns: fc.string(), rows: fc.array(fc.integer()) }),
    fc.record({ columns: fc.array(fc.string()), rows: fc.string() }),
    fc.constant({ columns: 'x' }),
  )
  .map((data): TaggedBlock => ({ block: block('table', data), valid: false }));

const invalidArtifact: fc.Arbitrary<TaggedBlock> = fc
  .oneof(
    scalarJunk,
    fc.string(),
    fc.constant({ title: 'no content' }),
    fc.record({ content: fc.integer() }),
    fc.constant({ artifactType: 'document' }),
  )
  .map((data): TaggedBlock => ({ block: block('artifact', data), valid: false }));

const invalidSearch: fc.Arbitrary<TaggedBlock> = fc
  .oneof(
    scalarJunk,
    fc.string(),
    fc.constant({ results: 'x' }),
    fc.constant({ results: [{ title: 'no url' }] }),
    fc.constant({ results: [{ url: 'https://x.test' }] }),
    fc.constant({ results: [{ title: 'ok', url: 'https://x.test' }, { title: 'missing url' }] }),
  )
  .map((data): TaggedBlock => ({ block: block('search_results', data), valid: false }));

/** Any malformed/unknown block guaranteed to fall back to a `raw` block. */
const invalidBlockArb: fc.Arbitrary<TaggedBlock> = fc.oneof(
  unknownTypeBlock,
  malformedTypeBlock,
  invalidMarkdown,
  invalidCode,
  invalidMermaid,
  invalidLatex,
  invalidTable,
  invalidArtifact,
  invalidSearch,
);

/** An arbitrary block — valid or invalid — for arbitrary mixed-list generation. */
const taggedBlockArb: fc.Arbitrary<TaggedBlock> = fc.oneof(validBlockArb, invalidBlockArb);

/**
 * A list guaranteed to contain at least one valid AND at least one invalid
 * block, arbitrarily interleaved (so the isolation direction is always
 * stressed: a failing block sits among rendering siblings).
 */
const mixedBlocksArb: fc.Arbitrary<TaggedBlock[]> = fc
  .record({
    valids: fc.array(validBlockArb, { minLength: 1, maxLength: 10 }),
    invalids: fc.array(invalidBlockArb, { minLength: 1, maxLength: 10 }),
  })
  .chain(({ valids, invalids }) => {
    const all = [...valids, ...invalids];
    return fc
      .array(fc.double({ min: 0, max: 1, noNaN: true }), {
        minLength: all.length,
        maxLength: all.length,
      })
      .map((keys) =>
        all
          .map((item, i) => ({ item, key: keys[i]! }))
          .sort((a, b) => a.key - b.key)
          .map((entry) => entry.item),
      );
  });

/** Assert one rendered block per tagged block, in order, with isolation holding. */
function assertIsolation(tagged: TaggedBlock[]): void {
  const blocks = tagged.map((t) => t.block);

  // render() is total: it never throws for any single block.
  for (const t of tagged) {
    expect(() => renderer.render(t.block)).not.toThrow();
  }

  let rendered: RenderedBlock[] = [];
  expect(() => {
    rendered = renderer.renderAll(blocks);
  }).not.toThrow();

  // (1) One rendered block per input block, in the same order.
  expect(rendered).toHaveLength(blocks.length);

  // (2)/(3) Per-position: valid → expected non-raw kind; invalid → raw fallback
  // carrying the original block and a non-empty reason.
  tagged.forEach((t, i) => {
    const out = rendered[i]!;
    if (t.valid) {
      expect(out.kind).toBe(t.expectedKind);
      expect(out.kind).not.toBe('raw');
    } else {
      expect(out.kind).toBe('raw');
      const raw = out as RawRenderedBlock;
      expect(raw.original).toBe(t.block);
      expect(typeof raw.reason).toBe('string');
      expect(raw.reason.length).toBeGreaterThan(0);
    }
  });

  // (4) The set of positions that fell back equals EXACTLY the set of invalid
  // blocks — computed independently from the output, so a valid block that was
  // collateral-damaged, or an invalid block that silently succeeded, fails here.
  const fallbackPositions = rendered
    .map((b, i) => ({ kind: b.kind, i }))
    .filter((x) => x.kind === 'raw')
    .map((x) => x.i);
  const invalidPositions = tagged
    .map((t, i) => ({ valid: t.valid, i }))
    .filter((x) => !x.valid)
    .map((x) => x.i);
  expect(fallbackPositions).toEqual(invalidPositions);
}

describe('Feature: auxify-ai-platform, Property 23: Block render failure is isolated', () => {
  it('renders every valid block to its kind and falls back exactly the invalid blocks to raw, preserving length and order (Validates: Requirements 8.7)', () => {
    fc.assert(
      fc.property(fc.array(taggedBlockArb, { minLength: 0, maxLength: 20 }), (tagged) => {
        assertIsolation(tagged);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('an invalid block at any position never prevents a valid sibling from rendering (Validates: Requirements 8.7)', () => {
    fc.assert(
      fc.property(mixedBlocksArb, (tagged) => {
        assertIsolation(tagged);
        // Sanity: the generator really did mix valid and invalid blocks.
        expect(tagged.some((t) => t.valid)).toBe(true);
        expect(tagged.some((t) => !t.valid)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
