/**
 * A small, dependency-free GitHub-Flavored Markdown renderer (Req 8.1).
 *
 * Task 8.9 explicitly allows either a pinned lightweight dependency or a
 * self-contained structured representation; this module takes the second,
 * documented path so `@auxify/core` stays dependency-free and the renderer
 * stays pure, synchronous, and browser-free. It covers the GFM subset the
 * acceptance criterion names — **headings, lists, links, and tables** (Req 8.1)
 * — plus the everyday inline constructs (bold, italic, inline code) and
 * paragraphs, which is the realistic floor for "render the formatted Markdown".
 *
 * Every piece of model text is HTML-escaped before it reaches the output and
 * link targets are screened by {@link isSafeUrl}, so the emitted fragment is
 * safe to inject (XSS defence on the output path). Anything genuinely
 * unsupported simply renders as escaped text rather than throwing — block-level
 * failure isolation is handled one layer up by the renderer (Req 8.7).
 */

import { escapeHtml, escapeAttribute, isSafeUrl } from './html.js';

/** Render the GFM inline constructs (links, bold, italic, code) within one line of text. */
function renderInline(text: string): string {
  // Inline code spans are extracted first and protected from further inline
  // processing so their contents render verbatim.
  // Sentinels use private-use code points (not control characters) so they
  // never collide with normal text and never trip control-char lint rules.
  const codeSpans: string[] = [];
  let working = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const token = `\uE000CODE${codeSpans.length}\uE001`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  // Escape everything else, then re-introduce the safe inline markup.
  working = escapeHtml(working);

  // Links: [label](url). The label and url are already HTML-escaped above;
  // unsafe schemes degrade to plain label text.
  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
    isSafeUrl(url) ? `<a href="${escapeAttribute(url)}">${label}</a>` : label,
  );

  // Bold (**x**) before italic (*x*) so the longer delimiter wins.
  working = working.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  working = working.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  working = working.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Restore protected inline-code spans.
  working = working.replace(
    /\uE000CODE(\d+)\uE001/g,
    (_match, i: string) => codeSpans[Number(i)] ?? '',
  );

  return working;
}

/** Whether a line is a GFM table delimiter row, e.g. `| --- | :--: |`. */
function isTableDelimiter(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

/** Split a GFM table row into trimmed cell texts. */
function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * Render a GFM Markdown string to a sanitized HTML fragment (Req 8.1).
 *
 * The renderer is line-oriented: it walks the source once, grouping consecutive
 * lines into headings, fenced code, lists, tables, and paragraphs. It always
 * returns a string (never throws) for well-formed input; the caller wraps the
 * call so any unexpected failure still degrades to a raw block (Req 8.7).
 *
 * @param markdown The GFM source text.
 * @returns A sanitized HTML fragment.
 */
export function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Blank line: skip.
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Fenced code block: ```lang ... ```
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const lang = (fence[1] ?? '').trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // consume closing fence (or end of input)
      const langAttr = lang ? ` class="language-${escapeAttribute(lang)}"` : '';
      out.push(`<pre><code${langAttr}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // ATX heading: #..###### text
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      out.push(`<h${level}>${renderInline((heading[2] ?? '').trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // GFM table: a header row followed by a delimiter row.
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1] ?? '')) {
      const headerCells = splitRow(line);
      i += 2; // header + delimiter
      const bodyRows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        bodyRows.push(splitRow(lines[i] ?? ''));
        i += 1;
      }
      const head = headerCells.map((c) => `<th>${renderInline(c)}</th>`).join('');
      const body = bodyRows
        .map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        const item = (lines[i] ?? '').replace(/^\s*[-*+]\s+/, '');
        items.push(`<li>${renderInline(item)}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
        const item = (lines[i] ?? '').replace(/^\s*\d+\.\s+/, '');
        items.push(`<li>${renderInline(item)}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-structural lines.
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      const current = lines[i] ?? '';
      if (
        /^(#{1,6})\s+/.test(current) ||
        /^\s*[-*+]\s+/.test(current) ||
        /^\s*\d+\.\s+/.test(current) ||
        /^\s*```/.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      i += 1;
    }
    if (paragraph.length > 0) {
      out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    }
  }

  return out.join('\n');
}
