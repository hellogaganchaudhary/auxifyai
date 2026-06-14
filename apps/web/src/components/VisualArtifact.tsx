'use client';

/**
 * Inline rendering of model-authored visual markup.
 *
 * Text-only models can't emit a raster image, but they can emit vector markup —
 * an `<svg>` document or a small self-contained HTML/CSS scene. Rather than
 * dumping that markup as a code block the user has to copy out and open
 * elsewhere, this component renders it as an actual picture right in the chat:
 *
 *   - SVG  → drawn via an `<img>` whose `src` is a sandboxed `image/svg+xml`
 *            data URL (an image element cannot execute embedded script).
 *   - HTML → rendered in a sandboxed `<iframe>` (no `allow-scripts`, so the
 *            scene paints but cannot run code in the app's origin).
 *
 * The markup is sanitized first (`<script>`, inline `on*=` handlers, and
 * `javascript:` URLs are stripped) as defense-in-depth. A footer lets the user
 * flip to the raw source or download the markup as a file.
 */

import { useMemo, useState } from 'react';

/** The visual markup languages this component can render. */
export type VisualKind = 'svg' | 'html';

/**
 * Strip the obviously-dangerous bits from model-authored markup before render:
 * `<script>` elements, inline `on*=` event handlers, and `javascript:` URLs.
 * This mirrors the server-side `sanitizeMarkup` and is defense-in-depth on top
 * of the sandboxed `<img>`/`<iframe>` render targets.
 */
export function sanitizeMarkup(markup: string): string {
  return markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/((?:href|src|xlink:href)\s*=\s*)(['"]?)\s*javascript:[^'">\s]*/gi, '$1$2#')
    .trim();
}

/** Whether a fence language + body should be rendered as a visual artifact. */
export function isVisualArtifact(language: string, code: string): VisualKind | null {
  const lang = (language || '').toLowerCase();
  if (lang === 'svg') return 'svg';
  if (lang === 'html' || lang === 'htm') return 'html';
  if ((lang === 'xml' || lang === '') && /<svg[\s>]/i.test(code)) return 'svg';
  return null;
}

/** Trigger a browser download of `text` as a file. */
function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Render model-authored SVG/HTML markup as a visible image with source/download. */
export function VisualArtifact({ kind, code }: { kind: VisualKind; code: string }) {
  const [showSource, setShowSource] = useState(false);
  const safe = useMemo(() => sanitizeMarkup(code), [code]);
  const ext = kind === 'svg' ? 'svg' : 'html';
  const mime = kind === 'svg' ? 'image/svg+xml' : 'text/html';

  // SVG renders as a sandboxed image; an <img> can never execute script.
  const svgSrc = useMemo(
    () =>
      kind === 'svg'
        ? `data:image/svg+xml;base64,${typeof window === 'undefined' ? '' : window.btoa(unescape(encodeURIComponent(safe)))}`
        : '',
    [kind, safe],
  );

  function copy(): void {
    void navigator.clipboard?.writeText(code).catch(() => {
      /* clipboard unavailable */
    });
  }

  function save(): void {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download(`auxify-${stamp}.${ext}`, safe, mime);
  }

  return (
    <div className="ax__artifact">
      <div className="ax__artifact-stage">
        {showSource ? (
          <pre className="ax__artifact-source">
            <code>{code}</code>
          </pre>
        ) : kind === 'svg' ? (
          <img className="ax__artifact-img" src={svgSrc} alt={'Rendered illustration'} />
        ) : (
          <iframe
            className="ax__artifact-frame"
            title="Rendered scene"
            sandbox=""
            srcDoc={safe}
          />
        )}
      </div>
      <div className="ax__artifact-bar">
        <span className="ax__artifact-tag">{kind.toUpperCase()}</span>
        <span className="ax__artifact-actions">
          <button type="button" className="ax__code-btn" onClick={() => setShowSource((s) => !s)}>
            {showSource ? 'View image' : 'View source'}
          </button>
          <button type="button" className="ax__code-btn" onClick={copy}>
            Copy
          </button>
          <button type="button" className="ax__code-btn" onClick={save}>
            ↓ .{ext}
          </button>
        </span>
      </div>
    </div>
  );
}
