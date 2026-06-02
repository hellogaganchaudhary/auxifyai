/**
 * The Output_Renderer (Req 8.1-8.7).
 *
 * Turns model-emitted {@link ContentBlock}s into structured, browser-free
 * {@link RenderedBlock} descriptors the web client consumes. It dispatches on
 * {@link ContentBlock.type} to a per-type renderer:
 *
 *   - `markdown`  → sanitized GFM HTML (Req 8.1)
 *   - `code`      → detected language + escaped code + copy affordance (Req 8.2)
 *   - `mermaid`   → validated source for client-side SVG (Req 8.3)
 *   - `latex`     → validated source for client-side KaTeX/MathJax (Req 8.4)
 *   - `table`     → sortable structured model + CSV export (Req 8.5)
 *   - `artifact`  → Artifact_Editor side-panel render descriptor (Req 8.6)
 *   - `search_results` → normalized result entries
 *
 * ## Per-block failure isolation (Req 8.7, Property 23)
 *
 * The contract that matters most: rendering one block must never break another.
 * {@link OutputRenderer.render} therefore *never throws* for a single block —
 * any malformed payload, failed validity check, unknown type, or unexpected
 * error is caught and converted to a `raw` {@link RawRenderedBlock} carrying the
 * original content and the reason. {@link OutputRenderer.renderAll} maps over a
 * response's blocks calling `render` on each, so a failing block yields a `raw`
 * fallback while every sibling renders normally. This isolation is exactly what
 * task 8.10 validates as a property.
 *
 * The renderer is pure and synchronous: given the same blocks it always
 * produces the same descriptors, with no I/O, no DOM, and no shared state.
 */

import type { ContentBlock, SourceAttribution } from '@auxify/types';

import { renderCode, type CodeBlockData } from './code.js';
import { renderLatex, validateLatex, type LatexBlockData } from './latex.js';
import { renderMarkdownToHtml } from './markdown.js';
import { renderMermaid, validateMermaid } from './mermaid.js';
import { renderTable, type TableBlockData } from './table.js';
import type {
  ArtifactRenderedBlock,
  RawRenderedBlock,
  RenderedBlock,
  SearchResultItem,
} from './types.js';

/** A non-null object guard used before narrowing a block's `unknown` payload. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Produce a stable, verbatim string for the `raw` fallback from any payload. */
function rawStringFor(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === null || data === undefined) return '';
  if (isRecord(data)) {
    // Prefer an obvious text-bearing field, else serialize the whole payload.
    for (const key of ['code', 'source', 'latex', 'content', 'text', 'markdown']) {
      const candidate = data[key];
      if (typeof candidate === 'string') return candidate;
    }
  }
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

/**
 * Build the `raw` fallback for a block that could not be rendered (Req 8.7).
 *
 * @param block The original content block.
 * @param reason A human-readable explanation of the failure.
 * @returns A {@link RawRenderedBlock} carrying the raw content and reason.
 */
export function toRawBlock(block: ContentBlock, reason: string): RawRenderedBlock {
  const raw: RawRenderedBlock = {
    kind: 'raw',
    sourceType: typeof block?.type === 'string' ? block.type : 'unknown',
    raw: rawStringFor(block?.data),
    original: block,
    reason,
  };
  return withAttribution(raw, block);
}

/** Copy a block's source attributions onto its rendered descriptor when present (Req 24.5). */
function withAttribution<T extends RenderedBlock>(rendered: T, block: ContentBlock): T {
  if (Array.isArray(block?.attribution) && block.attribution.length > 0) {
    return { ...rendered, attribution: block.attribution as SourceAttribution[] };
  }
  return rendered;
}

/** Render a `code` block, narrowing the `unknown` payload (string or `{ code, language? }`). */
function renderCodeBlock(block: ContentBlock): RenderedBlock {
  const data = block.data;
  let payload: CodeBlockData;
  if (typeof data === 'string') {
    payload = { code: data };
  } else if (isRecord(data) && typeof data.code === 'string') {
    payload = {
      code: data.code,
      language: typeof data.language === 'string' ? data.language : undefined,
    };
  } else {
    throw new Error('code block requires a string or a { code: string } payload');
  }
  return withAttribution(renderCode(payload), block);
}

/** Render a `mermaid` block, validating the definition before accepting it (Req 8.3). */
function renderMermaidBlock(block: ContentBlock): RenderedBlock {
  const data = block.data;
  const source =
    typeof data === 'string'
      ? data
      : isRecord(data) && typeof data.source === 'string'
        ? data.source
        : null;
  if (source === null) {
    throw new Error('mermaid block requires a string or a { source: string } payload');
  }
  const validation = validateMermaid(source);
  if (!validation.valid || validation.diagramType === null) {
    throw new Error('mermaid definition is not a recognized diagram');
  }
  return withAttribution(renderMermaid(source, validation.diagramType), block);
}

/** Render a `latex` block, validating the notation before accepting it (Req 8.4). */
function renderLatexBlock(block: ContentBlock): RenderedBlock {
  const data = block.data;
  let payload: LatexBlockData;
  if (typeof data === 'string') {
    payload = { latex: data };
  } else if (isRecord(data) && typeof data.latex === 'string') {
    payload = {
      latex: data.latex,
      display: typeof data.display === 'boolean' ? data.display : undefined,
    };
  } else {
    throw new Error('latex block requires a string or a { latex: string } payload');
  }
  if (!validateLatex(payload.latex).valid) {
    throw new Error('latex notation failed the validity check');
  }
  return withAttribution(renderLatex(payload), block);
}

/** Render a `table` block, requiring a structured `{ columns, rows }` payload (Req 8.5). */
function renderTableBlock(block: ContentBlock): RenderedBlock {
  const data = block.data;
  if (!isRecord(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
    throw new Error('table block requires a { columns: [], rows: [] } payload');
  }
  return withAttribution(renderTable(data as unknown as TableBlockData), block);
}

/** Render an `artifact` block into the Artifact_Editor side-panel descriptor (Req 8.6). */
function renderArtifactBlock(block: ContentBlock): RenderedBlock {
  const data = block.data;
  if (!isRecord(data) || typeof data.content !== 'string') {
    throw new Error('artifact block requires a { content: string } payload');
  }
  const rendered: ArtifactRenderedBlock = {
    kind: 'artifact',
    artifactType: typeof data.artifactType === 'string' ? data.artifactType : 'document',
    content: data.content,
    target: 'artifact_editor',
  };
  if (typeof data.artifactId === 'string') rendered.artifactId = data.artifactId;
  if (typeof data.title === 'string') rendered.title = data.title;
  return withAttribution(rendered, block);
}

/** Render a `search_results` block into normalized, sanitized entries. */
function renderSearchResultsBlock(block: ContentBlock): RenderedBlock {
  const data = block.data;
  const rawItems = isRecord(data) && Array.isArray(data.results) ? data.results : data;
  if (!Array.isArray(rawItems)) {
    throw new Error('search_results block requires an array of results');
  }
  const items: SearchResultItem[] = rawItems.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.title !== 'string' || typeof entry.url !== 'string') {
      throw new Error(`search result at index ${index} requires a title and url`);
    }
    const item: SearchResultItem = { title: entry.title, url: entry.url };
    if (typeof entry.snippet === 'string') item.snippet = entry.snippet;
    return item;
  });
  return withAttribution({ kind: 'search_results', items }, block);
}

/** Render a `markdown` block to sanitized GFM HTML (Req 8.1). */
function renderMarkdownBlock(block: ContentBlock): RenderedBlock {
  const data = block.data;
  const source =
    typeof data === 'string'
      ? data
      : isRecord(data) && typeof data.markdown === 'string'
        ? data.markdown
        : isRecord(data) && typeof data.text === 'string'
          ? data.text
          : null;
  if (source === null) {
    throw new Error('markdown block requires a string or a { markdown: string } payload');
  }
  return withAttribution({ kind: 'markdown', html: renderMarkdownToHtml(source), source }, block);
}

/** The per-type render dispatch table. */
const RENDERERS: Readonly<Record<string, (block: ContentBlock) => RenderedBlock>> = {
  markdown: renderMarkdownBlock,
  code: renderCodeBlock,
  mermaid: renderMermaidBlock,
  latex: renderLatexBlock,
  table: renderTableBlock,
  artifact: renderArtifactBlock,
  search_results: renderSearchResultsBlock,
};

/**
 * The Output_Renderer: a pure, synchronous, browser-free renderer producing
 * structured {@link RenderedBlock} descriptors (Req 8.1-8.7).
 */
export class OutputRenderer {
  /**
   * Render a single {@link ContentBlock} (Req 8.1-8.6), falling back to a `raw`
   * block on any failure (Req 8.7).
   *
   * This method **never throws**: an unknown type, a malformed payload, a failed
   * validity check, or an unexpected error all resolve to a
   * {@link RawRenderedBlock}. That totality is what lets {@link renderAll}
   * isolate per-block failures.
   *
   * @param block The content block to render.
   * @returns The rendered descriptor, or a `raw` fallback.
   */
  render(block: ContentBlock): RenderedBlock {
    if (!isRecord(block) || typeof block.type !== 'string') {
      return toRawBlock(block, 'content block is missing a string `type`');
    }
    const renderer = RENDERERS[block.type];
    if (!renderer) {
      return toRawBlock(block, `unsupported content block type: ${block.type}`);
    }
    try {
      return renderer(block);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return toRawBlock(block, reason);
    }
  }

  /**
   * Render an ordered response of {@link ContentBlock}s (Req 8.7, Property 23).
   *
   * Each block is rendered independently via {@link render}; a block that fails
   * yields a `raw` fallback while every other block renders normally. Output
   * length and order always match the input — one rendered block per source
   * block — so the response stays intact even when an arbitrary subset fails.
   *
   * @param blocks The response's content blocks, in order.
   * @returns One {@link RenderedBlock} per input block, in the same order.
   */
  renderAll(blocks: ContentBlock[]): RenderedBlock[] {
    if (!Array.isArray(blocks)) return [];
    return blocks.map((block) => this.render(block));
  }
}

/** A shared, stateless {@link OutputRenderer} instance (the renderer holds no state). */
export const outputRenderer = new OutputRenderer();
