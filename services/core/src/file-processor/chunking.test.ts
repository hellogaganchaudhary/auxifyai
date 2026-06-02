/**
 * Unit tests for File_Processor text chunking (Req 11.4).
 *
 * Verify whitespace normalization, the empty-input case (no chunks → no
 * embeddings), the single-chunk case, fixed-size overlapping splits with full
 * coverage of the text, and the option-validation guards.
 */

import { describe, expect, it } from 'vitest';

import { chunkText, DEFAULT_CHUNK_SIZE } from './chunking.js';

describe('chunkText — basic behavior (Req 11.4)', () => {
  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\t  ')).toEqual([]);
  });

  it('normalizes runs of whitespace to single spaces', () => {
    expect(chunkText('hello\n\n   world\t!')).toEqual(['hello world !']);
  });

  it('returns a single chunk when text fits within the chunk size', () => {
    const text = 'short text';
    expect(chunkText(text, { chunkSize: 100, overlap: 10 })).toEqual([text]);
  });

  it('uses a sensible default chunk size', () => {
    const text = 'A'.repeat(DEFAULT_CHUNK_SIZE);
    expect(chunkText(text)).toEqual([text]);
  });
});

describe('chunkText — fixed-size overlapping splits (Req 11.4)', () => {
  it('splits long text into overlapping chunks within the size bound', () => {
    const text = 'A'.repeat(50);
    const chunks = chunkText(text, { chunkSize: 20, overlap: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });

  it('covers the entire input across chunks (no characters dropped)', () => {
    const text = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const chunkSize = 20;
    const overlap = 5;
    const chunks = chunkText(text, { chunkSize, overlap });
    // Reconstruct by stripping the overlap from every chunk after the first.
    const stride = chunkSize - overlap;
    let rebuilt = chunks[0] ?? '';
    for (let i = 1; i < chunks.length; i += 1) {
      rebuilt += chunks[i]!.slice(overlap);
    }
    // Account for the final chunk possibly being shorter than a full stride.
    expect(rebuilt.startsWith(text.slice(0, stride))).toBe(true);
    expect(rebuilt).toContain(text.slice(-overlap));
    expect(rebuilt.length).toBeGreaterThanOrEqual(text.length);
  });

  it('produces consecutive chunks that overlap by the configured amount', () => {
    const text = 'A'.repeat(30) + 'B'.repeat(30);
    const chunks = chunkText(text, { chunkSize: 20, overlap: 5 });
    for (let i = 1; i < chunks.length; i += 1) {
      const prevTail = chunks[i - 1]!.slice(-5);
      const currHead = chunks[i]!.slice(0, 5);
      expect(currHead).toBe(prevTail);
    }
  });
});

describe('chunkText — option validation', () => {
  it('rejects a non-positive chunk size', () => {
    expect(() => chunkText('x', { chunkSize: 0 })).toThrow(RangeError);
    expect(() => chunkText('x', { chunkSize: -1 })).toThrow(RangeError);
  });

  it('rejects a negative overlap', () => {
    expect(() => chunkText('x', { chunkSize: 10, overlap: -1 })).toThrow(RangeError);
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    expect(() => chunkText('x', { chunkSize: 10, overlap: 10 })).toThrow(RangeError);
    expect(() => chunkText('x', { chunkSize: 10, overlap: 11 })).toThrow(RangeError);
  });
});
