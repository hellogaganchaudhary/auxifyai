/**
 * Mermaid diagram rendering support for the Output_Renderer (Req 8.3).
 *
 * Final SVG rendering of a Mermaid diagram happens **client-side** (the Mermaid
 * library needs a DOM), so a backend/SSR renderer cannot produce the SVG. What
 * it can — and should — do is carry the diagram *source* through to the client
 * together with a lightweight **validity check** and the detected diagram type,
 * so the client can render without re-parsing and an obviously-malformed
 * definition is caught here and falls back to raw content (Req 8.7) rather than
 * blowing up the client.
 */

import type { MermaidRenderedBlock } from './types.js';

/**
 * The Mermaid diagram-type keywords recognized by the validity check. A
 * definition must begin with one of these (after optional directives/comments)
 * to be considered a valid Mermaid diagram.
 */
const MERMAID_DIAGRAM_TYPES = [
  'graph',
  'flowchart',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'gitGraph',
  'quadrantChart',
  'requirementDiagram',
  'C4Context',
  'sankey',
  'xychart-beta',
] as const;

/** Strip leading Mermaid front-matter, `%%{ … }%%` directives, and `%%` comments. */
function stripDirectivesAndComments(source: string): string {
  return source
    .replace(/^\s*---[\s\S]*?---\s*/m, '') // YAML front-matter block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('%%'))
    .join('\n');
}

/**
 * The result of validating a Mermaid definition: whether it is renderable and,
 * when it is, the detected diagram-type keyword.
 */
export interface MermaidValidation {
  /** Whether the definition begins with a recognized diagram type and is non-empty. */
  valid: boolean;
  /** The detected diagram type when {@link valid}; otherwise `null`. */
  diagramType: string | null;
}

/**
 * Lightweight validity check for a Mermaid definition (Req 8.3).
 *
 * Confirms the definition is non-empty and its first meaningful token is a
 * recognized Mermaid diagram type. This is intentionally a *syntactic gate*,
 * not a full Mermaid parse — it is enough to detect the diagram type and to
 * reject content that is plainly not a diagram (so it falls back to raw).
 *
 * @param source The raw Mermaid definition.
 * @returns The validation outcome and detected diagram type.
 */
export function validateMermaid(source: string): MermaidValidation {
  const cleaned = stripDirectivesAndComments(source);
  if (cleaned === '') return { valid: false, diagramType: null };

  const firstToken = cleaned.split(/\s|\n/)[0] ?? '';
  const matched = MERMAID_DIAGRAM_TYPES.find(
    (type) => firstToken === type || cleaned.startsWith(type),
  );
  return matched ? { valid: true, diagramType: matched } : { valid: false, diagramType: null };
}

/**
 * Build the {@link MermaidRenderedBlock} for a valid Mermaid definition
 * (Req 8.3), carrying the source for client-side SVG rendering.
 *
 * @param source The raw Mermaid definition (already validated by the caller).
 * @param diagramType The detected diagram type from {@link validateMermaid}.
 * @returns The rendered Mermaid block descriptor.
 */
export function renderMermaid(
  source: string,
  diagramType: string,
): Omit<MermaidRenderedBlock, 'attribution'> {
  return { kind: 'mermaid', source, diagramType };
}
