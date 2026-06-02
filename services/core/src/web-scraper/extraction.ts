/**
 * Pure HTML content extraction for the Web_Scraper (Req 14.1, 14.3).
 *
 * Given a page's raw (untrusted) HTML, this module strips navigation and
 * advertisement boilerplate and converts the main content to structured
 * Markdown (Req 14.1), and supports the full set of extraction modes: full
 * text, main content, tables, links, and metadata (Req 14.3). It deliberately
 * uses a small, dependency-free tokenizer rather than a real DOM so the core
 * package keeps its single `@auxify/types` dependency and the extraction is
 * pure, total, and trivially unit-testable.
 *
 * SECURITY: the HTML is *untrusted external content*. It is treated as data
 * only — never evaluated — and all extracted text is normalized so it cannot
 * carry markup or scripts into the produced Markdown.
 */

import type { ExtractedLink, ExtractedTable, PageMetadata } from './types.js';
import { resolveUrl } from './url.js';

/**
 * The structural elements treated as navigation/advertisement boilerplate and
 * removed entirely for `main_content` extraction (Req 14.1).
 */
const BOILERPLATE_TAGS = [
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'noscript',
  'svg',
  'figure',
] as const;

/** Tags whose entire content is non-textual and removed for every mode. */
const NON_CONTENT_TAGS = ['script', 'style', 'template', 'iframe'] as const;

/**
 * Strip the elements (and their content) named in `tags` from `html`.
 *
 * @param html The HTML to clean.
 * @param tags The tag names whose elements (open→close) are removed.
 * @returns The HTML with those elements removed.
 */
function stripElements(html: string, tags: readonly string[]): string {
  let out = html;
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    out = out.replace(re, ' ');
    // Drop any self-closing/void occurrences too.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), ' ');
  }
  return out;
}

/**
 * Remove elements whose `class`/`id` strongly indicates advertisement or
 * navigation chrome (e.g. `class="ad-banner"`, `id="sidebar"`).
 *
 * This is a heuristic complement to {@link BOILERPLATE_TAGS}: many sites mark
 * ads/nav with `<div>`s rather than semantic tags. It only removes elements
 * with a balanced same-tag close to avoid corrupting the surrounding markup.
 */
function stripBoilerplateByAttribute(html: string): string {
  const pattern =
    /<(div|section|ul|span)\b[^>]*\b(?:class|id)\s*=\s*["'][^"']*\b(?:ad|ads|advert|advertisement|banner|sidebar|breadcrumb|navbar|menu|cookie|popup|promo|social-share)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;
  let out = html;
  let prev: string;
  // Iterate to a fixed point so nested matches are removed too.
  do {
    prev = out;
    out = out.replace(pattern, ' ');
  } while (out !== prev);
  return out;
}

/** Decode the common HTML entities found in extracted text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)));
}

/** Convert a numeric code point to a string, ignoring out-of-range values. */
function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return '';
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Strip every HTML tag from a fragment and decode entities, leaving plain text.
 *
 * @param html The HTML fragment.
 * @returns The decoded, tag-free text.
 */
export function htmlToText(html: string): string {
  return normalizeWhitespace(decodeEntities(html.replace(/<[^>]+>/g, ' ')));
}

/**
 * Collapse runs of whitespace and trim, the canonical content normalization
 * applied to every extracted string (Req 14.1).
 *
 * @param text The raw text.
 * @returns The text with internal whitespace runs collapsed to single spaces.
 */
export function normalizeWhitespace(text: string): string {
  return text
    // Collapse runs of horizontal whitespace (spaces, tabs, NBSP) to one space.
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    // Trim spaces around each newline without consuming adjacent newlines, so
    // paragraph breaks survive.
    .replace(/ *\n */g, '\n')
    // Collapse three or more consecutive newlines down to a single paragraph break.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract a page's metadata from its `<head>` and Open Graph/meta tags
 * (Req 14.3, `metadata` mode).
 *
 * @param html The full page HTML.
 * @returns The populated {@link PageMetadata} (absent fields left undefined).
 */
export function extractMetadata(html: string): PageMetadata {
  const meta: PageMetadata = {};

  const title = matchFirst(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const ogTitle = metaContent(html, 'og:title');
  const resolvedTitle = ogTitle ?? (title !== null ? htmlToText(title) : undefined);
  if (resolvedTitle !== undefined && resolvedTitle.length > 0) {
    meta.title = resolvedTitle;
  }

  const description = metaContent(html, 'description') ?? metaContent(html, 'og:description');
  if (description !== undefined) {
    meta.description = description;
  }

  const siteName = metaContent(html, 'og:site_name');
  if (siteName !== undefined) {
    meta.siteName = siteName;
  }

  const author = metaContent(html, 'author') ?? metaContent(html, 'article:author');
  if (author !== undefined) {
    meta.author = author;
  }

  const published = metaContent(html, 'article:published_time') ?? metaContent(html, 'date');
  if (published !== undefined) {
    meta.publishedDate = published;
  }

  const imageUrl = metaContent(html, 'og:image');
  if (imageUrl !== undefined) {
    meta.imageUrl = imageUrl;
  }

  const canonical =
    matchFirst(html, /<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i) ??
    metaContent(html, 'og:url');
  if (canonical !== undefined && canonical !== null) {
    meta.canonicalUrl = decodeEntities(canonical);
  }

  const lang = matchFirst(html, /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  if (lang !== null) {
    meta.language = lang.trim();
  }

  return meta;
}

/** Read a `<meta>` tag's `content` by `name` or `property` (order-insensitive). */
function metaContent(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byNameFirst = new RegExp(
    `<meta\\b[^>]*\\b(?:name|property)\\s*=\\s*["']${escaped}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const byContentFirst = new RegExp(
    `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b(?:name|property)\\s*=\\s*["']${escaped}["']`,
    'i',
  );
  const m = html.match(byNameFirst) ?? html.match(byContentFirst);
  if (m?.[1] === undefined) {
    return undefined;
  }
  const value = decodeEntities(m[1]).trim();
  return value.length > 0 ? value : undefined;
}

/** Return the first capture group of `re` in `html`, or `null`. */
function matchFirst(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m?.[1] ?? null;
}

/**
 * Extract every hyperlink from the page, resolving relative targets against
 * `baseUrl` (Req 14.3, `links` mode).
 *
 * @param html The page HTML.
 * @param baseUrl The page URL relative links resolve against.
 * @returns The extracted links, in document order.
 */
export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawHref = (m[1] ?? '').trim();
    if (rawHref.length === 0 || rawHref.startsWith('#') || rawHref.toLowerCase().startsWith('javascript:')) {
      continue;
    }
    const text = htmlToText(m[2] ?? '');
    links.push({ text, href: resolveUrl(decodeEntities(rawHref), baseUrl) });
  }
  return links;
}

/**
 * Extract every data table from the page (Req 14.3, `tables` mode).
 *
 * @param html The page HTML.
 * @returns The extracted tables, in document order.
 */
export function extractTables(html: string): ExtractedTable[] {
  const tables: ExtractedTable[] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(html)) !== null) {
    const body = tm[1] ?? '';
    const rows: string[][] = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(body)) !== null) {
      const cells: string[] = [];
      const cellRe = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1] ?? '')) !== null) {
        cells.push(htmlToText(cm[2] ?? ''));
      }
      if (cells.length > 0) {
        rows.push(cells);
      }
    }
    if (rows.length === 0) {
      continue;
    }
    // Treat the first row as a header when it came from <th> cells.
    const firstRowIsHeader = /<th\b/i.test(firstRowHtml(body));
    const headers = firstRowIsHeader ? (rows[0] ?? []) : [];
    const dataRows = firstRowIsHeader ? rows.slice(1) : rows;
    tables.push({ headers, rows: dataRows });
  }
  return tables;
}

/** Return the HTML of the first `<tr>` in a table body, for header detection. */
function firstRowHtml(tableBody: string): string {
  const m = tableBody.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
  return m?.[0] ?? '';
}

/**
 * Convert a content HTML fragment to structured Markdown (Req 14.1).
 *
 * Headings, paragraphs, list items, blockquotes, code, and inline emphasis are
 * mapped to their Markdown equivalents; links become `[text](href)`; everything
 * else degrades to its text. The result is whitespace-normalized.
 *
 * @param html The (already boilerplate-stripped) content HTML.
 * @param baseUrl The page URL relative links resolve against.
 * @returns The Markdown rendering of the content.
 */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  let out = html;

  // Headings → `#`..`######`.
  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const hashes = '#'.repeat(Number.parseInt(level, 10));
    return `\n\n${hashes} ${htmlToText(inner)}\n\n`;
  });

  // Block quotes.
  out = out.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    return `\n\n> ${htmlToText(inner)}\n\n`;
  });

  // Preformatted/code blocks.
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, ''));
    return `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`;
  });

  // List items.
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${htmlToText(inner)}`);

  // Links → Markdown links (resolved, with safe-ish targets).
  out = out.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const text = htmlToText(inner);
      const target = decodeEntities(href.trim());
      if (target.length === 0 || target.toLowerCase().startsWith('javascript:')) {
        return text;
      }
      return `[${text}](${resolveUrl(target, baseUrl)})`;
    },
  );

  // Inline emphasis.
  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => `**${htmlToText(inner)}**`);
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => `*${htmlToText(inner)}*`);
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${htmlToText(inner)}\``);

  // Paragraph and line-break boundaries.
  out = out.replace(/<\/(p|div|section|article|tr|h[1-6])>/gi, '\n\n');
  out = out.replace(/<br\b[^>]*\/?>/gi, '\n');

  // Drop any remaining tags, decode, normalize.
  out = decodeEntities(out.replace(/<[^>]+>/g, ' '));
  return normalizeWhitespace(out);
}

/**
 * Reduce a full page to the HTML fragment most likely to be its main content
 * (Req 14.1).
 *
 * Prefers an explicit `<main>` or `<article>` region; otherwise falls back to
 * the `<body>` with navigation/advertisement boilerplate stripped.
 *
 * @param html The full page HTML (already free of `<script>`/`<style>`).
 * @returns The main-content HTML fragment.
 */
export function selectMainContent(html: string): string {
  const main = matchFirst(html, /<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main !== null && htmlToText(main).length > 0) {
    return stripBoilerplateByAttribute(main);
  }
  const article = matchFirst(html, /<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article !== null && htmlToText(article).length > 0) {
    return stripBoilerplateByAttribute(article);
  }
  const body = matchFirst(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i) ?? html;
  return stripBoilerplateByAttribute(stripElements(body, BOILERPLATE_TAGS));
}

/**
 * Remove the always-non-content elements (`<script>`, `<style>`, …) from raw
 * HTML before any extraction (Req 14.1).
 *
 * @param html The raw page HTML.
 * @returns The HTML with non-content elements removed.
 */
export function stripNonContent(html: string): string {
  return stripElements(html, NON_CONTENT_TAGS);
}

/** Render extracted tables as GitHub-flavoured Markdown table blocks (Req 14.1, 14.3). */
export function tablesToMarkdown(tables: readonly ExtractedTable[]): string {
  return tables
    .map((table) => {
      const columnCount = Math.max(
        table.headers.length,
        ...table.rows.map((r) => r.length),
        0,
      );
      if (columnCount === 0) {
        return '';
      }
      const headers =
        table.headers.length > 0
          ? table.headers
          : Array.from({ length: columnCount }, (_v, i) => `Column ${i + 1}`);
      const headerLine = `| ${pad(headers, columnCount).join(' | ')} |`;
      const sepLine = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
      const bodyLines = table.rows.map((row) => `| ${pad(row, columnCount).join(' | ')} |`);
      return [headerLine, sepLine, ...bodyLines].join('\n');
    })
    .filter((block) => block.length > 0)
    .join('\n\n');
}

/** Render extracted links as a Markdown bullet list (Req 14.1, 14.3). */
export function linksToMarkdown(links: readonly ExtractedLink[]): string {
  return links
    .map((link) => `- [${link.text.length > 0 ? link.text : link.href}](${link.href})`)
    .join('\n');
}

/** Render page metadata as a Markdown key/value block (Req 14.1, 14.3). */
export function metadataToMarkdown(meta: PageMetadata): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === 'string' && value.length > 0) {
      lines.push(`- **${key}**: ${value}`);
    }
  }
  return lines.join('\n');
}

/** Pad/truncate a cell list to exactly `count` columns. */
function pad(cells: readonly string[], count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push((cells[i] ?? '').replace(/\|/g, '\\|'));
  }
  return out;
}
