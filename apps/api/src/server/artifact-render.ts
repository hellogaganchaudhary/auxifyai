/**
 * Visual artifact rendering.
 *
 * Text-only models (and many chat models when asked to "draw" or "illustrate"
 * something) cannot emit raster images — but they CAN emit vector markup: an
 * `<svg>` document or a small self-contained HTML/CSS scene. Left as a fenced
 * code block, that markup shows up as text the user has to copy out and open
 * elsewhere. This module turns that markup into something the product can show
 * inline as an actual picture.
 *
 * It does two things:
 *
 *   1. {@link extractVisualArtifacts} — scans an assistant message for visual
 *      markup: fenced ```svg / ```html / ```xml blocks and bare `<svg>…</svg>`
 *      runs, returning each as a {@link VisualArtifact}.
 *   2. Conversion — every artifact carries a `dataUri` (an `image/svg+xml` or
 *      `text/html` data URL) that a browser `<img>`/`<iframe>` can render
 *      directly, with no image-generation model and no native rasterizer
 *      required.
 *
 * Everything is sanitized before it becomes a data URI: `<script>` blocks,
 * inline `on*` event handlers, and `javascript:` URLs are stripped so a
 * rendered artifact cannot execute code in the app's origin. The module is
 * pure and dependency-free so it is trivially unit-testable.
 */

/** The kinds of visual markup the extractor recognizes. */
export type ArtifactKind = 'svg' | 'html';

/** A single renderable visual artifact pulled from assistant text. */
export interface VisualArtifact {
  /** Which markup language the artifact is written in. */
  kind: ArtifactKind;
  /** The sanitized source markup. */
  source: string;
  /** The MIME type of {@link dataUri} (`image/svg+xml` or `text/html`). */
  mimeType: string;
  /** A `data:` URL a browser can render directly as an image/preview. */
  dataUri: string;
  /** A short human label, derived from a `<title>`/`<desc>` when present. */
  title?: string;
}

/** MIME type per artifact kind. */
const MIME: Record<ArtifactKind, string> = {
  svg: 'image/svg+xml',
  html: 'text/html',
};

/**
 * Remove the obviously-dangerous bits from model-authored markup before it is
 * rendered: `<script>` elements, inline `on*=` event handlers, and
 * `javascript:` URIs. This is defense-in-depth — artifacts are rendered in a
 * sandboxed context by the client — not a full HTML sanitizer.
 */
export function sanitizeMarkup(markup: string): string {
  return markup
    // Drop <script>…</script> (including unclosed trailing scripts).
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    // Drop inline event handlers: on-click="…", onload='…', onmouseover=… .
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    // Neutralize javascript: URLs in href/src/xlink:href.
    .replace(/((?:href|src|xlink:href)\s*=\s*)(['"]?)\s*javascript:[^'">\s]*/gi, '$1$2#')
    .trim();
}

/** UTF-8-safe base64 (works for the unicode the model may emit in labels). */
function toBase64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

/** Build a `data:` URL for a piece of sanitized markup of the given kind. */
function toDataUri(kind: ArtifactKind, markup: string): string {
  return `data:${MIME[kind]};base64,${toBase64(markup)}`;
}

/** Pull a friendly label from an SVG `<title>`/`<desc>` or HTML `<title>`. */
function deriveTitle(markup: string): string | undefined {
  const match =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(markup) ??
    /<desc[^>]*>([\s\S]*?)<\/desc>/i.exec(markup);
  if (match === null || match[1] === undefined) {
    return undefined;
  }
  const text = match[1].replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

/** Build a fully-formed {@link VisualArtifact} from raw markup. */
function makeArtifact(kind: ArtifactKind, rawMarkup: string): VisualArtifact {
  const source = sanitizeMarkup(rawMarkup);
  const title = deriveTitle(source);
  return {
    kind,
    source,
    mimeType: MIME[kind],
    dataUri: toDataUri(kind, source),
    ...(title !== undefined ? { title } : {}),
  };
}

/** Whether a fenced block's info-string denotes SVG markup. */
function fenceIsSvg(lang: string, body: string): boolean {
  const l = lang.toLowerCase();
  if (l === 'svg') return true;
  return (l === 'xml' || l === '') && /<svg[\s>]/i.test(body);
}

/** Whether a fenced block's info-string denotes a renderable HTML scene. */
function fenceIsHtml(lang: string): boolean {
  const l = lang.toLowerCase();
  return l === 'html' || l === 'htm';
}

/**
 * Extract every renderable visual artifact from an assistant message.
 *
 * Recognizes, in order of preference:
 *   - fenced code blocks: ```svg, ```html, and ```xml/``` blocks whose body
 *     opens with an `<svg>` element;
 *   - bare `<svg>…</svg>` documents that appear outside any fence.
 *
 * Duplicate sources are de-duplicated so a block that matches both a fence and
 * the bare-SVG scan is only returned once. The original text is never mutated;
 * callers decide whether to keep, replace, or annotate the source block.
 */
export function extractVisualArtifacts(text: string): VisualArtifact[] {
  const artifacts: VisualArtifact[] = [];
  const seen = new Set<string>();

  const push = (kind: ArtifactKind, markup: string): void => {
    const trimmed = markup.trim();
    if (trimmed.length === 0) return;
    const artifact = makeArtifact(kind, trimmed);
    if (seen.has(artifact.source)) return;
    seen.add(artifact.source);
    artifacts.push(artifact);
  };

  // 1) Fenced code blocks. The info-string may carry extra tokens after the
  //    language (e.g. ```svg file=doraemon.svg) — only the first token matters.
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  const fencedRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    fencedRanges.push([m.index, m.index + m[0].length]);
    const info = (m[1] ?? '').trim();
    const lang = info.split(/\s+/)[0] ?? '';
    const body = m[2] ?? '';
    if (fenceIsSvg(lang, body)) {
      push('svg', body);
    } else if (fenceIsHtml(lang)) {
      push('html', body);
    }
  }

  // 2) Bare <svg>…</svg> documents outside any fenced block.
  const bare = /<svg\b[\s\S]*?<\/svg\s*>/gi;
  while ((m = bare.exec(text)) !== null) {
    const start = m.index;
    const insideFence = fencedRanges.some(([a, b]) => start >= a && start < b);
    if (!insideFence) {
      push('svg', m[0]);
    }
  }

  return artifacts;
}
