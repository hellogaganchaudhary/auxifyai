/**
 * Output_Renderer (Req 8.1-8.7).
 *
 * The Output_Renderer turns each model-emitted {@link import('@auxify/types').ContentBlock}
 * into a structured, transport-stable, **browser-free** {@link RenderedBlock}
 * descriptor that the web client renders to its final form (DOM/SVG/KaTeX).
 * Running with no DOM means it works identically under SSR and in tests.
 *
 * Surface:
 *   - {@link OutputRenderer} / {@link outputRenderer} — the renderer. `render`
 *     handles a single block (GFM, code+copy, Mermaid, LaTeX, sortable+exportable
 *     tables, artifacts, search results — Req 8.1-8.6) and *never throws*;
 *     `renderAll` renders a response, isolating per-block failures so one
 *     failing block becomes a `raw` fallback while its siblings render
 *     normally (Req 8.7, Property 23, task 8.10).
 *   - {@link RenderedBlock} — the discriminated union (per-type variants plus
 *     the universal `raw` fallback) and its member/field types.
 *   - The per-type helpers ({@link renderMarkdownToHtml}, {@link renderCode},
 *     {@link validateMermaid}/{@link renderMermaid},
 *     {@link validateLatex}/{@link renderLatex},
 *     {@link renderTable}/{@link sortRows}/{@link toCsv}) — pure functions the
 *     renderer composes, exported for direct use and focused testing.
 *
 * Design note: code highlighting, Mermaid, and LaTeX are represented
 * *structurally* (detected language + escaped text + copyable raw string;
 * validated source for client-side Mermaid/KaTeX) rather than by adding a heavy
 * syntax-highlighter or headless browser, keeping `@auxify/core` dependency-free
 * and the renderer pure and synchronous.
 */

export { OutputRenderer, outputRenderer, toRawBlock } from './output-renderer.js';

export {
  type RenderedBlock,
  type RenderedBlockKind,
  type MarkdownRenderedBlock,
  type CodeRenderedBlock,
  type MermaidRenderedBlock,
  type LatexRenderedBlock,
  type TableRenderedBlock,
  type ArtifactRenderedBlock,
  type SearchResultsRenderedBlock,
  type RawRenderedBlock,
  type TableColumn,
  type TableSort,
  type SortDirection,
  type SearchResultItem,
} from './types.js';

export { renderMarkdownToHtml } from './markdown.js';
export { renderCode, DEFAULT_CODE_LANGUAGE, type CodeBlockData } from './code.js';
export { validateMermaid, renderMermaid, type MermaidValidation } from './mermaid.js';
export { validateLatex, renderLatex, type LatexValidation, type LatexBlockData } from './latex.js';
export { renderTable, sortRows, toCsv, type TableBlockData } from './table.js';
export { escapeHtml, escapeAttribute, isSafeUrl } from './html.js';
