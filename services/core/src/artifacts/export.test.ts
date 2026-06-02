/**
 * Unit tests for artifact export serialization (Req 12.5).
 *
 * Exporting an artifact produces a downloadable file plus a copy-to-clipboard
 * string. These pin the type → extension / content-type mapping for every
 * supported artifact type and confirm the file body and clipboard string are
 * the artifact content verbatim.
 */

import { describe, expect, it } from 'vitest';

import { contentTypeFor, exportArtifact, extensionFor } from './export.js';
import { ARTIFACT_TYPES, type ArtifactType } from './types.js';
import { makeArtifact } from './fakes.js';

describe('contentTypeFor / extensionFor', () => {
  it.each<[ArtifactType, string, string]>([
    ['code', 'text/plain', 'txt'],
    ['markdown', 'text/markdown', 'md'],
    ['mermaid', 'text/vnd.mermaid', 'mmd'],
    ['react', 'text/jsx', 'jsx'],
    ['svg', 'image/svg+xml', 'svg'],
    ['csv', 'text/csv', 'csv'],
    ['html', 'text/html', 'html'],
  ])('maps %s to %s / .%s', (type, contentType, extension) => {
    expect(contentTypeFor(type)).toBe(contentType);
    expect(extensionFor(type)).toBe(extension);
  });

  it('defines a mapping for every supported artifact type', () => {
    for (const type of ARTIFACT_TYPES) {
      expect(contentTypeFor(type)).toBeTruthy();
      expect(extensionFor(type)).toBeTruthy();
    }
  });
});

describe('exportArtifact', () => {
  it('produces a UTF-8 download ref and a verbatim clipboard string', () => {
    const artifact = makeArtifact({ id: 'art-42', type: 'markdown', content: '# Hello\nworld' });
    const result = exportArtifact(artifact);

    expect(result.file).toEqual({
      filename: 'artifact-art-42.md',
      contentType: 'text/markdown',
      content: '# Hello\nworld',
      encoding: 'utf-8',
    });
    expect(result.clipboard).toBe('# Hello\nworld');
  });

  it('names the file with the artifact id and type extension', () => {
    const artifact = makeArtifact({ id: 'abc', type: 'csv', content: 'a,b\n1,2' });
    expect(exportArtifact(artifact).file.filename).toBe('artifact-abc.csv');
  });

  it('the clipboard string equals the file body for every type', () => {
    for (const type of ARTIFACT_TYPES) {
      const artifact = makeArtifact({ id: `id-${type}`, type, content: `payload ${type}` });
      const result = exportArtifact(artifact);
      expect(result.clipboard).toBe(result.file.content);
      expect(result.clipboard).toBe(`payload ${type}`);
    }
  });
});
