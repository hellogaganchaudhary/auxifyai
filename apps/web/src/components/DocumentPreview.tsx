'use client';

/**
 * DocumentPreview — an in-browser, Gamma-style preview overlay for generated
 * documents.
 *
 * Every designed document ships with a PDF rendering (the file itself for
 * PDFs, a parallel PDF render for PPTX/DOCX). This overlay paints that PDF
 * page-by-page onto canvases with pdf.js — bundled in the app, fully
 * client-side, no external viewer services and no reliance on a native
 * browser PDF plugin — with a toolbar to download the original format and/or
 * the PDF.
 */

import { useEffect, useRef, useState } from 'react';

import { downloadGeneratedFile, type GeneratedFile } from '@/lib/chat-client';

/** What the preview overlay shows: the original file + a previewable PDF. */
export interface PreviewTarget {
  /** The primary generated file (what "Download" saves). */
  file: GeneratedFile;
  /** A PDF rendering for the inline preview (same as `file` when it is a PDF). */
  pdf: GeneratedFile;
}

/** Pick the PDF used for inline preview from a message file + optional preview. */
export function toPreviewTarget(file: GeneratedFile, preview?: GeneratedFile): PreviewTarget | null {
  if (file.mimeType === 'application/pdf') return { file, pdf: file };
  if (preview !== undefined && preview.mimeType === 'application/pdf') return { file, pdf: preview };
  return null;
}

/** Decode a base64 string into bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The full-screen document preview overlay. */
export function DocumentPreview({
  target,
  onClose,
}: {
  target: PreviewTarget;
  onClose: () => void;
}) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pageCount, setPageCount] = useState(0);

  // Render the PDF onto canvases with pdf.js (lazy-loaded chunk).
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setStatus('loading');
    setPageCount(0);

    void (async () => {
      try {
        // Legacy build: works on a wider browser range than the modern build
        // (which requires very recent JS engine features).
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        const task = pdfjs.getDocument({ data: base64ToBytes(target.pdf.base64) });
        cleanup = () => void task.destroy();
        const doc = await task.promise;
        if (cancelled) return;
        setPageCount(doc.numPages);

        const host = pagesRef.current;
        if (host === null) return;
        host.replaceChildren();

        // Crisp output: render at devicePixelRatio (capped) over CSS size.
        const ratio = Math.min(window.devicePixelRatio || 1, 2) * 1.4;
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: ratio });
          const canvas = document.createElement('canvas');
          canvas.className = 'ax__preview-page';
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
          host.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
        }
        if (!cancelled) setStatus('ready');
      } catch (error) {
        console.error('[DocumentPreview] render failed:', error);
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [target.pdf]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isPdfOriginal = target.file.mimeType === 'application/pdf';
  const originalExt = target.file.filename.split('.').pop()?.toUpperCase() ?? 'FILE';

  return (
    <div
      className="ax__preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${target.file.filename}`}
      onClick={onClose}
    >
      <div className="ax__preview-panel" onClick={(e) => e.stopPropagation()}>
        <div className="ax__preview-head">
          <span className="ax__preview-title" title={target.file.filename}>
            📄 {target.file.filename}
            {pageCount > 0 ? (
              <span className="ax__preview-count">
                {pageCount} page{pageCount === 1 ? '' : 's'}
              </span>
            ) : null}
          </span>
          <div className="ax__preview-actions">
            <button
              type="button"
              className="ax__msg-action ax__msg-action--primary"
              onClick={() => downloadGeneratedFile(target.file)}
              title={`Download ${target.file.filename}`}
            >
              ↓ Download {isPdfOriginal ? 'PDF' : originalExt}
            </button>
            {!isPdfOriginal ? (
              <button
                type="button"
                className="ax__msg-action"
                onClick={() => downloadGeneratedFile(target.pdf)}
                title="Download the PDF preview"
              >
                ↓ PDF
              </button>
            ) : null}
            <button type="button" className="ax__msg-action" onClick={onClose} aria-label="Close preview">
              ✕
            </button>
          </div>
        </div>
        <div className="ax__preview-body">
          {status === 'loading' ? <div className="ax__preview-status">Rendering preview…</div> : null}
          {status === 'error' ? (
            <div className="ax__preview-status">
              Preview unavailable — use the download button above.
            </div>
          ) : null}
          {/* pdf.js owns this node exclusively — React never renders into it. */}
          <div className="ax__preview-pages" ref={pagesRef} />
        </div>
      </div>
    </div>
  );
}
