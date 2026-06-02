/**
 * Message content and source-attribution domain types.
 *
 * `ContentBlock` is the unit of renderable model output, and
 * `SourceAttribution` carries the complete provenance required for any
 * retrieval-augmented content (Req 24.4, 24.6). Both are shared by the
 * Chat_Service, the Output_Renderer, the RAG_Retriever, the Client_SDK, and the
 * web client (Req 46.8).
 */

/**
 * The renderable kinds of a {@link ContentBlock}.
 *
 * The Output_Renderer renders each kind specially (GFM, syntax-highlighted
 * code, Mermaid, LaTeX, sortable tables, artifacts, search results) and falls
 * back to raw content for any block that fails to render (Req 8.1-8.7).
 */
export type ContentBlockType =
  | 'markdown'
  | 'code'
  | 'mermaid'
  | 'latex'
  | 'table'
  | 'artifact'
  | 'search_results';

/** All {@link ContentBlockType} values, for iteration, validation, and test generators. */
export const CONTENT_BLOCK_TYPES: readonly ContentBlockType[] = [
  'markdown',
  'code',
  'mermaid',
  'latex',
  'table',
  'artifact',
  'search_results',
] as const;

/**
 * Complete provenance for a piece of retrieved or cited content.
 *
 * Every RAG-attributed chunk and every cited source carries a full attribution
 * so the platform can always show where an answer came from (Req 24.4, 24.6).
 * All fields are required: partial attribution is not permitted.
 */
export interface SourceAttribution {
  /** The id of the source (knowledge source, document, file, URL record, etc.). */
  sourceId: string;
  /** Human-readable title of the source. */
  sourceTitle: string;
  /** Where within the source the content was found (e.g. page, section, line range). */
  location: string;
  /** A resolvable link back to the source. */
  link: string;
}

/**
 * A single unit of message content.
 *
 * A message is an ordered list of content blocks; each block has a `type` that
 * selects how it is rendered and a `data` payload whose concrete shape depends
 * on that type (kept `unknown` so the shared type is transport-stable while
 * renderers narrow it). Retrieval-augmented blocks carry one
 * {@link SourceAttribution} per cited source (Req 24.4, 24.5).
 */
export interface ContentBlock {
  /** The kind of content, selecting how it is rendered. */
  type: ContentBlockType;
  /** The block payload; concrete shape depends on {@link ContentBlock.type}. */
  data: unknown;
  /** Complete source attributions for retrieval-augmented content (Req 24.4, 24.5). */
  attribution?: SourceAttribution[];
}
