/**
 * Unit tests for the File_Processor ingest path (Req 11.1, 11.2, 11.3, 11.4,
 * 11.5, 11.6, 11.7, 11.8, 11.9).
 *
 * These exercise the full ingest surface against the in-memory fakes and the
 * spec-faithful storage backends — no real scanner, parser, OCR engine,
 * embedding model, archive library, or cloud backend:
 *
 *  - type detection and unsupported-format rejection (Req 11.1, 11.6);
 *  - malware short-circuit with nothing persisted or indexed, recorded in the
 *    Audit_Service (Req 11.1, 11.2, Property 27);
 *  - OCR routing for images and scanned pages (Req 11.3);
 *  - chunk → embed → store → index with one embedding per chunk (Req 11.4,
 *    11.5, Property 28);
 *  - ZIP expansion with per-member processing and unsupported-member skipping
 *    (Req 11.7);
 *  - per-user (Req 11.8) and per-Organization (Req 11.9) storage-quota
 *    enforcement with usage accumulating across uploads.
 */

import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_DIMENSIONS,
  InMemoryObjectStore,
  InMemoryVectorStore,
} from '../storage/index.js';

import {
  EmbeddingCountError,
  EmptyArchiveError,
  OrganizationStorageQuotaExceededError,
  StorageQuotaExceededError,
  UnsupportedFileFormatError,
} from './errors.js';
import {
  CapturingAuditRecorder,
  DeterministicEmbedder,
  FakeArchiveExpander,
  FakeMalwareScanner,
  FakeOcrEngine,
  FakeTextExtractor,
  InMemoryStorageUsageStore,
  MiscountingEmbedder,
  makeRawFile,
} from './fakes.js';
import {
  FileProcessor,
  USER_STORAGE_QUOTA_BYTES,
  type FileProcessorOptions,
} from './file-processor.js';
import type { Embedder, IngestFileInput, ProcessedFile } from './types.js';

interface Harness {
  processor: FileProcessor;
  scanner: FakeMalwareScanner;
  extractor: FakeTextExtractor;
  ocr: FakeOcrEngine;
  embedder: DeterministicEmbedder;
  expander: FakeArchiveExpander;
  objects: InMemoryObjectStore;
  vectors: InMemoryVectorStore;
  audit: CapturingAuditRecorder;
  storageUsage: InMemoryStorageUsageStore;
}

/** Build a processor wired to fresh fakes, with deterministic ids and clock. */
function makeProcessor(overrides: Partial<FileProcessorOptions> = {}): Harness {
  const scanner = new FakeMalwareScanner();
  const extractor = new FakeTextExtractor();
  const ocr = new FakeOcrEngine();
  const embedder = new DeterministicEmbedder();
  const expander = new FakeArchiveExpander();
  const objects = new InMemoryObjectStore();
  const vectors = new InMemoryVectorStore();
  const audit = new CapturingAuditRecorder();
  const storageUsage = new InMemoryStorageUsageStore();
  let n = 0;
  const processor = new FileProcessor({
    malwareScanner: scanner,
    textExtractor: extractor,
    ocrEngine: ocr,
    embedder,
    archiveExpander: expander,
    objectStore: objects,
    vectorStore: vectors,
    auditRecorder: audit,
    storageUsage,
    idGenerator: () => {
      n += 1;
      return `file-${n}`;
    },
    clock: () => '2024-01-01T00:00:00.000Z',
    chunkOptions: { chunkSize: 20, overlap: 5 },
    ...overrides,
  });
  return {
    processor,
    scanner,
    extractor,
    ocr,
    embedder,
    expander,
    objects,
    vectors,
    audit,
    storageUsage,
  };
}

function input(partial: Partial<IngestFileInput> & { fileName: string }): IngestFileInput {
  const bytes = partial.bytes ?? new TextEncoder().encode('payload');
  return {
    ownerId: 'user-1',
    organizationId: 'org-1',
    sizeBytes: partial.sizeBytes ?? bytes.byteLength,
    bytes,
    ...partial,
  };
}

function onlyProcessed(report: { files: ReadonlyArray<{ status: string }> }): ProcessedFile[] {
  return report.files.filter((f): f is ProcessedFile => f.status === 'processed');
}

describe('FileProcessor.ingest — type detection (Req 11.1, 11.6)', () => {
  const supported: Array<{ name: string; contentType?: string; category: string }> = [
    { name: 'a.pdf', contentType: 'application/pdf', category: 'document' },
    { name: 'a.docx', category: 'document' },
    { name: 'a.pptx', category: 'document' },
    { name: 'a.txt', contentType: 'text/plain', category: 'document' },
    { name: 'a.md', category: 'document' },
    { name: 'a.xlsx', category: 'spreadsheet' },
    { name: 'a.csv', contentType: 'text/csv', category: 'spreadsheet' },
    { name: 'a.png', contentType: 'image/png', category: 'image' },
    { name: 'a.jpg', contentType: 'image/jpeg', category: 'image' },
    { name: 'a.webp', category: 'image' },
    { name: 'a.svg', contentType: 'image/svg+xml', category: 'image' },
    { name: 'a.gif', category: 'image' },
    { name: 'a.json', contentType: 'application/json', category: 'data' },
    { name: 'a.xml', category: 'data' },
    { name: 'a.yaml', category: 'data' },
    { name: 'a.toml', category: 'data' },
    { name: 'a.mp3', contentType: 'audio/mpeg', category: 'audio' },
    { name: 'a.wav', category: 'audio' },
  ];

  for (const c of supported) {
    it(`accepts and categorizes ${c.name} as ${c.category}`, async () => {
      const h = makeProcessor();
      const report = await h.processor.ingest(
        input({ fileName: c.name, ...(c.contentType ? { contentType: c.contentType } : {}) }),
      );
      const processed = onlyProcessed(report);
      expect(processed).toHaveLength(1);
      expect(processed[0]!.file.category).toBe(c.category);
    });
  }

  it('rejects a directly uploaded unsupported format (Req 11.6)', async () => {
    const h = makeProcessor();
    await expect(
      h.processor.ingest(input({ fileName: 'a.exe', contentType: 'application/x-msdownload' })),
    ).rejects.toBeInstanceOf(UnsupportedFileFormatError);
    // Nothing persisted or indexed.
    expect(h.vectors.size()).toBe(0);
  });
});

describe('FileProcessor.ingest — malware rejection (Req 11.1, 11.2, Property 27)', () => {
  it('rejects a malware-flagged file with nothing persisted or indexed', async () => {
    const h = makeProcessor();
    h.scanner.flag('bad.pdf');
    const report = await h.processor.ingest(input({ fileName: 'bad.pdf', contentType: 'application/pdf' }));

    expect(report.files).toHaveLength(1);
    const outcome = report.files[0]!;
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.reason).toBe('malware');
      expect(outcome.fileName).toBe('bad.pdf');
    }
    // No object stored, no vectors indexed, extractor/embedder never invoked.
    expect(h.vectors.size()).toBe(0);
    expect(await h.objects.exists('files/org-1/file-1')).toBe(false);
    expect(h.extractor.calls).toHaveLength(0);
    expect(h.embedder.calls).toHaveLength(0);
    // Nothing accrued against storage usage (Req 11.8, 11.9).
    expect(h.storageUsage.recordings).toHaveLength(0);
  });

  it('records the malware rejection in the Audit_Service (Req 11.2)', async () => {
    const h = makeProcessor();
    h.scanner.flag('bad.pdf');
    await h.processor.ingest(
      input({ fileName: 'bad.pdf', contentType: 'application/pdf', ownerId: 'user-7', organizationId: 'org-3' }),
    );

    const audited = h.audit.withAction('file.malware_rejected');
    expect(audited).toHaveLength(1);
    const { ctx, event } = audited[0]!;
    // Scoped to the uploading user's Organization, with the user as actor.
    expect(ctx.organizationId).toBe('org-3');
    expect(ctx.userId).toBe('user-7');
    expect(event.actorId).toBe('user-7');
    expect(event.resourceType).toBe('file');
    expect(event.resourceId).toBe('bad.pdf');
    expect(event.metadata).toMatchObject({ fileName: 'bad.pdf' });
  });

  it('does not audit a clean file', async () => {
    const h = makeProcessor();
    await h.processor.ingest(input({ fileName: 'doc.txt', contentType: 'text/plain' }));
    expect(h.audit.withAction('file.malware_rejected')).toHaveLength(0);
  });

  it('scans before extracting (the scan is the first step)', async () => {
    const h = makeProcessor();
    h.scanner.flag('bad.txt');
    await h.processor.ingest(input({ fileName: 'bad.txt', contentType: 'text/plain' }));
    expect(h.scanner.calls).toHaveLength(1);
    expect(h.ocr.calls).toHaveLength(0);
  });
});

describe('FileProcessor.ingest — OCR routing (Req 11.3)', () => {
  it('runs OCR for an image file and indexes the recognized text', async () => {
    const h = makeProcessor();
    h.ocr.setText('scan.png', 'recognized words from image');
    const report = await h.processor.ingest(
      input({ fileName: 'scan.png', contentType: 'image/png' }),
    );
    const processed = onlyProcessed(report);
    expect(processed[0]!.ocrApplied).toBe(true);
    expect(h.ocr.calls).toHaveLength(1);
    // The text extractor is not used for images.
    expect(h.extractor.calls).toHaveLength(0);
    expect(processed[0]!.chunkCount).toBeGreaterThan(0);
  });

  it('runs OCR for a scanned document page flagged by the extractor', async () => {
    const h = makeProcessor();
    h.extractor.markScanned('scanned.pdf');
    h.ocr.setText('scanned.pdf', 'ocr of the scanned pdf');
    const report = await h.processor.ingest(
      input({ fileName: 'scanned.pdf', contentType: 'application/pdf' }),
    );
    const processed = onlyProcessed(report);
    expect(processed[0]!.ocrApplied).toBe(true);
    expect(h.extractor.calls).toEqual(['scanned.pdf']);
    expect(h.ocr.calls).toHaveLength(1);
  });

  it('does not run OCR for a text-bearing document', async () => {
    const h = makeProcessor();
    const report = await h.processor.ingest(input({ fileName: 'doc.txt', contentType: 'text/plain' }));
    const processed = onlyProcessed(report);
    expect(processed[0]!.ocrApplied).toBe(false);
    expect(h.ocr.calls).toHaveLength(0);
  });
});

describe('FileProcessor.ingest — chunk, embed, store, index (Req 11.4, 11.5, Property 28)', () => {
  it('persists the original bytes in the Object_Store (Req 11.5)', async () => {
    const h = makeProcessor();
    const bytes = new TextEncoder().encode('the original file payload');
    const report = await h.processor.ingest(
      input({ fileName: 'doc.txt', contentType: 'text/plain', bytes }),
    );
    const processed = onlyProcessed(report)[0]!;
    expect(processed.file.objectKey).toBe('files/org-1/file-1');
    const stored = await h.objects.get(processed.file.objectKey);
    expect(stored).toEqual(bytes);
  });

  it('creates exactly one embedding per chunk and indexes them all (Property 28)', async () => {
    const h = makeProcessor();
    // 60 chars of text, chunkSize 20 / overlap 5 → multiple chunks.
    h.extractor.setText('doc.txt', 'A'.repeat(60));
    const report = await h.processor.ingest(input({ fileName: 'doc.txt', contentType: 'text/plain' }));
    const processed = onlyProcessed(report)[0]!;

    expect(processed.chunkCount).toBeGreaterThan(1);
    expect(processed.vectorIds).toHaveLength(processed.chunkCount);
    // The embedder was called once with exactly chunkCount texts.
    expect(h.embedder.calls).toHaveLength(1);
    expect(h.embedder.calls[0]).toHaveLength(processed.chunkCount);
    // Every chunk was indexed in the Vector_Store as a file_chunk record.
    expect(h.vectors.size()).toBe(processed.chunkCount);
    const matches = await h.vectors.query(new Array<number>(EMBEDDING_DIMENSIONS).fill(0), {
      organizationId: 'org-1',
      ownerType: 'file_chunk',
    }, 100);
    expect(matches).toHaveLength(processed.chunkCount);
    for (const m of matches) {
      expect(m.ownerId).toBe(processed.file.id);
    }
  });

  it('indexes records scoped to the owning Organization (Req 1.2, 44.2)', async () => {
    const h = makeProcessor();
    await h.processor.ingest(input({ fileName: 'doc.txt', contentType: 'text/plain', organizationId: 'org-9' }));
    const sameOrg = await h.vectors.query(new Array<number>(EMBEDDING_DIMENSIONS).fill(0), {
      organizationId: 'org-9',
    }, 100);
    const otherOrg = await h.vectors.query(new Array<number>(EMBEDDING_DIMENSIONS).fill(0), {
      organizationId: 'org-1',
    }, 100);
    expect(sameOrg.length).toBeGreaterThan(0);
    expect(otherOrg).toHaveLength(0);
  });

  it('produces no chunks or vectors for empty extracted text', async () => {
    const h = makeProcessor();
    h.extractor.setText('empty.txt', '   ');
    const report = await h.processor.ingest(input({ fileName: 'empty.txt', contentType: 'text/plain' }));
    const processed = onlyProcessed(report)[0]!;
    expect(processed.chunkCount).toBe(0);
    expect(processed.vectorIds).toHaveLength(0);
    expect(h.vectors.size()).toBe(0);
    // The original bytes are still persisted (Req 11.5).
    expect(await h.objects.exists(processed.file.objectKey)).toBe(true);
  });

  it('fails closed when the embedder violates one-embedding-per-chunk (Req 11.4)', async () => {
    const miscount: Embedder = new MiscountingEmbedder(-1);
    const h = makeProcessor({ embedder: miscount });
    h.extractor.setText('doc.txt', 'A'.repeat(60));
    await expect(
      h.processor.ingest(input({ fileName: 'doc.txt', contentType: 'text/plain' })),
    ).rejects.toBeInstanceOf(EmbeddingCountError);
    // Nothing indexed when the invariant is violated.
    expect(h.vectors.size()).toBe(0);
  });
});

describe('FileProcessor.ingest — ZIP expansion (Req 11.7)', () => {
  it('expands a ZIP and processes each supported member', async () => {
    const h = makeProcessor();
    h.expander.setMembers('bundle.zip', [
      { path: 'a.txt', file: makeRawFile('a.txt', { contentType: 'text/plain' }) },
      { path: 'b.csv', file: makeRawFile('b.csv', { contentType: 'text/csv' }) },
    ]);
    const report = await h.processor.ingest(
      input({ fileName: 'bundle.zip', contentType: 'application/zip' }),
    );
    const processed = onlyProcessed(report);
    expect(processed).toHaveLength(2);
    expect(processed.map((p) => p.archivePath)).toEqual(['a.txt', 'b.csv']);
    // Each member's bytes were persisted and chunks indexed.
    expect(h.vectors.size()).toBeGreaterThanOrEqual(2);
  });

  it('skips unsupported members rather than failing the whole archive', async () => {
    const h = makeProcessor();
    h.expander.setMembers('bundle.zip', [
      { path: 'good.md', file: makeRawFile('good.md') },
      { path: 'bad.exe', file: makeRawFile('bad.exe', { contentType: 'application/x-msdownload' }) },
    ]);
    const report = await h.processor.ingest(
      input({ fileName: 'bundle.zip', contentType: 'application/zip' }),
    );
    expect(report.files).toHaveLength(2);
    expect(onlyProcessed(report)).toHaveLength(1);
    const skipped = report.files.find((f) => f.status === 'skipped');
    expect(skipped?.status).toBe('skipped');
    if (skipped?.status === 'skipped') {
      expect(skipped.reason).toBe('unsupported_format');
      expect(skipped.fileName).toBe('bad.exe');
    }
  });

  it('rejects a malware-flagged member without indexing it, keeping clean siblings', async () => {
    const h = makeProcessor();
    h.scanner.flag('virus.txt');
    h.expander.setMembers('bundle.zip', [
      { path: 'clean.txt', file: makeRawFile('clean.txt', { contentType: 'text/plain' }) },
      { path: 'virus.txt', file: makeRawFile('virus.txt', { contentType: 'text/plain' }) },
    ]);
    const report = await h.processor.ingest(
      input({ fileName: 'bundle.zip', contentType: 'application/zip' }),
    );
    expect(onlyProcessed(report)).toHaveLength(1);
    const rejected = report.files.find((f) => f.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.archivePath).toBe('virus.txt');
    }
  });

  it('expands nested archives and prefixes member provenance paths', async () => {
    const h = makeProcessor();
    h.expander.setMembers('outer.zip', [
      { path: 'inner.zip', file: makeRawFile('inner.zip', { contentType: 'application/zip' }) },
    ]);
    h.expander.setMembers('inner.zip', [
      { path: 'deep.txt', file: makeRawFile('deep.txt', { contentType: 'text/plain' }) },
    ]);
    const report = await h.processor.ingest(
      input({ fileName: 'outer.zip', contentType: 'application/zip' }),
    );
    const processed = onlyProcessed(report);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.archivePath).toBe('inner.zip/deep.txt');
  });

  it('skips members nested deeper than the recursion limit', async () => {
    const h = makeProcessor({ maxArchiveDepth: 0 });
    h.expander.setMembers('outer.zip', [
      { path: 'inner.zip', file: makeRawFile('inner.zip', { contentType: 'application/zip' }) },
    ]);
    const report = await h.processor.ingest(
      input({ fileName: 'outer.zip', contentType: 'application/zip' }),
    );
    expect(report.files).toHaveLength(1);
    const skipped = report.files[0]!;
    expect(skipped.status).toBe('skipped');
    if (skipped.status === 'skipped') {
      expect(skipped.reason).toBe('archive_too_deep');
    }
  });

  it('rejects a directly uploaded empty archive', async () => {
    const h = makeProcessor();
    h.expander.setMembers('empty.zip', []);
    await expect(
      h.processor.ingest(input({ fileName: 'empty.zip', contentType: 'application/zip' })),
    ).rejects.toBeInstanceOf(EmptyArchiveError);
  });
});

describe('FileProcessor.ingest — storage quotas (Req 11.8, 11.9)', () => {
  it('accepts an upload within both quotas and accrues usage', async () => {
    const h = makeProcessor();
    const bytes = new TextEncoder().encode('payload');
    const report = await h.processor.ingest(
      input({ fileName: 'doc.txt', contentType: 'text/plain', bytes }),
    );
    expect(onlyProcessed(report)).toHaveLength(1);
    // Usage was recorded once for the stored bytes, against the owner/Org.
    expect(h.storageUsage.recordings).toEqual([
      { organizationId: 'org-1', ownerId: 'user-1', bytes: bytes.byteLength },
    ]);
    expect(await h.storageUsage.getUserUsage('org-1', 'user-1')).toBe(bytes.byteLength);
    expect(await h.storageUsage.getOrganizationUsage('org-1')).toBe(bytes.byteLength);
  });

  it('rejects an upload that would exceed the per-user quota, persisting nothing (Req 11.8)', async () => {
    const h = makeProcessor();
    // Seat the user one byte under the quota; a multi-byte file tips them over.
    h.storageUsage.seedUserUsage('org-1', 'user-1', USER_STORAGE_QUOTA_BYTES - 1);
    const bytes = new TextEncoder().encode('over the line');
    await expect(
      h.processor.ingest(input({ fileName: 'big.txt', contentType: 'text/plain', bytes })),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);

    // Nothing persisted, indexed, extracted, or further accrued.
    expect(h.vectors.size()).toBe(0);
    expect(await h.objects.exists('files/org-1/file-1')).toBe(false);
    expect(h.extractor.calls).toHaveLength(0);
    expect(h.embedder.calls).toHaveLength(0);
    expect(h.storageUsage.recordings).toHaveLength(0);
  });

  it('rejects an upload that would exceed the per-Organization quota, persisting nothing (Req 11.9)', async () => {
    const h = makeProcessor();
    const bytes = new TextEncoder().encode('payload');
    // The Org has a tight quota and is already nearly full (but the user is not).
    h.storageUsage.setOrganizationQuota('org-1', 100);
    h.storageUsage.seedOrganizationUsage('org-1', 100 - 1);
    await expect(
      h.processor.ingest(input({ fileName: 'doc.txt', contentType: 'text/plain', bytes })),
    ).rejects.toBeInstanceOf(OrganizationStorageQuotaExceededError);

    expect(h.vectors.size()).toBe(0);
    expect(await h.objects.exists('files/org-1/file-1')).toBe(false);
    expect(h.storageUsage.recordings).toHaveLength(0);
  });

  it('accepts an upload that exactly reaches a quota boundary', async () => {
    const h = makeProcessor();
    const bytes = new TextEncoder().encode('payload');
    // Org quota is exactly current usage + this upload — at the boundary, allowed.
    h.storageUsage.setOrganizationQuota('org-1', 10 + bytes.byteLength);
    h.storageUsage.seedOrganizationUsage('org-1', 10);
    const report = await h.processor.ingest(
      input({ fileName: 'doc.txt', contentType: 'text/plain', bytes }),
    );
    expect(onlyProcessed(report)).toHaveLength(1);
  });

  it('accumulates usage across successive uploads and rejects once the quota is reached', async () => {
    const h = makeProcessor();
    const bytes = new TextEncoder().encode('1234567890'); // 10 bytes
    // Quota fits exactly two uploads of 10 bytes.
    h.storageUsage.setOrganizationQuota('org-1', 20);

    await h.processor.ingest(input({ fileName: 'a.txt', contentType: 'text/plain', bytes }));
    await h.processor.ingest(input({ fileName: 'b.txt', contentType: 'text/plain', bytes }));
    expect(await h.storageUsage.getOrganizationUsage('org-1')).toBe(20);

    // The third upload would exceed the quota.
    await expect(
      h.processor.ingest(input({ fileName: 'c.txt', contentType: 'text/plain', bytes })),
    ).rejects.toBeInstanceOf(OrganizationStorageQuotaExceededError);
    expect(await h.storageUsage.getOrganizationUsage('org-1')).toBe(20);
  });

  it('checks the per-user quota before the per-Organization quota', async () => {
    const h = makeProcessor();
    const bytes = new TextEncoder().encode('payload');
    // Both quotas would be exceeded; the user-scoped error wins.
    h.storageUsage.seedUserUsage('org-1', 'user-1', USER_STORAGE_QUOTA_BYTES);
    h.storageUsage.setOrganizationQuota('org-1', 0);
    await expect(
      h.processor.ingest(input({ fileName: 'doc.txt', contentType: 'text/plain', bytes })),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);
  });

  it('the per-user quota is the same fixed value across Organizations (Req 11.8)', async () => {
    const h = makeProcessor();
    const bytes = new TextEncoder().encode('payload');
    // A user in a different Organization is bound by the same 10 GB limit.
    h.storageUsage.seedUserUsage('org-2', 'user-2', USER_STORAGE_QUOTA_BYTES);
    await expect(
      h.processor.ingest(
        input({ fileName: 'doc.txt', contentType: 'text/plain', bytes, ownerId: 'user-2', organizationId: 'org-2' }),
      ),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);
  });

  it('projects the per-user quota error into a quota_exceeded PlatformError (Req 11.8, 46.8)', async () => {
    const h = makeProcessor();
    const bytes = new TextEncoder().encode('over');
    h.storageUsage.seedUserUsage('org-1', 'user-1', USER_STORAGE_QUOTA_BYTES);
    try {
      await h.processor.ingest(input({ fileName: 'big.txt', contentType: 'text/plain', bytes }));
      expect.unreachable('expected a StorageQuotaExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(StorageQuotaExceededError);
      const platform = (err as StorageQuotaExceededError).toPlatformError('corr-1');
      expect(platform.category).toBe('quota_exceeded');
      expect(platform.code).toBe('USER_STORAGE_QUOTA_EXCEEDED');
      expect(platform.correlationId).toBe('corr-1');
    }
  });

  it('rejects an over-quota member inside an archive without indexing it (Req 11.9)', async () => {
    const h = makeProcessor();
    const big = makeRawFile('big.txt', { contentType: 'text/plain', sizeBytes: 1000 });
    const small = makeRawFile('small.txt', { contentType: 'text/plain', sizeBytes: 1 });
    h.storageUsage.setOrganizationQuota('org-1', 500);
    h.expander.setMembers('bundle.zip', [
      { path: 'small.txt', file: small },
      { path: 'big.txt', file: big },
    ]);
    // The small member stores fine; the big one trips the Org quota and aborts the ingest.
    await expect(
      h.processor.ingest(input({ fileName: 'bundle.zip', contentType: 'application/zip' })),
    ).rejects.toBeInstanceOf(OrganizationStorageQuotaExceededError);
    // The big member was never indexed.
    const indexed = await h.vectors.query(new Array<number>(EMBEDDING_DIMENSIONS).fill(0), {
      organizationId: 'org-1',
      ownerType: 'file_chunk',
    }, 100);
    for (const m of indexed) {
      expect(m.metadata['fileName']).not.toBe('big.txt');
    }
  });
});
