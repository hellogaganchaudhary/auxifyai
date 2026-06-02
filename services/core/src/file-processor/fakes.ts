/**
 * Test fakes for the File_Processor ingest path (Req 11.1, 11.3, 11.4, 11.5,
 * 11.7).
 *
 * Each injectable port has a small, deterministic in-memory implementation so
 * the processor's orchestration — type detection, malware short-circuit, OCR
 * routing, chunking/embedding, persistence, indexing, and archive expansion —
 * can be unit-tested without a real scanner, parser, OCR engine, embedding
 * model, archive library, or cloud backend:
 *
 *  - {@link FakeMalwareScanner} reports `clean` by default and `threat` for any
 *    file name seeded as malicious (Req 11.1).
 *  - {@link FakeTextExtractor} returns canned text per file name, and can flag a
 *    file as needing OCR (Req 11.3, 11.4).
 *  - {@link FakeOcrEngine} returns canned recognized text (Req 11.3).
 *  - {@link DeterministicEmbedder} returns one fixed-dimension vector per input,
 *    upholding the one-embedding-per-chunk invariant and the 1536-dim
 *    Vector_Store contract (Req 11.4, 44.2). {@link MiscountingEmbedder} returns
 *    the wrong count to exercise the fail-closed guard.
 *  - {@link FakeArchiveExpander} returns seeded members for an archive (Req 11.7).
 *  - {@link CapturingAuditRecorder} records every malware-rejection audit event
 *    so a test can assert the rejection was audited (Req 11.2).
 *  - {@link InMemoryStorageUsageStore} tracks per-user and per-Organization
 *    stored bytes and the Organization's configured quota, so the per-user
 *    (Req 11.8) and per-Organization (Req 11.9) quota enforcement is testable.
 *
 * The durable side effects reuse the spec-faithful {@link InMemoryObjectStore}
 * and {@link InMemoryVectorStore} from the storage layer.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import { EMBEDDING_DIMENSIONS } from '../storage/index.js';

import type {
  ArchiveExpander,
  ArchiveMember,
  Embedder,
  ExtractedText,
  MalwareScanner,
  MalwareScanResult,
  OcrEngine,
  RawFile,
  StorageUsageStore,
  TextExtractor,
} from './types.js';

/** Build a {@link RawFile} from a name plus optional overrides, for tests. */
export function makeRawFile(fileName: string, overrides: Partial<RawFile> = {}): RawFile {
  const bytes = overrides.bytes ?? new TextEncoder().encode(`bytes:${fileName}`);
  return {
    fileName,
    sizeBytes: overrides.sizeBytes ?? bytes.byteLength,
    bytes,
    ...(overrides.contentType !== undefined ? { contentType: overrides.contentType } : {}),
  };
}

/**
 * A {@link MalwareScanner} fake: every file is `clean` unless its name (or
 * member path) is seeded as malicious, in which case it reports a `threat`.
 */
export class FakeMalwareScanner implements MalwareScanner {
  /** Every file passed to {@link scan}, in order. */
  readonly calls: RawFile[] = [];
  private readonly threats = new Set<string>();

  constructor(maliciousFileNames: Iterable<string> = []) {
    for (const name of maliciousFileNames) {
      this.threats.add(name);
    }
  }

  /** Seed a file name that should be flagged as a threat. */
  flag(fileName: string): void {
    this.threats.add(fileName);
  }

  async scan(file: RawFile): Promise<MalwareScanResult> {
    this.calls.push(file);
    if (this.threats.has(file.fileName)) {
      return { status: 'threat', detail: `signature match in "${file.fileName}"` };
    }
    return { status: 'clean' };
  }
}

/**
 * A {@link TextExtractor} fake returning canned text per file name. A file name
 * seeded as "scanned" returns empty text flagged {@link ExtractedText.needsOcr}
 * so the processor routes it through OCR (Req 11.3).
 */
export class FakeTextExtractor implements TextExtractor {
  /** Every file name passed to {@link extract}, in order. */
  readonly calls: string[] = [];
  private readonly texts = new Map<string, string>();
  private readonly scanned = new Set<string>();

  constructor(private readonly defaultText = 'extracted text') {}

  /** Seed the text a given file name extracts to. */
  setText(fileName: string, text: string): void {
    this.texts.set(fileName, text);
  }

  /** Mark a file name as a scanned page that must go through OCR (Req 11.3). */
  markScanned(fileName: string): void {
    this.scanned.add(fileName);
  }

  async extract(file: RawFile): Promise<ExtractedText> {
    this.calls.push(file.fileName);
    if (this.scanned.has(file.fileName)) {
      return { text: '', needsOcr: true };
    }
    return { text: this.texts.get(file.fileName) ?? this.defaultText };
  }
}

/** An {@link OcrEngine} fake returning canned recognized text per file name. */
export class FakeOcrEngine implements OcrEngine {
  /** Every file passed to {@link recognize}, in order. */
  readonly calls: RawFile[] = [];
  private readonly texts = new Map<string, string>();

  constructor(private readonly defaultText = 'ocr text') {}

  /** Seed the recognized text for a given file name. */
  setText(fileName: string, text: string): void {
    this.texts.set(fileName, text);
  }

  async recognize(file: RawFile): Promise<string> {
    this.calls.push(file);
    return this.texts.get(file.fileName) ?? this.defaultText;
  }
}

/**
 * An {@link Embedder} fake returning exactly one fixed-dimension vector per
 * input, in order (Req 11.4). Each vector is deterministic in the chunk's
 * length so distinct chunks embed distinctly, and every vector has exactly
 * {@link EMBEDDING_DIMENSIONS} dimensions so the Vector_Store accepts it
 * (Req 44.2).
 */
export class DeterministicEmbedder implements Embedder {
  /** Every batch of texts passed to {@link embed}, in order. */
  readonly calls: string[][] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const seed = (text.length % 97) / 97;
      return new Array<number>(EMBEDDING_DIMENSIONS).fill(seed);
    });
  }
}

/**
 * An {@link Embedder} fake that deliberately returns the wrong number of
 * embeddings, to exercise the File_Processor's one-embedding-per-chunk guard
 * ({@link import('./errors.js').EmbeddingCountError}, Req 11.4).
 */
export class MiscountingEmbedder implements Embedder {
  constructor(private readonly delta = -1) {}

  async embed(texts: string[]): Promise<number[][]> {
    const count = Math.max(0, texts.length + this.delta);
    return Array.from({ length: count }, () =>
      new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
    );
  }
}

/** An {@link ArchiveExpander} fake returning seeded members for an archive (Req 11.7). */
export class FakeArchiveExpander implements ArchiveExpander {
  /** Every archive file passed to {@link expand}, in order. */
  readonly calls: RawFile[] = [];
  private readonly members = new Map<string, ArchiveMember[]>();

  /** Seed the members an archive (by file name) expands to. */
  setMembers(archiveName: string, members: ArchiveMember[]): void {
    this.members.set(archiveName, members);
  }

  async expand(file: RawFile): Promise<ArchiveMember[]> {
    this.calls.push(file);
    return this.members.get(file.fileName) ?? [];
  }
}

/** A captured malware-rejection audit event, with the scope it was recorded in. */
export interface CapturedFileAudit {
  /** The tenant context the event was scoped to. */
  ctx: TenantContext;
  /** The recorded event. */
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} that stores every recorded event so a test
 * can assert a malware rejection was audited (Req 11.2), mirroring the
 * capturing recorders used by Access_Control and the Tenancy_Service.
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedFileAudit[] = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({ ctx, event });
  }

  /** The number of recorded events. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `file.malware_rejected`). */
  withAction(action: string): CapturedFileAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }
}

/**
 * An in-memory {@link StorageUsageStore} that accumulates per-user and
 * per-Organization stored bytes and resolves each Organization's configured
 * quota (Req 11.8, 11.9).
 *
 * The per-Organization quota defaults to a large, effectively-unbounded value
 * so a test exercising the per-user quota in isolation is never tripped by the
 * Organization quota; a test can lower it via {@link setOrganizationQuota}.
 */
export class InMemoryStorageUsageStore implements StorageUsageStore {
  /** Every `recordUsage` call, in order, for assertion. */
  readonly recordings: Array<{ organizationId: string; ownerId: string; bytes: number }> = [];

  private readonly userBytes = new Map<string, number>();
  private readonly orgBytes = new Map<string, number>();
  private readonly orgQuota = new Map<string, number>();

  /** The default per-Organization quota when none is set (effectively unbounded). */
  static readonly DEFAULT_ORG_QUOTA_BYTES = Number.MAX_SAFE_INTEGER;

  /** Set an Organization's configured storage quota in bytes (Req 11.9). */
  setOrganizationQuota(organizationId: string, quotaBytes: number): void {
    this.orgQuota.set(organizationId, quotaBytes);
  }

  /** Seed an Organization's already-stored bytes (e.g. to sit just under its quota). */
  seedOrganizationUsage(organizationId: string, bytes: number): void {
    this.orgBytes.set(organizationId, bytes);
  }

  /** Seed a user's already-stored bytes (e.g. to sit just under the per-user quota). */
  seedUserUsage(organizationId: string, ownerId: string, bytes: number): void {
    this.userBytes.set(userKey(organizationId, ownerId), bytes);
  }

  async getUserUsage(organizationId: string, ownerId: string): Promise<number> {
    return this.userBytes.get(userKey(organizationId, ownerId)) ?? 0;
  }

  async getOrganizationUsage(organizationId: string): Promise<number> {
    return this.orgBytes.get(organizationId) ?? 0;
  }

  async getOrganizationQuotaBytes(organizationId: string): Promise<number> {
    return this.orgQuota.get(organizationId) ?? InMemoryStorageUsageStore.DEFAULT_ORG_QUOTA_BYTES;
  }

  async recordUsage(organizationId: string, ownerId: string, bytes: number): Promise<void> {
    this.recordings.push({ organizationId, ownerId, bytes });
    const uKey = userKey(organizationId, ownerId);
    this.userBytes.set(uKey, (this.userBytes.get(uKey) ?? 0) + bytes);
    this.orgBytes.set(organizationId, (this.orgBytes.get(organizationId) ?? 0) + bytes);
  }
}

/** Compose the composite key under which a user's bytes are tracked within an Organization. */
function userKey(organizationId: string, ownerId: string): string {
  return `${organizationId}\u0000${ownerId}`;
}
