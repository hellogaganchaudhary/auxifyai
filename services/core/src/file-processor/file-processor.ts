/**
 * File_Processor ingest path (Req 11.1, 11.3, 11.4, 11.5, 11.6, 11.7).
 *
 * {@link FileProcessor.ingest} turns an uploaded file into retrievable
 * knowledge, in order:
 *
 *  1. detect the file type, rejecting an unsupported direct upload (Req 11.1,
 *     11.6);
 *  2. scan for malware and short-circuit a flagged file before any storage,
 *     chunking, embedding, or indexing occurs (Req 11.1, Property 27);
 *  3. for a ZIP archive, expand it and process each supported member
 *     recursively, skipping unsupported members (Req 11.7);
 *  4. otherwise extract text — running OCR for images and scanned pages
 *     (Req 11.3) — split it into chunks and embed each chunk (Req 11.4), then
 *     persist the original bytes in the Object_Store and index the chunk
 *     embeddings in the Vector_Store (Req 11.5).
 *
 * Every external capability is an injected port ({@link MalwareScanner},
 * {@link TextExtractor}, {@link OcrEngine}, {@link Embedder},
 * {@link ArchiveExpander}) and the two durable side effects go through the
 * shared {@link ObjectStore} and {@link VectorStore} interfaces, so the
 * processor is pure orchestration and fully unit-testable with fakes. A
 * malware-flagged file is recorded in the Audit_Service through the injected
 * {@link AuditRecorder} port before it is surfaced as a {@link RejectedFile}
 * outcome (Req 11.2), and the per-user (10 GB, Req 11.8) and per-Organization
 * (configured, Req 11.9) storage quotas are enforced through the injected
 * {@link StorageUsageStore} before any bytes are persisted.
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import type { VectorRecord } from '../storage/index.js';
import type { ObjectStore, VectorStore } from '../storage/index.js';

import { chunkText, type ChunkOptions } from './chunking.js';
import {
  EmbeddingCountError,
  EmptyArchiveError,
  OrganizationStorageQuotaExceededError,
  StorageQuotaExceededError,
  UnsupportedFileFormatError,
} from './errors.js';
import { detectFileType, isArchiveType, isImageType } from './file-types.js';
import type {
  ArchiveExpander,
  DetectedFileType,
  Embedder,
  IngestFileInput,
  IngestOutcome,
  IngestReport,
  MalwareScanner,
  OcrEngine,
  ProcessedFile,
  RawFile,
  RejectedFile,
  SkippedFile,
  StorageUsageStore,
  StoredFile,
  TextExtractor,
} from './types.js';

/** A unique file-id source, injectable for deterministic tests. */
export interface FileIdGenerator {
  /** Return a new unique file id. */
  (): string;
}

/** A clock returning the current ISO-8601 timestamp, injectable for tests. */
export interface IsoClock {
  /** Return the current time as an ISO-8601 string. */
  (): string;
}

/**
 * The default maximum archive recursion depth (Req 11.7).
 *
 * A ZIP at the top level is depth 0; a ZIP nested inside it is depth 1, and so
 * on. Members deeper than this bound are skipped (as `archive_too_deep`) so a
 * maliciously or accidentally deeply-nested archive cannot cause unbounded
 * recursion.
 */
export const DEFAULT_MAX_ARCHIVE_DEPTH = 5;

/**
 * The fixed per-user storage quota in bytes: 10 GB (Req 11.8).
 *
 * A user's cumulative stored file bytes may not exceed this; an upload that
 * would push them past it is rejected with a {@link StorageQuotaExceededError}
 * before any bytes are persisted. Defined as 10 × 1024³ (binary gigabytes).
 */
export const USER_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * Construction-time dependencies for the {@link FileProcessor}.
 *
 * The five capability ports and the two storage backends are required; only the
 * {@link idGenerator}, {@link clock}, {@link chunkOptions}, and
 * {@link maxArchiveDepth} have defaults. Requiring the ports keeps the
 * processor honest — it never silently skips malware scanning, extraction, or
 * indexing — while letting tests inject fakes.
 */
export interface FileProcessorOptions {
  /** Scans each file for malware before any processing (Req 11.1). */
  malwareScanner: MalwareScanner;
  /** Extracts text from non-image, text-bearing files (Req 11.4). */
  textExtractor: TextExtractor;
  /** Recognizes text in images and scanned pages (Req 11.3). */
  ocrEngine: OcrEngine;
  /** Embeds chunk texts into vectors (Req 11.4). */
  embedder: Embedder;
  /** Expands ZIP archives into their members (Req 11.7). */
  archiveExpander: ArchiveExpander;
  /** Persists original file bytes (Req 11.5). */
  objectStore: ObjectStore;
  /** Indexes chunk embeddings (Req 11.5). */
  vectorStore: VectorStore;
  /**
   * Records a malware rejection in the Audit_Service before the file is
   * surfaced as a {@link RejectedFile} (Req 11.2).
   */
  auditRecorder: AuditRecorder;
  /**
   * Tracks and bounds cumulative storage so the per-user (Req 11.8) and
   * per-Organization (Req 11.9) quotas can be enforced before any bytes are
   * persisted.
   */
  storageUsage: StorageUsageStore;
  /** File-id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: FileIdGenerator;
  /** Clock for `createdAt` timestamps (defaults to `new Date().toISOString()`). */
  clock?: IsoClock;
  /** Chunk size / overlap tuning (defaults from `./chunking.js`). */
  chunkOptions?: ChunkOptions;
  /** Maximum archive recursion depth (defaults to {@link DEFAULT_MAX_ARCHIVE_DEPTH}). */
  maxArchiveDepth?: number;
  /** The fixed per-user storage quota in bytes (defaults to {@link USER_STORAGE_QUOTA_BYTES}). */
  userStorageQuotaBytes?: number;
}

/** A file paired with its declared owner/Organization and provenance path. */
interface OwnedFile {
  /** The raw file to process. */
  raw: RawFile;
  /** The owning user id. */
  ownerId: string;
  /** The owning Organization id. */
  organizationId: string;
  /** The archive member path, when this file came from an archive (Req 11.7). */
  archivePath?: string;
}

/**
 * The concrete File_Processor. Construct it with the capability ports and the
 * Object/Vector stores; {@link ingest} returns an {@link IngestReport}
 * describing every file it processed, rejected, or skipped.
 */
export class FileProcessor {
  private readonly scanner: MalwareScanner;
  private readonly extractor: TextExtractor;
  private readonly ocr: OcrEngine;
  private readonly embedder: Embedder;
  private readonly expander: ArchiveExpander;
  private readonly objects: ObjectStore;
  private readonly vectors: VectorStore;
  private readonly audit: AuditRecorder;
  private readonly storageUsage: StorageUsageStore;
  private readonly newId: FileIdGenerator;
  private readonly now: IsoClock;
  private readonly chunkOptions: ChunkOptions;
  private readonly maxArchiveDepth: number;
  private readonly userStorageQuotaBytes: number;

  constructor(options: FileProcessorOptions) {
    this.scanner = options.malwareScanner;
    this.extractor = options.textExtractor;
    this.ocr = options.ocrEngine;
    this.embedder = options.embedder;
    this.expander = options.archiveExpander;
    this.objects = options.objectStore;
    this.vectors = options.vectorStore;
    this.audit = options.auditRecorder;
    this.storageUsage = options.storageUsage;
    this.newId = options.idGenerator ?? ((): string => randomUUID());
    this.now = options.clock ?? ((): string => new Date().toISOString());
    this.chunkOptions = options.chunkOptions ?? {};
    this.maxArchiveDepth = options.maxArchiveDepth ?? DEFAULT_MAX_ARCHIVE_DEPTH;
    this.userStorageQuotaBytes = options.userStorageQuotaBytes ?? USER_STORAGE_QUOTA_BYTES;
  }

  /**
   * Ingest an uploaded file end-to-end (Req 11.1, 11.2, 11.3, 11.4, 11.5,
   * 11.6, 11.7, 11.8, 11.9).
   *
   * A directly uploaded file whose format is unsupported is rejected with an
   * {@link UnsupportedFileFormatError} (Req 11.6); a malware-flagged file is
   * recorded in the Audit_Service and surfaced as a `rejected` outcome with
   * nothing persisted or indexed (Req 11.1, 11.2, Property 27); an upload that
   * would exceed the per-user (Req 11.8) or per-Organization (Req 11.9) storage
   * quota is rejected with a typed quota error before any bytes are persisted;
   * a ZIP archive expands into one outcome per member (Req 11.7). Every other
   * supported file becomes a single `processed` outcome and accrues its bytes
   * against both storage scopes.
   *
   * @param input The uploaded file with its owner/Organization.
   * @returns A report of every file's outcome.
   * @throws {UnsupportedFileFormatError} When the direct upload's format is unsupported.
   * @throws {EmbeddingCountError} When the embedder violates one-embedding-per-chunk.
   * @throws {StorageQuotaExceededError} When the upload would exceed the per-user quota (Req 11.8).
   * @throws {OrganizationStorageQuotaExceededError} When the upload would exceed the Organization quota (Req 11.9).
   */
  async ingest(input: IngestFileInput): Promise<IngestReport> {
    const type = detectFileType(input);
    if (type === null) {
      // A directly uploaded unsupported file is a hard rejection (Req 11.6),
      // unlike an unsupported archive *member*, which is skipped (Req 11.7).
      throw new UnsupportedFileFormatError(input.fileName, input.contentType);
    }

    const owned: OwnedFile = {
      raw: toRawFile(input),
      ownerId: input.ownerId,
      organizationId: input.organizationId,
    };
    const files = await this.process(owned, type, 0);
    return { files };
  }

  /**
   * Process a single owned file (or expand it, for an archive), returning the
   * outcome(s) it produced. Recurses for nested archives up to
   * {@link maxArchiveDepth} (Req 11.7).
   */
  private async process(
    owned: OwnedFile,
    type: DetectedFileType,
    depth: number,
  ): Promise<IngestOutcome[]> {
    // Malware scan first — a threat blocks everything downstream (Req 11.1).
    const scan = await this.scanner.scan(owned.raw);
    if (scan.status === 'threat') {
      // Record the rejection in the Audit_Service before surfacing it, so a
      // flagged file is always auditable (Req 11.2). The event is scoped to the
      // uploading user's Organization, consistent with how Access_Control and
      // the Tenancy_Service record actions.
      await this.audit.record(this.tenantContext(owned), {
        action: 'file.malware_rejected',
        resourceType: 'file',
        resourceId: owned.archivePath ?? owned.raw.fileName,
        actorId: owned.ownerId,
        metadata: {
          fileName: owned.raw.fileName,
          ...(owned.archivePath !== undefined ? { archivePath: owned.archivePath } : {}),
          ...(scan.detail !== undefined ? { detail: scan.detail } : {}),
        },
      });
      const rejected: RejectedFile = {
        status: 'rejected',
        reason: 'malware',
        fileName: owned.raw.fileName,
        ...(scan.detail !== undefined ? { detail: scan.detail } : {}),
        ...(owned.archivePath !== undefined ? { archivePath: owned.archivePath } : {}),
      };
      return [rejected];
    }

    if (isArchiveType(type)) {
      return this.processArchive(owned, depth);
    }

    const processed = await this.processFile(owned, type);
    return [processed];
  }

  /** Expand a ZIP archive and process each supported member (Req 11.7). */
  private async processArchive(owned: OwnedFile, depth: number): Promise<IngestOutcome[]> {
    const members = await this.expander.expand(owned.raw);
    if (members.length === 0) {
      // A directly uploaded empty archive is a hard error; an empty *nested*
      // archive simply contributes no member outcomes (Req 11.7).
      if (depth === 0) {
        throw new EmptyArchiveError(owned.raw.fileName);
      }
      return [];
    }
    const outcomes: IngestOutcome[] = [];

    for (const member of members) {
      const memberPath = joinPath(owned.archivePath, member.path);
      const memberType = detectFileType(member.file);

      if (memberType === null) {
        // Unsupported members are skipped, not fatal (Req 11.7).
        outcomes.push(skip('unsupported_format', member.file.fileName, memberPath));
        continue;
      }

      if (isArchiveType(memberType) && depth + 1 > this.maxArchiveDepth) {
        outcomes.push(skip('archive_too_deep', member.file.fileName, memberPath));
        continue;
      }

      const memberOwned: OwnedFile = {
        raw: member.file,
        ownerId: owned.ownerId,
        organizationId: owned.organizationId,
        archivePath: memberPath,
      };
      const nested = await this.process(memberOwned, memberType, depth + 1);
      outcomes.push(...nested);
    }

    return outcomes;
  }

  /**
   * Extract → (OCR) → chunk → embed → store → index a single supported,
   * clean, non-archive file (Req 11.3, 11.4, 11.5), after enforcing the
   * per-user and per-Organization storage quotas (Req 11.8, 11.9).
   */
  private async processFile(owned: OwnedFile, type: DetectedFileType): Promise<ProcessedFile> {
    // Enforce storage quotas before any durable write or wasted extraction /
    // embedding work, so a rejected upload leaves no chunks, embeddings, or
    // object entries behind (Req 11.8, 11.9).
    await this.enforceStorageQuota(owned);

    const { text, ocrApplied } = await this.extractText(owned.raw, type);
    const chunks = chunkText(text, this.chunkOptions);

    const fileId = this.newId();

    // Embed every chunk, enforcing exactly one embedding per chunk (Req 11.4,
    // Property 28). Empty text yields no chunks and no vectors.
    const vectorIds: string[] = [];
    const records: VectorRecord[] = [];
    if (chunks.length > 0) {
      const embeddings = await this.embedder.embed(chunks);
      if (embeddings.length !== chunks.length) {
        throw new EmbeddingCountError(chunks.length, embeddings.length);
      }
      for (let ordinal = 0; ordinal < chunks.length; ordinal += 1) {
        const id = `${fileId}:${ordinal}`;
        vectorIds.push(id);
        records.push({
          id,
          organizationId: owned.organizationId,
          ownerType: 'file_chunk',
          ownerId: fileId,
          embedding: embeddings[ordinal]!,
          metadata: {
            fileId,
            ordinal,
            text: chunks[ordinal]!,
            fileName: owned.raw.fileName,
            ...(owned.archivePath !== undefined ? { archivePath: owned.archivePath } : {}),
          },
        });
      }
    }

    // Persist the original bytes (Req 11.5). The object key is tenant-scoped.
    const contentType = type.mime ?? owned.raw.contentType ?? 'application/octet-stream';
    const objectKey = `files/${owned.organizationId}/${fileId}`;
    await this.objects.put(objectKey, owned.raw.bytes, { contentType });

    // Index the chunk embeddings (Req 11.5). Upsert after the object write so a
    // failed store never leaves orphaned vectors; the call is all-or-nothing.
    if (records.length > 0) {
      await this.vectors.upsert(records);
    }

    // Account the stored bytes against both the user and the Organization so
    // subsequent quota checks see the accumulated usage (Req 11.8, 11.9). Done
    // only after the durable writes succeed, so a failed upload never inflates
    // usage.
    await this.storageUsage.recordUsage(owned.organizationId, owned.ownerId, owned.raw.sizeBytes);

    const file: StoredFile = {
      id: fileId,
      ownerId: owned.ownerId,
      organizationId: owned.organizationId,
      name: owned.archivePath ?? owned.raw.fileName,
      contentType,
      sizeBytes: owned.raw.sizeBytes,
      objectKey,
      malwareScan: 'clean',
      category: type.category,
      createdAt: this.now(),
    };

    return {
      status: 'processed',
      file,
      chunkCount: chunks.length,
      vectorIds,
      ocrApplied,
      ...(owned.archivePath !== undefined ? { archivePath: owned.archivePath } : {}),
    };
  }

  /**
   * Reject the upload if storing its bytes would push the user past the fixed
   * per-user quota (Req 11.8) or the Organization past its configured quota
   * (Req 11.9).
   *
   * Both checks run before any durable write, so a rejected upload leaves no
   * chunks, embeddings, or object entries behind. The per-user quota is checked
   * first so a user over their own limit fails with the user-scoped error even
   * when the Organization still has headroom.
   *
   * @throws {StorageQuotaExceededError} When the user would exceed the per-user quota.
   * @throws {OrganizationStorageQuotaExceededError} When the Organization would exceed its quota.
   */
  private async enforceStorageQuota(owned: OwnedFile): Promise<void> {
    const additional = owned.raw.sizeBytes;

    const userUsage = await this.storageUsage.getUserUsage(owned.organizationId, owned.ownerId);
    if (userUsage + additional > this.userStorageQuotaBytes) {
      throw new StorageQuotaExceededError(
        owned.ownerId,
        userUsage,
        additional,
        this.userStorageQuotaBytes,
      );
    }

    const orgUsage = await this.storageUsage.getOrganizationUsage(owned.organizationId);
    const orgQuota = await this.storageUsage.getOrganizationQuotaBytes(owned.organizationId);
    if (orgUsage + additional > orgQuota) {
      throw new OrganizationStorageQuotaExceededError(
        owned.organizationId,
        orgUsage,
        additional,
        orgQuota,
      );
    }
  }

  /**
   * Build the {@link TenantContext} the {@link AuditRecorder} scopes an event
   * to: the owning Organization and the uploading user as the actor (Req 11.2).
   */
  private tenantContext(owned: OwnedFile): TenantContext {
    return { organizationId: owned.organizationId, userId: owned.ownerId };
  }

  /**
   * Extract text from a file, running OCR for an image or for a scanned page a
   * {@link TextExtractor} flags as needing it (Req 11.3, 11.4).
   */
  private async extractText(
    file: RawFile,
    type: DetectedFileType,
  ): Promise<{ text: string; ocrApplied: boolean }> {
    // Images go straight to OCR (Req 11.3).
    if (isImageType(type)) {
      const text = await this.ocr.recognize(file);
      return { text, ocrApplied: true };
    }

    const extracted = await this.extractor.extract(file, type);
    // A scanned page (no embedded text layer) is sent through OCR (Req 11.3).
    if (extracted.needsOcr === true) {
      const text = await this.ocr.recognize(file);
      return { text, ocrApplied: true };
    }
    return { text: extracted.text, ocrApplied: false };
  }
}

/** Project an {@link IngestFileInput} down to the {@link RawFile} the ports consume. */
function toRawFile(input: IngestFileInput): RawFile {
  return {
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    bytes: input.bytes,
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
  };
}

/** Build a `skipped` outcome (Req 11.7). */
function skip(
  reason: SkippedFile['reason'],
  fileName: string,
  archivePath: string,
): SkippedFile {
  return { status: 'skipped', reason, fileName, archivePath };
}

/** Join an optional parent archive path with a member path for provenance. */
function joinPath(parent: string | undefined, child: string): string {
  return parent !== undefined ? `${parent}/${child}` : child;
}
