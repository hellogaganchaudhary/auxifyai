/**
 * Rendered-output domain types for the Output_Renderer (Req 8.1-8.7).
 *
 * The Output_Renderer turns each model-emitted {@link ContentBlock} into a
 * {@link RenderedBlock}: a **structured, transport-stable, browser-free**
 * description of how that block should appear. The web client (a later task)
 * consumes these descriptors and performs the final DOM/SVG/KaTeX rendering;
 * nothing here requires a DOM, so the renderer runs identically on the server
 * (SSR) and in tests.
 *
 * `RenderedBlock` is a **discriminated union** on `kind`. Every successful kind
 * mirrors a {@link ContentBlockType} (`markdown`, `code`, `mermaid`, `latex`,
 * `table`, `artifact`, `search_results`), and one extra variant — `raw` — is
 * the universal fallback: when a single block fails to render, the renderer
 * emits a `raw` block carrying the original content and the reason, and keeps
 * rendering the remaining blocks (Req 8.7, Property 23).
 *
 * Design choice (documented per task): code highlighting, Mermaid, and LaTeX
 * are represented **structurally** (detected language + escaped text + a
 * copyable raw string; validated source for client-side Mermaid/KaTeX) rather
 * than by pulling in a heavy syntax-highlighter or headless browser. This keeps
 * `@auxify/core` dependency-free and the renderer pure and synchronous, while
 * giving the web layer everything it needs to render richly.
 */

import type { ContentBlock, SourceAttribution } from '@auxify/types';

/** The discriminant for every {@link RenderedBlock} variant. */
export type RenderedBlockKind =
  | 'markdown'
  | 'code'
  | 'mermaid'
  | 'latex'
  | 'table'
  | 'artifact'
  | 'search_results'
  | 'raw';

/** Fields shared by every rendered block variant. */
interface RenderedBlockBase {
  /** Which renderer produced this block (the discriminant). */
  kind: RenderedBlockKind;
  /**
   * The source content attributions copied through from the originating
   * {@link ContentBlock.attribution}, so the client can surface provenance for
   * retrieval-augmented content (Req 24.5). Present iff the source block
   * carried attributions.
   */
  attribution?: SourceAttribution[];
}

/**
 * GitHub-Flavored Markdown rendered to a sanitized HTML fragment (Req 8.1).
 *
 * `html` is safe to inject directly (all model text is HTML-escaped and only
 * benign link schemes survive). The original Markdown is retained as `source`
 * for clients that prefer to re-render it themselves.
 */
export interface MarkdownRenderedBlock extends RenderedBlockBase {
  kind: 'markdown';
  /** Sanitized HTML fragment rendering the GFM source. */
  html: string;
  /** The original Markdown source. */
  source: string;
}

/**
 * A fenced code block with syntax-highlight metadata and a copy affordance
 * (Req 8.2).
 *
 * The block is represented structurally rather than as pre-highlighted HTML:
 * `language` is the detected language (or `'plaintext'`), `escapedCode` is the
 * HTML-escaped code ready to drop inside a `<pre><code>` element, and `copyText`
 * is the exact raw code a copy control must place on the clipboard. `copyable`
 * is always `true` — the renderer always provides the copy affordance (Req 8.2).
 */
export interface CodeRenderedBlock extends RenderedBlockBase {
  kind: 'code';
  /** The detected (or declared) source language; `'plaintext'` when unknown. */
  language: string;
  /** The raw, unescaped code (the source of truth for the copy control). */
  code: string;
  /** The HTML-escaped code, ready to embed in a `<pre><code>` element. */
  escapedCode: string;
  /** The exact text a copy control places on the clipboard (equals {@link code}). */
  copyText: string;
  /** Always `true`: the renderer always exposes a copy affordance (Req 8.2). */
  copyable: true;
}

/**
 * A Mermaid diagram definition for client-side rendering (Req 8.3).
 *
 * Final SVG rendering happens in the browser via the Mermaid library; the
 * renderer carries the validated `source` and the detected `diagramType`
 * (`flowchart`, `sequenceDiagram`, …) so the client can render without
 * re-parsing. A definition that fails the lightweight validity check never
 * reaches this variant — it falls back to a {@link RawRenderedBlock} (Req 8.7).
 */
export interface MermaidRenderedBlock extends RenderedBlockBase {
  kind: 'mermaid';
  /** The Mermaid diagram source, to be rendered to SVG client-side. */
  source: string;
  /** The detected Mermaid diagram type keyword (e.g. `flowchart`, `sequenceDiagram`). */
  diagramType: string;
}

/**
 * LaTeX mathematical notation for client-side rendering (Req 8.4).
 *
 * Final typesetting happens in the browser via KaTeX/MathJax; the renderer
 * carries the validated `latex` and whether it should be laid out as a
 * standalone block (`display`) or inline. Notation that fails the lightweight
 * balance/validity check falls back to a {@link RawRenderedBlock} (Req 8.7).
 */
export interface LatexRenderedBlock extends RenderedBlockBase {
  kind: 'latex';
  /** The LaTeX math source, to be typeset client-side by KaTeX/MathJax. */
  latex: string;
  /** `true` for display (block) math, `false` for inline math. */
  display: boolean;
}

/** A single column definition in a {@link TableRenderedBlock}. */
export interface TableColumn {
  /** The column key, used to look up each row's cell value. */
  key: string;
  /** The human-readable column header. */
  label: string;
  /**
   * Whether the column's values are numeric, so the client (and the export)
   * can sort numerically rather than lexicographically. Inferred from the data.
   */
  numeric: boolean;
}

/** The direction a {@link TableRenderedBlock} is sorted. */
export type SortDirection = 'asc' | 'desc';

/** Sort metadata describing how a table is currently ordered. */
export interface TableSort {
  /** The {@link TableColumn.key} the rows are sorted by. */
  columnKey: string;
  /** The sort direction. */
  direction: SortDirection;
}

/**
 * Tabular data rendered as a structured, sortable, exportable table model
 * (Req 8.5).
 *
 * `columns` and `rows` are the structured model the client renders and re-sorts
 * interactively; `sort` records the order the rows are currently in (the
 * renderer normalizes/applies any requested initial sort); and `csv` is a
 * ready-to-download export of the (sorted) data. Rows are arrays of stringified
 * cells aligned to `columns` order.
 */
export interface TableRenderedBlock extends RenderedBlockBase {
  kind: 'table';
  /** The ordered column definitions. */
  columns: TableColumn[];
  /** The rows, each a list of stringified cells aligned to {@link columns}. */
  rows: string[][];
  /** The current sort order, or `null` when the rows are in source order. */
  sort: TableSort | null;
  /** A CSV export of the (sorted) table (Req 8.5). */
  csv: string;
}

/**
 * An interactive artifact's render descriptor for the Artifact_Editor side
 * panel (Req 8.6).
 *
 * The Artifact_Editor itself (task 9.5) consumes this descriptor to open the
 * artifact; here the renderer only produces the reference: the artifact's
 * `artifactType` (e.g. `document`, `code`, `diagram`), its `content`, an
 * optional `title`, an optional existing `artifactId`, and the `target` panel
 * (always `artifact_editor`) the client should route it to.
 */
export interface ArtifactRenderedBlock extends RenderedBlockBase {
  kind: 'artifact';
  /** The artifact id when the block references an existing artifact. */
  artifactId?: string;
  /** Optional human-readable artifact title. */
  title?: string;
  /** The artifact's kind (e.g. `document`, `code`, `diagram`, `html`). */
  artifactType: string;
  /** The artifact body the Artifact_Editor opens for editing. */
  content: string;
  /** The client surface this artifact renders into. */
  target: 'artifact_editor';
}

/** A single search result entry in a {@link SearchResultsRenderedBlock}. */
export interface SearchResultItem {
  /** The result title. */
  title: string;
  /** The result URL. */
  url: string;
  /** An optional snippet/summary of the result. */
  snippet?: string;
}

/**
 * A list of web/search results rendered as structured entries.
 *
 * Included because `search_results` is a {@link ContentBlockType}; the renderer
 * normalizes the entries (escaping titles/snippets, keeping only safe URLs) so
 * the client can list them without re-sanitizing.
 */
export interface SearchResultsRenderedBlock extends RenderedBlockBase {
  kind: 'search_results';
  /** The normalized result entries. */
  items: SearchResultItem[];
}

/**
 * The universal fallback variant (Req 8.7, Property 23).
 *
 * Emitted whenever a block cannot be rendered — an unknown type, a malformed
 * payload, a failed validity check, or an unexpected error thrown by a
 * renderer. It carries the original {@link ContentBlock} (`original`), a raw
 * string the client can display verbatim (`raw`), the source block's `type`,
 * and a human-readable `reason`. Emitting this for one block never affects its
 * siblings — that isolation is the property task 8.10 validates.
 */
export interface RawRenderedBlock extends RenderedBlockBase {
  kind: 'raw';
  /** The original content block type this fallback stands in for. */
  sourceType: string;
  /** A verbatim, displayable rendering of the original content. */
  raw: string;
  /** The original content block, untouched, for clients that can recover. */
  original: ContentBlock;
  /** A human-readable explanation of why rendering fell back to raw. */
  reason: string;
}

/**
 * The Output_Renderer's result for a single {@link ContentBlock}: a
 * discriminated union on `kind` (Req 8.1-8.7). Consumers narrow on `kind`; the
 * `raw` variant is always a valid target so exhaustive handling is total.
 */
export type RenderedBlock =
  | MarkdownRenderedBlock
  | CodeRenderedBlock
  | MermaidRenderedBlock
  | LatexRenderedBlock
  | TableRenderedBlock
  | ArtifactRenderedBlock
  | SearchResultsRenderedBlock
  | RawRenderedBlock;
