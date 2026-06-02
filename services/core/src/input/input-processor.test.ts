/**
 * Unit tests for the Input_Processor (Req 7.1-7.8).
 *
 * These exercise the full surface against the in-memory fakes for every port:
 * file-type acceptance and classification (Req 7.1), voice transcription
 * (Req 7.2), pasted-image (Req 7.3) and dropped file/URL (Req 7.4) attachment,
 * URL preview + offered summary (Req 7.5), `@`-mention resolution (Req 7.6),
 * and the 100 MB (Req 7.7) and 10-attachment (Req 7.8) limit rejections with
 * their dedicated typed errors. They use only fakes — no real audio, network,
 * model, or database.
 */

import { describe, expect, it } from 'vitest';

import type { ResourceRef } from '@auxify/types';

import {
  AttachmentCountError,
  FileSizeLimitError,
  MentionNotFoundError,
  UnsupportedFileTypeError,
} from './errors.js';
import {
  FakeMentionResolver,
  FakeSpeechToText,
  FakeSummarizer,
  FakeUrlFetcher,
  InMemoryAttachmentStore,
} from './fakes.js';
import { InputProcessor, type InputProcessorOptions } from './input-processor.js';
import { MAX_ATTACHMENTS, MAX_FILE_BYTES } from './limits.js';
import type { MentionTarget, UploadedFile } from './types.js';

interface Harness {
  processor: InputProcessor;
  store: InMemoryAttachmentStore;
  stt: FakeSpeechToText;
  fetcher: FakeUrlFetcher;
  summarizer: FakeSummarizer;
  mentions: FakeMentionResolver;
}

/** Build a processor wired to fresh fakes, with a deterministic id sequence. */
function makeProcessor(overrides: Partial<InputProcessorOptions> = {}): Harness {
  const store = new InMemoryAttachmentStore();
  const stt = new FakeSpeechToText('hello world');
  const fetcher = new FakeUrlFetcher({ title: 'Example', siteName: 'example.com' });
  const summarizer = new FakeSummarizer();
  const mentions = new FakeMentionResolver();
  let n = 0;
  const processor = new InputProcessor({
    attachmentStore: store,
    speechToText: stt,
    urlFetcher: fetcher,
    summarizer,
    mentionResolver: mentions,
    idGenerator: () => {
      n += 1;
      return `att-${n}`;
    },
    ...overrides,
  });
  return { processor, store, stt, fetcher, summarizer, mentions };
}

function file(partial: Partial<UploadedFile> & { fileName: string }): UploadedFile {
  return { sizeBytes: 1024, ...partial };
}

describe('InputProcessor.attachFile — accepted file types (Req 7.1)', () => {
  const cases: Array<{ name: string; file: UploadedFile; kind: string }> = [
    {
      name: 'image (png)',
      file: file({ fileName: 'a.png', contentType: 'image/png' }),
      kind: 'image',
    },
    { name: 'image (by ext)', file: file({ fileName: 'a.jpeg' }), kind: 'image' },
    { name: 'pdf', file: file({ fileName: 'a.pdf', contentType: 'application/pdf' }), kind: 'pdf' },
    { name: 'csv', file: file({ fileName: 'a.csv', contentType: 'text/csv' }), kind: 'csv' },
    {
      name: 'spreadsheet (xlsx)',
      file: file({
        fileName: 'a.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      kind: 'spreadsheet',
    },
    {
      name: 'code (ts)',
      file: file({ fileName: 'a.ts', contentType: 'text/plain' }),
      kind: 'code',
    },
    { name: 'code (py by ext)', file: file({ fileName: 'main.py' }), kind: 'code' },
  ];

  for (const c of cases) {
    it(`accepts and classifies ${c.name}`, async () => {
      const h = makeProcessor();
      const attachment = await h.processor.attachFile('msg-1', c.file);
      expect(attachment.kind).toBe(c.kind);
      expect(attachment.messageId).toBe('msg-1');
      expect(attachment.name).toBe(c.file.fileName);
      expect(attachment.sizeBytes).toBe(c.file.sizeBytes);
      // The attachment was associated with the message via the store.
      expect(h.store.saved).toHaveLength(1);
      expect(await h.store.countForMessage('msg-1')).toBe(1);
    });
  }

  it('persists bytes and records a storage key when present', async () => {
    const h = makeProcessor();
    const attachment = await h.processor.attachFile(
      'msg-1',
      file({ fileName: 'a.png', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }),
    );
    expect(attachment.storageKey).toBe('attachments/msg-1/1');
  });

  it('rejects an unsupported file type (Req 7.1)', async () => {
    const h = makeProcessor();
    await expect(
      h.processor.attachFile(
        'msg-1',
        file({ fileName: 'a.exe', contentType: 'application/x-msdownload' }),
      ),
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    expect(h.store.saved).toHaveLength(0);
  });
});

describe('InputProcessor.attachFile — size limit (Req 7.7)', () => {
  it('accepts a file exactly at the 100 MB boundary', async () => {
    const h = makeProcessor();
    const attachment = await h.processor.attachFile(
      'msg-1',
      file({ fileName: 'big.pdf', contentType: 'application/pdf', sizeBytes: MAX_FILE_BYTES }),
    );
    expect(attachment.sizeBytes).toBe(MAX_FILE_BYTES);
  });

  it('rejects a file over 100 MB with a FileSizeLimitError carrying the size', async () => {
    const h = makeProcessor();
    const oversize = MAX_FILE_BYTES + 1;
    const promise = h.processor.attachFile(
      'msg-1',
      file({ fileName: 'huge.pdf', contentType: 'application/pdf', sizeBytes: oversize }),
    );
    await expect(promise).rejects.toBeInstanceOf(FileSizeLimitError);
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(FileSizeLimitError);
      const sizeError = error as FileSizeLimitError;
      expect(sizeError.sizeBytes).toBe(oversize);
      expect(sizeError.limitBytes).toBe(MAX_FILE_BYTES);
      const platform = sizeError.toPlatformError('corr-1');
      expect(platform.category).toBe('validation');
      expect(platform.code).toBe('FILE_SIZE_LIMIT_EXCEEDED');
    });
    // The oversized file is never persisted.
    expect(h.store.saved).toHaveLength(0);
  });
});

describe('InputProcessor.attachFile — attachment count limit (Req 7.8)', () => {
  it('accepts up to 10 attachments on a message', async () => {
    const h = makeProcessor();
    for (let i = 0; i < MAX_ATTACHMENTS; i += 1) {
      await h.processor.attachFile(
        'msg-1',
        file({ fileName: `f${i}.pdf`, contentType: 'application/pdf' }),
      );
    }
    expect(await h.store.countForMessage('msg-1')).toBe(MAX_ATTACHMENTS);
  });

  it('rejects the 11th attachment with an AttachmentCountError', async () => {
    const h = makeProcessor();
    h.store.seedCount('msg-1', MAX_ATTACHMENTS);
    const promise = h.processor.attachFile(
      'msg-1',
      file({ fileName: 'extra.pdf', contentType: 'application/pdf' }),
    );
    await expect(promise).rejects.toBeInstanceOf(AttachmentCountError);
    await promise.catch((error: unknown) => {
      const countError = error as AttachmentCountError;
      expect(countError.currentCount).toBe(MAX_ATTACHMENTS);
      expect(countError.limit).toBe(MAX_ATTACHMENTS);
      expect(countError.messageId).toBe('msg-1');
      const platform = countError.toPlatformError('corr-1');
      expect(platform.category).toBe('quota_exceeded');
      expect(platform.code).toBe('ATTACHMENT_COUNT_EXCEEDED');
    });
  });

  it('enforces the limit across paste and drop paths too', async () => {
    const h = makeProcessor();
    h.store.seedCount('msg-1', MAX_ATTACHMENTS);
    await expect(
      h.processor.attachPastedImage('msg-1', new Uint8Array([1])),
    ).rejects.toBeInstanceOf(AttachmentCountError);
    await expect(
      h.processor.attachDropped('msg-1', { url: 'https://example.com' }),
    ).rejects.toBeInstanceOf(AttachmentCountError);
  });
});

describe('InputProcessor.transcribeVoice (Req 7.2)', () => {
  it('delegates to the SpeechToText port and returns the transcript', async () => {
    const h = makeProcessor();
    const audio = { bytes: new Uint8Array([9, 9, 9]), contentType: 'audio/wav' };
    const text = await h.processor.transcribeVoice(audio);
    expect(text).toBe('hello world');
    expect(h.stt.calls).toHaveLength(1);
    expect(h.stt.calls[0]).toBe(audio);
  });
});

describe('InputProcessor.attachPastedImage (Req 7.3)', () => {
  it('attaches a pasted image as an image attachment', async () => {
    const h = makeProcessor();
    const attachment = await h.processor.attachPastedImage('msg-1', new Uint8Array([1, 2, 3, 4]));
    expect(attachment.kind).toBe('image');
    expect(attachment.name).toBe('pasted-image');
    expect(attachment.contentType).toBe('image/png');
    expect(attachment.sizeBytes).toBe(4);
    expect(attachment.storageKey).toBeDefined();
  });

  it('rejects a pasted image over the size limit', async () => {
    const h = makeProcessor();
    const big = { byteLength: MAX_FILE_BYTES + 1 } as unknown as Uint8Array;
    await expect(h.processor.attachPastedImage('msg-1', big)).rejects.toBeInstanceOf(
      FileSizeLimitError,
    );
  });
});

describe('InputProcessor.attachDropped (Req 7.4)', () => {
  it('attaches a dropped file like attachFile', async () => {
    const h = makeProcessor();
    const attachment = await h.processor.attachDropped('msg-1', {
      file: file({ fileName: 'a.csv', contentType: 'text/csv' }),
    });
    expect(attachment.kind).toBe('csv');
    expect(attachment.messageId).toBe('msg-1');
  });

  it('attaches a dropped URL as a url attachment', async () => {
    const h = makeProcessor();
    const attachment = await h.processor.attachDropped('msg-1', { url: 'https://example.com/doc' });
    expect(attachment.kind).toBe('url');
    expect(attachment.url).toBe('https://example.com/doc');
    expect(attachment.name).toBe('https://example.com/doc');
    // A URL attachment has no stored bytes / storage key.
    expect(attachment.storageKey).toBeUndefined();
  });

  it('rejects when neither file nor url is provided', async () => {
    const h = makeProcessor();
    await expect(h.processor.attachDropped('msg-1', {})).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects when both file and url are provided', async () => {
    const h = makeProcessor();
    await expect(
      h.processor.attachDropped('msg-1', {
        file: file({ fileName: 'a.csv', contentType: 'text/csv' }),
        url: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('InputProcessor.previewUrl (Req 7.5)', () => {
  it('fetches a preview and offers a summary of the linked page', async () => {
    const h = makeProcessor();
    const preview = await h.processor.previewUrl('https://example.com/article');
    expect(h.fetcher.calls).toEqual(['https://example.com/article']);
    expect(h.summarizer.calls).toHaveLength(1);
    expect(preview.title).toBe('Example');
    expect(preview.siteName).toBe('example.com');
    expect(preview.summary).toBe('Summary: Example');
  });

  it('derives the site name from the host when the page omits it', async () => {
    const h = makeProcessor({ urlFetcher: new FakeUrlFetcher({ content: 'body' }) });
    const preview = await h.processor.previewUrl('https://docs.example.org/page');
    expect(preview.siteName).toBe('docs.example.org');
  });

  it('rejects a non-http(s) URL', async () => {
    const h = makeProcessor();
    await expect(h.processor.previewUrl('ftp://example.com')).rejects.toBeInstanceOf(TypeError);
    await expect(h.processor.previewUrl('not a url')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('InputProcessor.resolveMention (Req 7.6)', () => {
  const ref = (type: ResourceRef['type'], id: string): ResourceRef => ({
    type,
    id,
    organizationId: 'org-1',
  });

  const targets: Record<string, MentionTarget> = {
    alice: { type: 'user', label: 'Alice', ref: ref('user', 'user-1') },
    spec: { type: 'document', label: 'Spec', ref: ref('document', 'doc-1') },
    runbook: { type: 'knowledge_page', label: 'Runbook', ref: ref('knowledge_page', 'page-1') },
    apollo: { type: 'project', label: 'Apollo', ref: ref('project', 'proj-1') },
  };

  for (const [token, target] of Object.entries(targets)) {
    it(`resolves an @${token} mention to a ${target.type}`, async () => {
      const h = makeProcessor({ mentionResolver: new FakeMentionResolver(targets) });
      const resolved = await h.processor.resolveMention(`@${token}`);
      expect(resolved).toEqual(target);
    });
  }

  it('resolves a token without the leading @', async () => {
    const h = makeProcessor({ mentionResolver: new FakeMentionResolver(targets) });
    const resolved = await h.processor.resolveMention('alice');
    expect(resolved.type).toBe('user');
  });

  it('fails closed with MentionNotFoundError for an unknown token', async () => {
    const h = makeProcessor({ mentionResolver: new FakeMentionResolver(targets) });
    await expect(h.processor.resolveMention('@nobody')).rejects.toBeInstanceOf(
      MentionNotFoundError,
    );
  });

  it('rejects an empty mention token', async () => {
    const h = makeProcessor();
    await expect(h.processor.resolveMention('@')).rejects.toBeInstanceOf(MentionNotFoundError);
  });
});
