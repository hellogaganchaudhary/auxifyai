/**
 * Conversation export serialization (Req 5.7).
 *
 * The Conversation_Manager produces a conversation in one of four formats —
 * Markdown, PDF, JSON, or HTML. This module holds the pure serializers so the
 * format selection is correct, deterministic, and testable without a database
 * or a binary PDF renderer:
 *
 *   - {@link exportConversation} dispatches on the requested {@link ExportFormat}
 *     and returns an {@link ExportArtifact} with the correct MIME type and
 *     filename extension.
 *   - JSON is a faithful structural dump (round-trippable).
 *   - Markdown and HTML render the title, metadata, and each message's role and
 *     textual content; HTML is escaped so message content can never inject
 *     markup (Req 34.5 defense-in-depth).
 *   - PDF, in this codebase, has no binary renderer dependency available, so a
 *     well-structured, deterministic textual PDF *representation* is produced
 *     (a documented placeholder). The selection is still correct and testable,
 *     and a real renderer can replace {@link renderPdf} at this one seam without
 *     touching the manager.
 */

import type { ContentBlock } from '@auxify/types';

import type { Conversation, ExportArtifact, ExportFormat, Message } from './types.js';

/** The MIME content type for each export format. */
const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  md: 'text/markdown',
  pdf: 'application/pdf',
  json: 'application/json',
  html: 'text/html',
};

/** The filename extension for each export format. */
const EXTENSIONS: Readonly<Record<ExportFormat, string>> = {
  md: 'md',
  pdf: 'pdf',
  json: 'json',
  html: 'html',
};

/** Escape the five XML/HTML metacharacters so content can never inject markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Extract a plain-text rendering of a content block for non-JSON exports.
 *
 * Blocks are heterogeneous (`data` is `unknown`); this pulls a readable string
 * for the common shapes (a `text`/`code` string field, or a bare string) and
 * falls back to a compact JSON encoding so no content is silently dropped.
 */
function blockToText(block: ContentBlock): string {
  const data = block.data;
  if (typeof data === 'string') return data;
  if (data !== null && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.code === 'string') return record.code;
  }
  return JSON.stringify(data);
}

/** Join a message's content blocks into a single plain-text string. */
function messageText(message: Message): string {
  return message.content.map(blockToText).join('\n');
}

/** Render the conversation as GitHub-Flavored Markdown. */
function renderMarkdown(conversation: Conversation, messages: Message[]): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.title || 'Untitled conversation'}`);
  lines.push('');
  lines.push(`- Conversation: ${conversation.id}`);
  lines.push(`- Project: ${conversation.projectId}`);
  lines.push(`- Owner: ${conversation.ownerId}`);
  lines.push(`- Created: ${conversation.createdAt}`);
  lines.push(`- Updated: ${conversation.updatedAt}`);
  lines.push('');
  for (const message of messages) {
    lines.push(`## ${message.role}`);
    lines.push('');
    lines.push(messageText(message));
    lines.push('');
  }
  return lines.join('\n');
}

/** Render the conversation as an escaped, self-contained HTML document. */
function renderHtml(conversation: Conversation, messages: Message[]): string {
  const title = escapeHtml(conversation.title || 'Untitled conversation');
  const body = messages
    .map(
      (message) =>
        `    <section class="message ${escapeHtml(message.role)}">\n` +
        `      <h2>${escapeHtml(message.role)}</h2>\n` +
        `      <pre>${escapeHtml(messageText(message))}</pre>\n` +
        `    </section>`,
    )
    .join('\n');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    `    <title>${title}</title>`,
    '  </head>',
    '  <body>',
    `    <h1>${title}</h1>`,
    '    <dl class="metadata">',
    `      <dt>Conversation</dt><dd>${escapeHtml(conversation.id)}</dd>`,
    `      <dt>Project</dt><dd>${escapeHtml(conversation.projectId)}</dd>`,
    `      <dt>Owner</dt><dd>${escapeHtml(conversation.ownerId)}</dd>`,
    `      <dt>Created</dt><dd>${escapeHtml(conversation.createdAt)}</dd>`,
    `      <dt>Updated</dt><dd>${escapeHtml(conversation.updatedAt)}</dd>`,
    '    </dl>',
    body,
    '  </body>',
    '</html>',
  ].join('\n');
}

/** Render the conversation as a faithful, round-trippable JSON document. */
function renderJson(conversation: Conversation, messages: Message[]): string {
  return JSON.stringify({ conversation, messages }, null, 2);
}

/**
 * Render a deterministic textual PDF *representation* (documented placeholder).
 *
 * No binary PDF renderer dependency is available in this package, so rather
 * than emit an invalid `.pdf`, this produces a minimal, well-structured,
 * single-page PDF-like text stream that is deterministic and inspectable. The
 * Markdown body is embedded verbatim, so the content is preserved and the
 * format selection (MIME `application/pdf`, `.pdf` extension) is correct. A
 * real renderer (e.g. a headless print pipeline) can replace this function at
 * this single seam without changing the Conversation_Manager.
 */
function renderPdf(conversation: Conversation, messages: Message[]): string {
  const markdown = renderMarkdown(conversation, messages);
  // A documented placeholder envelope around the Markdown body. This is NOT a
  // binary PDF; it is a deterministic textual representation labelled as such.
  return [
    '%PDF-1.4',
    '% Auxify conversation export (textual placeholder representation)',
    `% conversation: ${conversation.id}`,
    '% A binary PDF renderer is not bundled in @auxify/core; the Markdown body',
    '% below is embedded verbatim so content is preserved and the format',
    '% selection is correct. Replace renderPdf() to emit a real PDF.',
    '',
    markdown,
    '',
    '%%EOF',
  ].join('\n');
}

/**
 * Serialize a conversation and its messages in the requested format (Req 5.7).
 *
 * @param conversation The conversation to export.
 * @param messages The conversation's messages, in chronological order.
 * @param format One of `md`/`pdf`/`json`/`html`.
 * @returns The {@link ExportArtifact} with the correct content type and filename.
 */
export function exportConversation(
  conversation: Conversation,
  messages: Message[],
  format: ExportFormat,
): ExportArtifact {
  let content: string;
  switch (format) {
    case 'md':
      content = renderMarkdown(conversation, messages);
      break;
    case 'html':
      content = renderHtml(conversation, messages);
      break;
    case 'json':
      content = renderJson(conversation, messages);
      break;
    case 'pdf':
      content = renderPdf(conversation, messages);
      break;
  }
  return {
    conversationId: conversation.id,
    format,
    filename: `conversation-${conversation.id}.${EXTENSIONS[format]}`,
    contentType: CONTENT_TYPES[format],
    content,
  };
}
