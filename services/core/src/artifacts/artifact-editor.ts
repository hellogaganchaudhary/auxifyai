/**
 * The Artifact_Editor (Req 12).
 *
 * The backend lifecycle service for the "Canvas and Artifacts" feature. AI-
 * generated long-form content is opened as an editable artifact, refined a
 * section at a time, versioned on every change with a fully-retained history,
 * exported as a downloadable file plus a copy-to-clipboard string, and shared
 * with team members. It composes injected ports so it is unit-testable without
 * a database:
 *
 *   - an {@link ArtifactStore} (satisfied by `ArtifactRepository`) — already
 *     tenant-scoped through the parent conversation, so every operation is
 *     confined to the caller's Organization (Req 1.2, 1.4) and owns the
 *     version-on-every-write invariant (Req 12.4);
 *   - a {@link SectionEditor} port — computes a section's new content; the
 *     default {@link DeterministicSectionEditor} performs a model-free splice
 *     (an AI-backed editor can be injected without touching this service);
 *   - an {@link AuditRecorder} — so every mutation (open/create, edit, share)
 *     is recorded in the immutable audit trail (Req 37.1).
 *
 * Responsibilities mapped to acceptance criteria:
 *   - {@link open} — opens editable artifact content into the side panel,
 *     supporting all seven artifact types (Req 12.1, 12.2), audited.
 *   - {@link applySectionEdit} — applies a change to the targeted section only
 *     and persists a new version (Req 12.3, 12.4), audited.
 *   - {@link listVersions} / {@link getVersion} — expose the retained history
 *     (Req 12.4; reused by Property 25, task 9.6).
 *   - {@link export} — produces a downloadable file plus a copy-to-clipboard
 *     string (Req 12.5).
 *   - {@link share} — records the artifact as accessible to the designated team
 *     members (Req 12.6), audited.
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';
import { exportArtifact } from './export.js';
import { ArtifactNotFoundError, SectionNotFoundError, UnknownArtifactTypeError } from './errors.js';
import { DeterministicSectionEditor, describeSection } from './section-edit.js';
import {
  isArtifactType,
  type Artifact,
  type ArtifactContent,
  type ArtifactExport,
  type ArtifactIdGenerator,
  type ArtifactSession,
  type ArtifactStore,
  type ArtifactVersion,
  type SectionEditor,
  type SectionRef,
} from './types.js';

/** Default id generator backed by `crypto.randomUUID`. */
const defaultIdGenerator: ArtifactIdGenerator = {
  artifactId: () => randomUUID(),
  versionId: () => randomUUID(),
};

/** Construction dependencies for the {@link ArtifactEditor}. */
export interface ArtifactEditorOptions {
  /** The artifacts store (tenant-scoped `ArtifactRepository`). */
  artifacts: ArtifactStore;
  /** The append-only audit sink; every mutation is recorded through it (Req 37.1). */
  audit: AuditRecorder;
  /**
   * The section editor port computing a section's new content (Req 12.3).
   * Defaults to the model-free {@link DeterministicSectionEditor}.
   */
  sectionEditor?: SectionEditor;
  /** Optional id generator (defaults to `crypto.randomUUID`). */
  idGenerator?: ArtifactIdGenerator;
}

/**
 * The Artifact_Editor. Construct once with its ports, then call its lifecycle
 * methods with the acting user's {@link TenantContext}.
 */
export class ArtifactEditor {
  private readonly artifacts: ArtifactStore;
  private readonly audit: AuditRecorder;
  private readonly sectionEditor: SectionEditor;
  private readonly ids: ArtifactIdGenerator;

  constructor(options: ArtifactEditorOptions) {
    this.artifacts = options.artifacts;
    this.audit = options.audit;
    this.sectionEditor = options.sectionEditor ?? new DeterministicSectionEditor();
    this.ids = options.idGenerator ?? defaultIdGenerator;
  }

  /**
   * Open editable artifact content into the editor side panel (Req 12.1).
   *
   * Persists the content as a new artifact (head at version 1, with its version-1
   * history row) under its conversation in the caller's Organization, and returns
   * an {@link ArtifactSession} routed to the `artifact_editor` panel. Supports all
   * seven artifact types (code/markdown/mermaid/react/svg/csv/html — Req 12.2);
   * an unsupported type raises {@link UnknownArtifactTypeError}. The creation is
   * recorded in the Audit_Service.
   */
  async open(ctx: TenantContext, content: ArtifactContent): Promise<ArtifactSession> {
    if (!isArtifactType(content.type)) {
      throw new UnknownArtifactTypeError(String(content.type));
    }
    const id = this.ids.artifactId();
    const artifact = await this.artifacts.create(ctx, {
      id,
      versionId: this.ids.versionId(),
      conversationId: content.conversationId,
      type: content.type,
      content: content.content,
    });
    await this.audit.record(ctx, {
      action: 'artifact.open',
      resourceType: 'artifact',
      resourceId: artifact.id,
      metadata: { conversationId: artifact.conversationId, type: artifact.type },
    });
    return { artifact, target: 'artifact_editor' };
  }

  /** Fetch an artifact by id within the caller's Organization, or `null`. */
  async get(ctx: TenantContext, id: string): Promise<Artifact | null> {
    return this.artifacts.findById(ctx, id);
  }

  /** List a conversation's artifacts within the caller's Organization. */
  async listByConversation(ctx: TenantContext, conversationId: string): Promise<Artifact[]> {
    return this.artifacts.listByConversation(ctx, conversationId);
  }

  /**
   * Apply a modification to a specific section of an artifact (Req 12.3) and
   * create a new version retaining the prior content (Req 12.4).
   *
   * The {@link SectionEditor} port computes the new full content from the
   * targeted section and the instruction; the store then appends the next
   * version-history row and advances the head. Raises
   * {@link ArtifactNotFoundError} when no artifact matches within the caller's
   * Organization, and {@link import('./errors.js').SectionNotFoundError} when
   * the section reference cannot be resolved. The edit is recorded in the
   * Audit_Service.
   */
  async applySectionEdit(
    ctx: TenantContext,
    id: string,
    section: SectionRef,
    instruction: string,
  ): Promise<Artifact> {
    const current = await this.artifacts.findById(ctx, id);
    if (current === null) {
      throw new ArtifactNotFoundError(id);
    }
    const newContent = this.applyEdit(id, current, section, instruction);
    const updated = await this.artifacts.updateContent(ctx, id, {
      versionId: this.ids.versionId(),
      content: newContent,
    });
    if (updated === null) {
      // The artifact existed a moment ago; a null here means it left the tenant
      // scope concurrently. Fail closed with not-found.
      throw new ArtifactNotFoundError(id);
    }
    await this.audit.record(ctx, {
      action: 'artifact.edit',
      resourceType: 'artifact',
      resourceId: id,
      metadata: { section: section.kind, version: updated.version },
    });
    return updated;
  }

  /**
   * Resolve the section edit through the port, surfacing section-resolution
   * errors with the artifact's real id.
   */
  private applyEdit(
    id: string,
    current: Artifact,
    section: SectionRef,
    instruction: string,
  ): string {
    try {
      return this.sectionEditor.edit({
        content: current.content,
        type: current.type,
        section,
        instruction,
      });
    } catch (error) {
      // Re-tag a deterministic-editor SectionNotFoundError with the real id.
      if (error instanceof SectionNotFoundError) {
        throw new SectionNotFoundError(id, describeSection(section));
      }
      throw error;
    }
  }

  /**
   * List every retained version of an artifact, oldest first (Req 12.4).
   *
   * This is the clean version-listing surface the versioned-edits property test
   * (Property 25, task 9.6) builds on: every edit appends a version and no prior
   * version is ever removed.
   */
  async listVersions(ctx: TenantContext, id: string): Promise<ArtifactVersion[]> {
    return this.artifacts.listVersions(ctx, id);
  }

  /** Fetch a single retained version of an artifact, or `null` (Req 12.4). */
  async getVersion(
    ctx: TenantContext,
    id: string,
    version: number,
  ): Promise<ArtifactVersion | null> {
    return this.artifacts.getVersion(ctx, id, version);
  }

  /**
   * Export an artifact as a downloadable file plus a copy-to-clipboard string
   * (Req 12.5). Raises {@link ArtifactNotFoundError} when no artifact matches
   * within the caller's Organization. Export is a read; it is not audited.
   */
  async export(ctx: TenantContext, id: string): Promise<ArtifactExport> {
    const artifact = await this.artifacts.findById(ctx, id);
    if (artifact === null) {
      throw new ArtifactNotFoundError(id);
    }
    return exportArtifact(artifact);
  }

  /**
   * Share an artifact with the designated team members, making it accessible to
   * them (Req 12.6).
   *
   * The members are merged into the artifact's shared-with list (de-duplicated,
   * order-preserving) so repeated shares are additive and idempotent. Raises
   * {@link ArtifactNotFoundError} when no artifact matches within the caller's
   * Organization. The share is recorded in the Audit_Service.
   */
  async share(ctx: TenantContext, id: string, members: string[]): Promise<Artifact> {
    const current = await this.artifacts.findById(ctx, id);
    if (current === null) {
      throw new ArtifactNotFoundError(id);
    }
    const merged = mergeUnique(current.sharedWith, members);
    const updated = await this.artifacts.updateSharedWith(ctx, id, merged);
    if (updated === null) {
      throw new ArtifactNotFoundError(id);
    }
    await this.audit.record(ctx, {
      action: 'artifact.share',
      resourceType: 'artifact',
      resourceId: id,
      metadata: { members },
    });
    return updated;
  }
}

/** Merge `additions` into `base`, preserving order and dropping duplicates/empties. */
function mergeUnique(base: string[], additions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const member of [...base, ...additions]) {
    if (member.length === 0 || seen.has(member)) continue;
    seen.add(member);
    result.push(member);
  }
  return result;
}
