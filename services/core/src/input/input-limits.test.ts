/**
 * Focused unit tests for the Input_Processor hard input limits (Req 7.7, 7.8).
 *
 * These complement the broad surface tests in `input-processor.test.ts` by
 * pinning down only the two numeric limits at their exact boundaries, across
 * every attach entry point:
 *
 *  - The 100 MB per-file size limit (Req 7.7) — a file at exactly {@link
 *    MAX_FILE_BYTES} is accepted, one byte over is rejected with a {@link
 *    FileSizeLimitError} that carries the attempted size and the enforced
 *    limit, projects to a `validation` / `FILE_SIZE_LIMIT_EXCEEDED` {@link
 *    PlatformError}, and is never persisted. Exercised through `attachFile`,
 *    `attachPastedImage`, and the dropped-file path.
 *  - The 10-attachment per-message limit (Req 7.8) — the 1st…10th attachments
 *    are accepted and the 11th is rejected with an {@link AttachmentCountError}
 *    carrying the current count, the enforced limit, and the message id, and
 *    projecting to a `quota_exceeded` / `ATTACHMENT_COUNT_EXCEEDED` {@link
 *    PlatformError}. Exercised through `attachFile`, `attachPastedImage`, and
 *    `attachDropped` (using `seedCount` to sit on the boundary).
 *
 * Everything runs against the in-memory fakes — no real bytes, network, model,
 * or database.
 */

import { describe, expect, it } from 'vitest';

import { AttachmentCountError, FileSizeLimitError } from './errors.js';
import {
  FakeMentionResolver,
  FakeSpeechToText,
  FakeSummarizer,
  FakeUrlFetcher,
  InMemoryAttachmentStore,
} from './fakes.js';
import { InputProcessor, type InputProcessorOptions } from './input-processor.js';
import { MAX_ATTACHMENTS, MAX_FILE_BYTES } from './limits.js';
import type { UploadedFile } from './types.js';

interface Harness {
  processor: InputProcessor;
  store: InMemoryAttachmentStore;
}

/** Build a processor wired to fresh fakes with a deterministic id sequence. */
function makeProcessor(overrides: Partial<InputProcessorOptions> = {}): Harness {
  const store = new InMemoryAttachmentStore();
  let n = 0;
  const processor = new InputProcessor({
    attachmentStore: store,
    speechToText: new FakeSpeechToText(),
    urlFetcher: new FakeUrlFetcher(),
    summarizer: new FakeSummarizer(),
    mentionResolver: new FakeMentionResolver(),
    idGenerator: () => {
      n += 1;
      return `att-${n}`;
    },
    ...overrides,
  });
  return { processor, store };
}

/** An accepted (PDF) file of the given size; no real bytes are allocated. */
function pdfOfSize(sizeBytes: number, fileName = 'doc.pdf'): UploadedFile {
  return { fileName, contentType: 'application/pdf', sizeBytes };
}

/**
 * A stand-in for a `Uint8Array` of `byteLength` bytes without allocating it,
 * so a 100 MB-scale pasted image can be size-checked cheaply. The processor
 * only reads `.byteLength` for the size limit and `sizeBytes`.
 */
function bytesOfLength(byteLength: number): Uint8Array {
  return { byteLength } as unknown as Uint8Array;
}

describe('Input_Processor file-size limit — 100 MB (Req 7.7)', () => {
  // sizes around the exact boundary: under, at, and one byte over.
  const sizeCases: Array<{ label: string; sizeBytes: number; accepted: boolean }> = [
    { label: 'MAX_FILE_BYTES - 1', sizeBytes: MAX_FILE_BYTES - 1, accepted: true },
    { label: 'MAX_FILE_BYTES (exactly the limit)', sizeBytes: MAX_FILE_BYTES, accepted: true },
    { label: 'MAX_FILE_BYTES + 1', sizeBytes: MAX_FILE_BYTES + 1, accepted: false },
  ];

  describe('attachFile path', () => {
    for (const { label, sizeBytes, accepted } of sizeCases) {
      it(`${accepted ? 'accepts' : 'rejects'} a file of ${label}`, async () => {
        const { processor, store } = makeProcessor();
        if (accepted) {
          const attachment = await processor.attachFile('msg-1', pdfOfSize(sizeBytes));
          expect(attachment.sizeBytes).toBe(sizeBytes);
          expect(store.saved).toHaveLength(1);
        } else {
          await expect(processor.attachFile('msg-1', pdfOfSize(sizeBytes))).rejects.toBeInstanceOf(
            FileSizeLimitError,
          );
          // The oversized file is never persisted.
          expect(store.saved).toHaveLength(0);
          expect(await store.countForMessage('msg-1')).toBe(0);
        }
      });
    }

    it('the over-limit error carries the size and projects to a PlatformError', async () => {
      const { processor } = makeProcessor();
      const oversize = MAX_FILE_BYTES + 1;
      const error = await processor.attachFile('msg-1', pdfOfSize(oversize, 'huge.pdf')).then(
        () => {
          throw new Error('expected attachFile to reject an oversized file');
        },
        (caught: unknown) => caught as FileSizeLimitError,
      );

      expect(error).toBeInstanceOf(FileSizeLimitError);
      expect(error.sizeBytes).toBe(oversize);
      expect(error.limitBytes).toBe(MAX_FILE_BYTES);
      expect(error.fileName).toBe('huge.pdf');

      const platform = error.toPlatformError('corr-size');
      expect(platform.category).toBe('validation');
      expect(platform.code).toBe('FILE_SIZE_LIMIT_EXCEEDED');
      expect(platform.correlationId).toBe('corr-size');
      expect(platform.details).toMatchObject({
        sizeBytes: oversize,
        limitBytes: MAX_FILE_BYTES,
      });
    });
  });

  describe('attachPastedImage path', () => {
    it('accepts a pasted image exactly at the limit', async () => {
      const { processor, store } = makeProcessor();
      const attachment = await processor.attachPastedImage('msg-1', bytesOfLength(MAX_FILE_BYTES));
      expect(attachment.sizeBytes).toBe(MAX_FILE_BYTES);
      expect(store.saved).toHaveLength(1);
    });

    it('rejects a pasted image one byte over the limit and persists nothing', async () => {
      const { processor, store } = makeProcessor();
      const error = await processor
        .attachPastedImage('msg-1', bytesOfLength(MAX_FILE_BYTES + 1))
        .then(
          () => {
            throw new Error('expected attachPastedImage to reject an oversized image');
          },
          (caught: unknown) => caught as FileSizeLimitError,
        );

      expect(error).toBeInstanceOf(FileSizeLimitError);
      expect(error.sizeBytes).toBe(MAX_FILE_BYTES + 1);
      expect(error.limitBytes).toBe(MAX_FILE_BYTES);
      const platform = error.toPlatformError('corr-paste');
      expect(platform.category).toBe('validation');
      expect(platform.code).toBe('FILE_SIZE_LIMIT_EXCEEDED');
      expect(store.saved).toHaveLength(0);
    });
  });

  describe('attachDropped (file) path', () => {
    it('accepts a dropped file exactly at the limit', async () => {
      const { processor, store } = makeProcessor();
      const attachment = await processor.attachDropped('msg-1', {
        file: pdfOfSize(MAX_FILE_BYTES, 'dropped.pdf'),
      });
      expect(attachment.sizeBytes).toBe(MAX_FILE_BYTES);
      expect(store.saved).toHaveLength(1);
    });

    it('rejects a dropped file over the limit and persists nothing', async () => {
      const { processor, store } = makeProcessor();
      const error = await processor
        .attachDropped('msg-1', { file: pdfOfSize(MAX_FILE_BYTES + 1, 'dropped-huge.pdf') })
        .then(
          () => {
            throw new Error('expected attachDropped to reject an oversized file');
          },
          (caught: unknown) => caught as FileSizeLimitError,
        );

      expect(error).toBeInstanceOf(FileSizeLimitError);
      expect(error.limitBytes).toBe(MAX_FILE_BYTES);
      const platform = error.toPlatformError('corr-drop');
      expect(platform.category).toBe('validation');
      expect(platform.code).toBe('FILE_SIZE_LIMIT_EXCEEDED');
      expect(store.saved).toHaveLength(0);
    });
  });
});

describe('Input_Processor attachment-count limit — 10 per message (Req 7.8)', () => {
  it('accepts the 1st through the 10th attachment, then rejects the 11th', async () => {
    const { processor, store } = makeProcessor();
    // counts table: each attach is accepted while the message holds < 10.
    for (let existing = 0; existing < MAX_ATTACHMENTS; existing += 1) {
      const attachment = await processor.attachFile('msg-1', pdfOfSize(1024, `f${existing}.pdf`));
      expect(attachment.messageId).toBe('msg-1');
      expect(await store.countForMessage('msg-1')).toBe(existing + 1);
    }
    expect(await store.countForMessage('msg-1')).toBe(MAX_ATTACHMENTS);

    // The 11th is rejected.
    await expect(
      processor.attachFile('msg-1', pdfOfSize(1024, 'eleven.pdf')),
    ).rejects.toBeInstanceOf(AttachmentCountError);
    // No 11th entry was persisted.
    expect(store.saved).toHaveLength(MAX_ATTACHMENTS);
  });

  it('the count error carries the count/limit/messageId and projects to a PlatformError', async () => {
    const { processor, store } = makeProcessor();
    store.seedCount('msg-9', MAX_ATTACHMENTS);
    const error = await processor.attachFile('msg-9', pdfOfSize(1024, 'extra.pdf')).then(
      () => {
        throw new Error('expected attachFile to reject the 11th attachment');
      },
      (caught: unknown) => caught as AttachmentCountError,
    );

    expect(error).toBeInstanceOf(AttachmentCountError);
    expect(error.currentCount).toBe(MAX_ATTACHMENTS);
    expect(error.limit).toBe(MAX_ATTACHMENTS);
    expect(error.messageId).toBe('msg-9');

    const platform = error.toPlatformError('corr-count');
    expect(platform.category).toBe('quota_exceeded');
    expect(platform.code).toBe('ATTACHMENT_COUNT_EXCEEDED');
    expect(platform.correlationId).toBe('corr-count');
    expect(platform.details).toMatchObject({
      messageId: 'msg-9',
      currentCount: MAX_ATTACHMENTS,
      limit: MAX_ATTACHMENTS,
    });
    // Nothing extra was persisted by the rejected call.
    expect(store.saved).toHaveLength(0);
  });

  // The limit is enforced uniformly regardless of which entry point adds the 11th.
  const attachPaths: Array<{
    name: string;
    addEleventh: (processor: InputProcessor, messageId: string) => Promise<unknown>;
  }> = [
    {
      name: 'attachFile',
      addEleventh: (processor, messageId) =>
        processor.attachFile(messageId, pdfOfSize(1024, 'over.pdf')),
    },
    {
      name: 'attachPastedImage',
      addEleventh: (processor, messageId) =>
        processor.attachPastedImage(messageId, bytesOfLength(8)),
    },
    {
      name: 'attachDropped (file)',
      addEleventh: (processor, messageId) =>
        processor.attachDropped(messageId, { file: pdfOfSize(1024, 'over.pdf') }),
    },
    {
      name: 'attachDropped (url)',
      addEleventh: (processor, messageId) =>
        processor.attachDropped(messageId, { url: 'https://example.com/over' }),
    },
  ];

  for (const { name, addEleventh } of attachPaths) {
    it(`rejects the 11th attachment added via ${name}`, async () => {
      const { processor, store } = makeProcessor();
      store.seedCount('msg-1', MAX_ATTACHMENTS);
      await expect(addEleventh(processor, 'msg-1')).rejects.toBeInstanceOf(AttachmentCountError);
      expect(store.saved).toHaveLength(0);
    });

    it(`accepts the 10th attachment added via ${name} (boundary just under the cap)`, async () => {
      const { processor, store } = makeProcessor();
      store.seedCount('msg-1', MAX_ATTACHMENTS - 1);
      await expect(addEleventh(processor, 'msg-1')).resolves.toBeDefined();
      expect(store.saved).toHaveLength(1);
    });
  }
});
