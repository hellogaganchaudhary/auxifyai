/**
 * Artifact export serialization (Req 12.5).
 *
 * Exporting an artifact produces two things: a downloadable file
 * ({@link DownloadRef}) and a copy-to-clipboard string. This module holds the
 * pure serializer so the mapping from artifact type → filename extension and
 * MIME content type is correct, deterministic, and testable without a database
 * or a transport layer.
 *
 * Every supported artifact type is UTF-8 text (code, Markdown, Mermaid, a React
 * component source, an SVG document, a CSV table, an HTML page), so the file
 * body is the artifact content verbatim and the clipboard string is that same
 * content — a copy-to-clipboard control places exactly what is exported.
 */

import type { Artifact, ArtifactExport, ArtifactType, DownloadRef } from './types.js';

/** The MIME content type for each artifact type. */
const CONTENT_TYPES: Readonly<Record<ArtifactType, string>> = {
  code: 'text/plain',
  markdown: 'text/markdown',
  mermaid: 'text/vnd.mermaid',
  react: 'text/jsx',
  svg: 'image/svg+xml',
  csv: 'text/csv',
  html: 'text/html',
};

/** The filename extension for each artifact type. */
const EXTENSIONS: Readonly<Record<ArtifactType, string>> = {
  code: 'txt',
  markdown: 'md',
  mermaid: 'mmd',
  react: 'jsx',
  svg: 'svg',
  csv: 'csv',
  html: 'html',
};

/** The MIME content type an artifact of `type` exports as (Req 12.5). */
export function contentTypeFor(type: ArtifactType): string {
  return CONTENT_TYPES[type];
}

/** The filename extension an artifact of `type` exports as (Req 12.5). */
export function extensionFor(type: ArtifactType): string {
  return EXTENSIONS[type];
}

/**
 * Serialize an artifact into a downloadable file plus a copy-to-clipboard
 * string (Req 12.5).
 *
 * @param artifact The artifact to export.
 * @returns The {@link ArtifactExport}: a {@link DownloadRef} with the correct
 *   filename/content-type and the clipboard string (the artifact content).
 */
export function exportArtifact(artifact: Artifact): ArtifactExport {
  const file: DownloadRef = {
    filename: `artifact-${artifact.id}.${extensionFor(artifact.type)}`,
    contentType: contentTypeFor(artifact.type),
    content: artifact.content,
    encoding: 'utf-8',
  };
  return { file, clipboard: artifact.content };
}
