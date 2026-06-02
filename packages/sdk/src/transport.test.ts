/**
 * Unit tests for the SDK's pure server-sent-events line parser (Req 45.6).
 *
 * These exercise {@link parseSseChunk} in isolation — no transport, no network —
 * asserting it decodes complete `event:`/`data:`/`id:` frames, joins multiple
 * `data:` lines, ignores comments, and carries an unterminated tail forward as a
 * remainder so an event split across network chunks reassembles correctly.
 */

import { describe, expect, it } from 'vitest';

import { parseSseChunk } from './transport';

describe('parseSseChunk — SSE line parser (Req 45.6)', () => {
  it('decodes a single complete event with an event name and data', () => {
    const { frames, remainder } = parseSseChunk('event: token\ndata: {"delta":"hi"}\n\n');
    expect(frames).toEqual([{ event: 'token', data: '{"delta":"hi"}' }]);
    expect(remainder).toBe('');
  });

  it('decodes multiple events in one chunk', () => {
    const chunk = 'event: token\ndata: a\n\nevent: token\ndata: b\n\n';
    const { frames } = parseSseChunk(chunk);
    expect(frames).toEqual([
      { event: 'token', data: 'a' },
      { event: 'token', data: 'b' },
    ]);
  });

  it('joins multiple data lines with a newline', () => {
    const { frames } = parseSseChunk('data: line1\ndata: line2\n\n');
    expect(frames).toEqual([{ data: 'line1\nline2' }]);
  });

  it('ignores comment lines beginning with a colon', () => {
    const { frames } = parseSseChunk(':keep-alive\nevent: completion\ndata: {}\n\n');
    expect(frames).toEqual([{ event: 'completion', data: '{}' }]);
  });

  it('carries an unterminated trailing event forward as the remainder', () => {
    const first = parseSseChunk('event: token\ndata: {"delta":"par');
    expect(first.frames).toEqual([]);
    expect(first.remainder).toBe('event: token\ndata: {"delta":"par');

    const second = parseSseChunk(`${first.remainder}tial"}\n\n`);
    expect(second.frames).toEqual([{ event: 'token', data: '{"delta":"partial"}' }]);
    expect(second.remainder).toBe('');
  });

  it('captures the id field and normalizes CRLF newlines', () => {
    const { frames } = parseSseChunk('id: 7\r\nevent: token\r\ndata: x\r\n\r\n');
    expect(frames).toEqual([{ id: '7', event: 'token', data: 'x' }]);
  });
});
