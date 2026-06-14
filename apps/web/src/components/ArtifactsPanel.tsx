'use client';

/**
 * The artifacts side panel — a Claude-style viewer for multi-file responses.
 *
 * For each generated file the panel offers:
 *   - a **live Preview** (HTML/SVG rendered in a sandboxed iframe, Markdown
 *     rendered, code shown formatted) alongside a raw **Code** view;
 *   - a **format-aware download** — the user picks the output format (Original,
 *     HTML, PDF via print, or Text) rather than only the raw file;
 *   - **Download all** as a `.zip`.
 *
 * It slides in from the right and can be closed to return to the full-width
 * conversation.
 */

import { useMemo, useState } from 'react';

import type { Artifact } from '@/lib/artifacts';
import { downloadZip } from '@/lib/zip';
import {
  exportArtifact,
  formatLabel,
  formatsFor,
  previewKind,
  toHtmlDocument,
  type ExportFormat,
} from '@/lib/export';

/** Props for the artifacts panel. */
interface ArtifactsPanelProps {
  /** The files to display. */
  artifacts: Artifact[];
  /** Close handler (hides the panel). */
  onClose: () => void;
}

/** Render the multi-file artifacts viewer. */
export function ArtifactsPanel({ artifacts, onClose }: ArtifactsPanelProps) {
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const [format, setFormat] = useState<ExportFormat>('original');

  const current = artifacts[active] ?? artifacts[0];
  const kind = useMemo(
    () => (current ? previewKind(current.filename, current.language) : 'code'),
    [current],
  );
  const formats = useMemo(() => formatsFor(kind), [kind]);
  const canPreview = kind === 'html' || kind === 'markdown' || kind === 'svg';

  if (current === undefined) return null;

  // The HTML used to render a live preview inside a sandboxed iframe.
  const previewDoc =
    canPreview ? toHtmlDocument(current.filename, current.content, kind) : '';

  // Keep the chosen format valid for the current file.
  const effectiveFormat = formats.includes(format) ? format : formats[0]!;

  return (
    <aside className="ax__artifacts" aria-label="Generated files">
      <header className="ax__artifacts-head">
        <div className="ax__artifacts-title">
          <span className="ax__artifacts-icon" aria-hidden="true">🗂</span>
          <span>{artifacts.length} file{artifacts.length === 1 ? '' : 's'}</span>
        </div>
        <div className="ax__artifacts-head-actions">
          <button
            type="button"
            className="ax__code-btn"
            onClick={() =>
              downloadZip(
                `auxify-files-${new Date().toISOString().slice(0, 10)}.zip`,
                artifacts.map((a) => ({ name: a.filename, content: a.content })),
              )
            }
            title="Download all files as a .zip"
          >
            ↓ All (.zip)
          </button>
          <button type="button" className="ax__iconbtn" aria-label="Close files panel" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>

      <div className="ax__artifacts-body">
        <nav className="ax__artifacts-list" aria-label="Files">
          {artifacts.map((a, i) => (
            <button
              key={a.filename}
              type="button"
              className={`ax__artifacts-file ${i === active ? 'ax__artifacts-file--on' : ''}`}
              onClick={() => {
                setActive(i);
                setTab('preview');
              }}
              title={a.filename}
            >
              <span className="ax__artifacts-file-name">{a.filename}</span>
              <span className="ax__artifacts-file-lang">{a.language}</span>
            </button>
          ))}
        </nav>

        <div className="ax__artifacts-view">
          <div className="ax__artifacts-view-head">
            <div className="ax__artifacts-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'preview'}
                className={`ax__artifacts-tab ${tab === 'preview' ? 'ax__artifacts-tab--on' : ''}`}
                onClick={() => setTab('preview')}
                disabled={!canPreview}
                title={canPreview ? 'Live preview' : 'No preview for this file type'}
              >
                Preview
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'code'}
                className={`ax__artifacts-tab ${tab === 'code' ? 'ax__artifacts-tab--on' : ''}`}
                onClick={() => setTab('code')}
              >
                Code
              </button>
            </div>

            <div className="ax__artifacts-export">
              <select
                className="ax__artifacts-format"
                value={effectiveFormat}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
                aria-label="Download format"
              >
                {formats.map((f) => (
                  <option key={f} value={f}>
                    {formatLabel(f)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ax__code-btn"
                onClick={() =>
                  exportArtifact(current.filename, current.content, current.language, effectiveFormat)
                }
                title="Download in the selected format"
              >
                ↓ Download
              </button>
            </div>
          </div>

          {tab === 'preview' && canPreview ? (
            <iframe
              className="ax__artifacts-preview"
              title={`Preview of ${current.filename}`}
              sandbox="allow-same-origin"
              srcDoc={previewDoc}
            />
          ) : (
            <pre className="ax__artifacts-pre">
              <code>{current.content}</code>
            </pre>
          )}
        </div>
      </div>
    </aside>
  );
}
