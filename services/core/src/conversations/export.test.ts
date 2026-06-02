/**
 * Unit tests for the pure conversation export serializers (Req 5.7).
 *
 * These verify the format selection (content type + filename extension) and the
 * per-format rendering: JSON round-trips, Markdown/HTML carry the title and
 * message content, HTML escapes content, and the PDF placeholder is labelled
 * and embeds the body.
 */

import { describe, expect, it } from 'vitest';

import { exportConversation } from './export.js';
import { makeConversationRecord, makeMessageRecord } from './fakes.js';
import { EXPORT_FORMATS, toConversation, type ExportFormat } from './types.js';

const conversation = toConversation(
  makeConversationRecord({ id: 'c1', title: 'My <conv> & "title"' }),
);
const messages = [
  makeMessageRecord({
    id: 'm1',
    role: 'user',
    content: [{ type: 'markdown', data: { text: 'a <script>alert(1)</script> b' } }],
  }),
  makeMessageRecord({
    id: 'm2',
    role: 'assistant',
    content: [{ type: 'code', data: { code: 'print("hi")' } }],
  }),
];

describe('exportConversation format selection', () => {
  const expected: Record<ExportFormat, { contentType: string; ext: string }> = {
    md: { contentType: 'text/markdown', ext: 'md' },
    pdf: { contentType: 'application/pdf', ext: 'pdf' },
    json: { contentType: 'application/json', ext: 'json' },
    html: { contentType: 'text/html', ext: 'html' },
  };

  it.each(EXPORT_FORMATS)('selects the right content type and filename for %s', (fmt) => {
    const artifact = exportConversation(conversation, messages, fmt);
    expect(artifact.format).toBe(fmt);
    expect(artifact.contentType).toBe(expected[fmt].contentType);
    expect(artifact.filename).toBe(`conversation-c1.${expected[fmt].ext}`);
    expect(artifact.content.length).toBeGreaterThan(0);
  });
});

describe('exportConversation rendering', () => {
  it('renders Markdown with the title and message bodies', () => {
    const md = exportConversation(conversation, messages, 'md').content;
    expect(md).toContain('# My <conv> & "title"');
    expect(md).toContain('## user');
    expect(md).toContain('## assistant');
    expect(md).toContain('print("hi")');
  });

  it('round-trips JSON faithfully', () => {
    const json = exportConversation(conversation, messages, 'json').content;
    const parsed = JSON.parse(json) as { conversation: { title: string }; messages: unknown[] };
    expect(parsed.conversation.title).toBe('My <conv> & "title"');
    expect(parsed.messages).toHaveLength(2);
  });

  it('escapes HTML so message/title markup cannot inject', () => {
    const html = exportConversation(conversation, messages, 'html').content;
    expect(html).toContain('My &lt;conv&gt; &amp; &quot;title&quot;');
    expect(html).toContain('a &lt;script&gt;alert(1)&lt;/script&gt; b');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('embeds the Markdown body in the labelled PDF placeholder', () => {
    const pdf = exportConversation(conversation, messages, 'pdf').content;
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('textual placeholder representation');
    expect(pdf).toContain('print("hi")');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('handles a conversation with no messages', () => {
    const md = exportConversation(conversation, [], 'md').content;
    expect(md).toContain('# My <conv> & "title"');
  });
});
