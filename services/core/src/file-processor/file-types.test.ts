/**
 * Unit tests for File_Processor type detection (Req 11.1, 11.6).
 *
 * Verify the supported-format catalog maps MIME types and extensions onto the
 * right category/format, that aliases (`jpeg`, `yml`) resolve, that MIME wins
 * over extension, and that unsupported formats return `null` so the processor
 * can skip or reject them.
 */

import { describe, expect, it } from 'vitest';

import { detectFileType, isArchiveType, isImageType } from './file-types.js';
import type { RawFile } from './types.js';

function file(fileName: string, contentType?: string): RawFile {
  return {
    fileName,
    sizeBytes: 1,
    bytes: new Uint8Array([0]),
    ...(contentType !== undefined ? { contentType } : {}),
  };
}

describe('detectFileType — MIME detection (Req 11.6)', () => {
  it('detects by authoritative MIME type', () => {
    const type = detectFileType(file('whatever.bin', 'application/pdf'));
    expect(type).not.toBeNull();
    expect(type!.category).toBe('document');
    expect(type!.format).toBe('pdf');
    expect(type!.mime).toBe('application/pdf');
  });

  it('prefers MIME over a conflicting extension', () => {
    // .txt extension but image/png MIME → image wins.
    const type = detectFileType(file('image.txt', 'image/png'));
    expect(type!.category).toBe('image');
    expect(type!.format).toBe('png');
  });
});

describe('detectFileType — extension fallback (Req 11.6)', () => {
  it('falls back to extension for generic MIME types', () => {
    const type = detectFileType(file('data.yaml', 'application/octet-stream'));
    expect(type!.category).toBe('data');
    expect(type!.format).toBe('yaml');
  });

  it('resolves extension aliases (jpeg → jpg, yml → yaml)', () => {
    expect(detectFileType(file('a.jpeg'))!.format).toBe('jpg');
    expect(detectFileType(file('a.yml'))!.format).toBe('yaml');
  });

  it('detects with no MIME type at all', () => {
    expect(detectFileType(file('a.zip'))!.category).toBe('archive');
    expect(detectFileType(file('song.mp3'))!.category).toBe('audio');
  });
});

describe('detectFileType — unsupported formats', () => {
  it('returns null for an unsupported extension and MIME', () => {
    expect(detectFileType(file('a.exe', 'application/x-msdownload'))).toBeNull();
    expect(detectFileType(file('noextension'))).toBeNull();
    expect(detectFileType(file('a.'))).toBeNull();
  });
});

describe('isImageType / isArchiveType', () => {
  it('classifies the OCR and expansion routes', () => {
    expect(isImageType(detectFileType(file('a.png'))!)).toBe(true);
    expect(isImageType(detectFileType(file('a.pdf'))!)).toBe(false);
    expect(isArchiveType(detectFileType(file('a.zip'))!)).toBe(true);
    expect(isArchiveType(detectFileType(file('a.csv'))!)).toBe(false);
  });
});
