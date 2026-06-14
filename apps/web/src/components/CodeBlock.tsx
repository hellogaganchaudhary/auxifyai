'use client';

/**
 * A code block with a premium header bar: language label, Copy, and Download.
 *
 * This powers the "responses as files" capability — any fenced code block the
 * assistant returns (a component, a script, a config, a CSV) can be downloaded
 * straight to disk with the correct file extension, or copied in one click.
 */

import { useState } from 'react';

import { VisualArtifact, isVisualArtifact } from './VisualArtifact';

/** Map a markdown code-fence language to a sensible file extension. */
const EXT_BY_LANG: Record<string, string> = {
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  python: 'py',
  py: 'py',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  json: 'json',
  yaml: 'yml',
  yml: 'yml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  markdown: 'md',
  md: 'md',
  java: 'java',
  go: 'go',
  rust: 'rs',
  rs: 'rs',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  cs: 'cs',
  ruby: 'rb',
  rb: 'rb',
  php: 'php',
  xml: 'xml',
  csv: 'csv',
  text: 'txt',
  txt: 'txt',
};

/** Trigger a browser download of `text` as a file with the given name. */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
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

/** A fenced code block with language label + copy/download actions. */
export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const lang = (language || 'text').toLowerCase();
  const ext = EXT_BY_LANG[lang] ?? 'txt';

  // SVG/HTML markup is rendered as a real picture instead of shown as code, so
  // a model that "can't generate images" can still draw via vector markup.
  const visualKind = isVisualArtifact(language, code);
  if (visualKind !== null) {
    return <VisualArtifact kind={visualKind} code={code} />;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  function download() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadText(`auxify-${stamp}.${ext}`, code, ext === 'csv' ? 'text/csv' : 'text/plain');
  }

  return (
    <div className="ax__code">
      <div className="ax__code-head">
        <span className="ax__code-lang">{language || 'text'}</span>
        <span className="ax__code-actions">
          <button type="button" className="ax__code-btn" onClick={() => void copy()}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
          <button type="button" className="ax__code-btn" onClick={download}>
            ↓ .{ext}
          </button>
        </span>
      </div>
      <pre className="ax__code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}
