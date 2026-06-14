/**
 * Deterministic Markdown → {@link DocumentSpec} converter.
 *
 * Powers the "export any answer as a designed document" path: a chat reply
 * (Markdown) is converted into the same structured spec the AI document
 * engine produces — cover, section dividers, bullets, tables, quotes and a
 * closing — and then rendered by the design-aware renderers. No model call is
 * made, so the conversion is instant, free, and fully reproducible while
 * keeping Gamma-quality themed output.
 */

import { marked, type Token, type Tokens } from 'marked';

import {
  selectTemplate,
  THEME_IDS,
  type DocumentSection,
  type DocumentSpec,
  type ThemeId,
} from './document-design';

/** Options for {@link specFromMarkdown}. */
export interface MarkdownSpecOptions {
  /** Title override (otherwise the first H1 / first heading / fallback). */
  title?: string;
  /** Theme override; defaults to the auto-selected template's theme. */
  themeId?: string;
  /** Branding overrides forwarded onto the spec. */
  brand?: DocumentSpec['brand'];
}

/** Strip inline Markdown emphasis/links/images down to plain text. */
function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read a `{ text }`-ish cell from marked's table tokens. */
function cellText(cell: unknown): string {
  if (typeof cell === 'string') return plain(cell);
  if (cell !== null && typeof cell === 'object' && 'text' in cell) {
    return plain(String((cell as { text: unknown }).text ?? ''));
  }
  return '';
}

/** Flatten a list token into plain-text items (nested lists are inlined). */
function listItems(token: Tokens.List): string[] {
  const items: string[] = [];
  for (const item of token.items) {
    const text = plain(item.text.split('\n')[0] ?? item.text);
    if (text.length > 0) items.push(text.length > 320 ? `${text.slice(0, 317)}…` : text);
  }
  return items;
}

/** Headings that signal a closing slide/page. */
const CLOSING_RE = /^(thank\s*you|questions?|q\s*&\s*a)\b/i;

/** Mutable builder for the section currently being assembled. */
interface SectionDraft {
  title?: string;
  bullets: string[];
  paragraphs: string[];
  table?: { header: string[]; rows: string[][] };
  quote?: { text: string; attribution?: string };
  notes?: string;
}

/** True when the draft holds no renderable content yet. */
function isEmptyDraft(d: SectionDraft): boolean {
  return (
    d.bullets.length === 0 &&
    d.paragraphs.length === 0 &&
    d.table === undefined &&
    d.quote === undefined
  );
}

/**
 * Flush a draft into one or more {@link DocumentSection}s, choosing the layout
 * that best matches its content (table > quote > bullets > paragraph).
 */
function flushDraft(d: SectionDraft, out: DocumentSection[]): void {
  if (d.title === undefined && isEmptyDraft(d)) return;

  const title = d.title;
  const body = d.paragraphs.join('\n\n').trim();
  const clampedBody = body.length > 2400 ? `${body.slice(0, 2397)}…` : body;

  if (d.table !== undefined) {
    out.push({
      layout: 'table',
      ...(title !== undefined ? { title } : {}),
      table: d.table,
      ...(clampedBody.length > 0 ? { body: clampedBody } : {}),
      ...(d.bullets.length > 0 ? { bullets: d.bullets.slice(0, 8) } : {}),
    });
    return;
  }
  if (d.quote !== undefined && d.bullets.length === 0 && clampedBody.length === 0) {
    out.push({ layout: 'quote', ...(title !== undefined ? { title } : {}), quote: d.quote });
    return;
  }
  if (d.bullets.length > 0) {
    // Split long bullet runs into continued sections of at most 8.
    const chunks: string[][] = [];
    for (let i = 0; i < d.bullets.length; i += 8) chunks.push(d.bullets.slice(i, i + 8));
    chunks.forEach((bullets, i) => {
      out.push({
        layout: 'bullets',
        ...(title !== undefined ? { title: i === 0 ? title : `${title} (cont.)` } : {}),
        bullets,
        ...(i === 0 && clampedBody.length > 0 ? { body: clampedBody } : {}),
      });
    });
    if (d.quote !== undefined) {
      out.push({ layout: 'quote', quote: d.quote });
    }
    return;
  }
  if (clampedBody.length > 0 || title !== undefined) {
    out.push({
      layout: 'paragraph',
      ...(title !== undefined ? { title } : {}),
      body: clampedBody.length > 0 ? clampedBody : ' ',
      ...(d.quote !== undefined ? { quote: d.quote } : {}),
    });
  }
}

/**
 * Convert Markdown into a render-ready, themed {@link DocumentSpec}.
 *
 * Mapping: first H1 → cover (next paragraph becomes the subtitle); later H1s →
 * section dividers; H2/H3 → content sections; lists → bullets; tables → table
 * layouts; blockquotes → quotes; closing headings ("Thank You", "Q&A") →
 * closing layout. Code blocks become speaker notes.
 */
export function specFromMarkdown(markdown: string, opts: MarkdownSpecOptions = {}): DocumentSpec {
  const tokens = marked.lexer(markdown) as Token[];
  const sections: DocumentSection[] = [];

  let coverTitle: string | undefined;
  let coverSubtitle: string | undefined;
  let sawCover = false;
  let awaitingSubtitle = false;

  let draft: SectionDraft = { bullets: [], paragraphs: [] };
  const flush = (): void => {
    flushDraft(draft, sections);
    draft = { bullets: [], paragraphs: [] };
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const t = token as Tokens.Heading;
        const text = plain(t.text);
        if (text.length === 0) break;
        if (t.depth === 1 && !sawCover) {
          sawCover = true;
          awaitingSubtitle = true;
          coverTitle = text;
          break;
        }
        flush();
        awaitingSubtitle = false;
        if (CLOSING_RE.test(text)) {
          sections.push({ layout: 'closing', title: text });
          break;
        }
        if (t.depth === 1) {
          sections.push({ layout: 'section-divider', title: text });
          break;
        }
        draft.title = text.length > 160 ? `${text.slice(0, 157)}…` : text;
        break;
      }
      case 'paragraph': {
        const text = plain((token as Tokens.Paragraph).text);
        if (text.length === 0) break;
        if (awaitingSubtitle) {
          coverSubtitle = text.length > 220 ? `${text.slice(0, 217)}…` : text;
          awaitingSubtitle = false;
          break;
        }
        draft.paragraphs.push(text);
        break;
      }
      case 'list': {
        awaitingSubtitle = false;
        draft.bullets.push(...listItems(token as Tokens.List));
        break;
      }
      case 'table': {
        awaitingSubtitle = false;
        const t = token as Tokens.Table;
        const header = t.header.map(cellText).filter((h) => h.length > 0);
        const rows = t.rows
          .slice(0, 30)
          .map((row) => row.map(cellText))
          .filter((row) => row.some((c) => c.length > 0));
        if (header.length > 0 && rows.length > 0) {
          // A table gets its own section; flush text gathered so far first.
          const title = draft.title;
          if (!isEmptyDraft(draft)) {
            flush();
          } else {
            draft = { bullets: [], paragraphs: [] };
          }
          flushDraft({ title, bullets: [], paragraphs: [], table: { header, rows } }, sections);
        }
        break;
      }
      case 'blockquote': {
        awaitingSubtitle = false;
        const raw = (token as Tokens.Blockquote).text;
        const lines = raw.split('\n').map(plain).filter((l) => l.length > 0);
        const joined = lines.join(' ');
        const attribution = /[—–-]\s*([^—–-]+)$/.exec(joined)?.[1]?.trim();
        const text = attribution !== undefined ? joined.replace(/[—–-]\s*[^—–-]+$/, '').trim() : joined;
        if (text.length > 0) {
          draft.quote = {
            text: text.length > 400 ? `${text.slice(0, 397)}…` : text,
            ...(attribution !== undefined && attribution.length > 0 && attribution.length <= 80
              ? { attribution }
              : {}),
          };
        }
        break;
      }
      case 'code': {
        const text = (token as Tokens.Code).text.trim();
        if (text.length > 0) draft.notes = text.slice(0, 1200);
        break;
      }
      case 'hr': {
        flush();
        break;
      }
      default:
        break;
    }
  }
  flush();

  // Title fallbacks: explicit option → first H1 → first section title.
  const title =
    opts.title?.trim() ??
    coverTitle ??
    sections.find((s) => s.title !== undefined)?.title ??
    'Document';

  // Theme: explicit override → keyword-matched template default.
  const template = selectTemplate(`${title} ${markdown.slice(0, 400)}`);
  const themeId: ThemeId =
    opts.themeId !== undefined && THEME_IDS.includes(opts.themeId as ThemeId)
      ? (opts.themeId as ThemeId)
      : template.defaultTheme;

  // Assemble: cover first, then content, then ensure a closing for decks.
  const assembled: DocumentSection[] = [
    {
      layout: 'cover',
      title: title.length > 160 ? `${title.slice(0, 157)}…` : title,
      ...(coverSubtitle !== undefined ? { subtitle: coverSubtitle } : {}),
    },
    ...sections.slice(0, 39),
  ];
  if (assembled.length < 2) {
    assembled.push({ layout: 'paragraph', title: 'Overview', body: plain(markdown).slice(0, 2400) });
  }

  return {
    docType: template.id,
    themeId,
    title: assembled[0]!.title ?? 'Document',
    ...(coverSubtitle !== undefined ? { subtitle: coverSubtitle } : {}),
    date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' }),
    sections: assembled,
    ...(opts.brand !== undefined ? { brand: opts.brand } : {}),
  };
}
