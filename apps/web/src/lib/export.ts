'use client';

/**
 * Artifact preview + multi-format export helpers.
 *
 * Lets a generated file be previewed live and downloaded in a chosen format
 * rather than only its raw form. The conversions that genuinely work in the
 * browser without heavy dependencies are:
 *
 *   - **Original** — the raw bytes with the file's own extension.
 *   - **HTML**     — Markdown is converted to a styled HTML document; HTML is
 *                    taken as-is.
 *   - **PDF**      — rendered in a hidden iframe and sent to the browser's
 *                    native "Save as PDF" via the print dialog (works for HTML
 *                    and Markdown; the user picks the destination).
 *   - **Text**     — the raw content as `.txt`.
 *
 * PDF uses the print path deliberately: it produces faithful, selectable PDFs
 * from real HTML layout without bundling a renderer. The caller is told this is
 * a print-to-PDF flow so expectations are clear.
 */

import { downloadText } from '@/components/CodeBlock';

/** A file's broad preview kind, derived from its extension/language. */
export type PreviewKind = 'html' | 'markdown' | 'svg' | 'image' | 'code';

/** The export formats offered for a given file. */
export type ExportFormat = 'original' | 'html' | 'pdf' | 'text';

/** Decide how a file should be previewed. */
export function previewKind(filename: string, language: string): PreviewKind {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const lang = language.toLowerCase();
  if (ext === 'html' || ext === 'htm' || lang === 'html') return 'html';
  if (ext === 'md' || ext === 'markdown' || lang === 'markdown' || lang === 'md') return 'markdown';
  if (ext === 'svg' || lang === 'svg') return 'svg';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  return 'code';
}

/** The export formats that make sense for a given preview kind. */
export function formatsFor(kind: PreviewKind): ExportFormat[] {
  switch (kind) {
    case 'html':
    case 'markdown':
      return ['original', 'html', 'pdf', 'text'];
    case 'svg':
      return ['original', 'html', 'pdf'];
    default:
      return ['original', 'text'];
  }
}

/** Human label for a format option. */
export function formatLabel(format: ExportFormat): string {
  switch (format) {
    case 'original':
      return 'Original';
    case 'html':
      return 'HTML (.html)';
    case 'pdf':
      return 'PDF (print)';
    case 'text':
      return 'Text (.txt)';
  }
}

/** Minimal, clean print stylesheet wrapped around body HTML. */
function htmlDocument(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         line-height: 1.6; color: #14181f; max-width: 820px; margin: 40px auto; padding: 0 24px; }
  h1, h2, h3 { line-height: 1.25; }
  pre { background: #f4f6fa; padding: 14px; border-radius: 8px; overflow: auto; }
  code { font-family: ui-monospace, Menlo, Consolas, monospace; }
  img, svg { max-width: 100%; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #dfe4ec; padding: 6px 10px; text-align: left; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/** Escape text for safe HTML embedding. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Very small Markdown→HTML conversion (headings, bold, code, lists, paras). */
function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        out.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(li[1]!)}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (line.trim().length === 0) {
      out.push('');
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</code></pre>');
  return out.join('\n');

  function inline(text: string): string {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  }
}

/** Produce a full HTML document string for a file (used by HTML + PDF export). */
export function toHtmlDocument(filename: string, content: string, kind: PreviewKind): string {
  if (kind === 'html') return content;
  if (kind === 'svg') return htmlDocument(filename, content);
  if (kind === 'markdown') return htmlDocument(filename, markdownToHtml(content));
  return htmlDocument(filename, `<pre><code>${escapeHtml(content)}</code></pre>`);
}

/** Print-to-PDF: render the document in a hidden iframe and open the print dialog. */
export function exportPdf(filename: string, content: string, kind: PreviewKind): void {
  const baseHtml = toHtmlDocument(filename, content, kind);
  // Inject a print-color-adjust rule so the browser KEEPS background colors,
  // gradients, and shadows when printing to PDF (by default it strips them,
  // which is what makes the output look washed-out / dull). Also set sensible
  // page margins. This is injected for every export path, including raw HTML.
  const html = injectPrintFidelity(baseHtml);

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (doc === undefined) {
    document.body.removeChild(iframe);
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  // Give the iframe a tick to lay out, then print and clean up.
  const win = iframe.contentWindow;
  const cleanup = () => {
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 500);
  };
  if (win) {
    win.onafterprint = cleanup;
    setTimeout(() => {
      win.focus();
      win.print();
      // Fallback cleanup if onafterprint never fires (some browsers).
      setTimeout(cleanup, 60_000);
    }, 250);
  } else {
    cleanup();
  }
}

/**
 * Inject a stylesheet that forces full-color print fidelity into an HTML
 * document string. `print-color-adjust: exact` keeps backgrounds, gradients,
 * and shadows so the PDF matches the on-screen preview instead of printing
 * washed-out. Injected just before `</head>` (or prepended when no head).
 */
function injectPrintFidelity(html: string): string {
  const style = `<style id="ax-print-fidelity">
  html, *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
  @page { margin: 12mm; }
</style>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${style}</head>`);
  }
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/(<body[^>]*>)/i, `$1${style}`);
  }
  return style + html;
}

/** Export an artifact in the chosen format. */
export function exportArtifact(
  filename: string,
  content: string,
  language: string,
  format: ExportFormat,
): void {
  const kind = previewKind(filename, language);
  const base = filename.split('/').pop() ?? filename;
  const stem = base.replace(/\.[^.]+$/, '');

  switch (format) {
    case 'original':
      downloadText(base, content, mimeFor(base));
      return;
    case 'text':
      downloadText(`${stem}.txt`, content, 'text/plain');
      return;
    case 'html':
      downloadText(`${stem}.html`, toHtmlDocument(filename, content, kind), 'text/html');
      return;
    case 'pdf':
      exportPdf(filename, content, kind);
      return;
  }
}

/** Best-effort MIME for a filename (download helper). */
function mimeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    html: 'text/html',
    htm: 'text/html',
    md: 'text/markdown',
    svg: 'image/svg+xml',
    json: 'application/json',
    csv: 'text/csv',
    xml: 'application/xml',
  };
  return map[ext] ?? 'text/plain';
}
