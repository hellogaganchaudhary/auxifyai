/**
 * Artifact_Editor domain types (Req 12).
 *
 * The Artifact_Editor is the backend lifecycle service for the "Canvas and
 * Artifacts" feature: AI-generated long-form content (a document, a code file,
 * a diagram, …) is opened as an editable artifact, refined section by section,
 * versioned on every change with a retained history, exported as a downloadable
 * file plus a copy-to-clipboard string, and shared with team members.
 *
 * These are the camelCase domain shapes the service returns to its callers,
 * distinct from the snake_case persistence rows handled by the repository layer
 * (migration 0004 `artifacts` / `artifact_versions`). The service composes the
 * narrow {@link ArtifactStore} port (satisfied structurally by
 * `ArtifactRepository`) so it stays unit-testable behind a seam.
 *
 * Tenancy: `artifacts` carry no `organization_id` column — they are tenant
 * scoped *through their parent conversation* (exactly like `messages`), and
 * `artifact_versions` are scoped through their parent artifact. Every store
 * method therefore requires a {@link TenantContext} and confines the operation
 * to the caller's Organization (Req 1.2, 1.4).
 */

import type { TenantContext } from '@auxify/types';

/**
 * The artifact kinds the editor supports (Req 12.2).
 *
 * Mirrors the `artifacts.type` CHECK constraint (migration 0004): code files,
 * Markdown documents, Mermaid diagrams, React components, SVG graphics, CSV
 * tables, and HTML pages.
 */
export type ArtifactType = 'code' | 'markdown' | 'mermaid' | 'react' | 'svg' | 'csv' | 'html';

/** All {@link ArtifactType} values, for validation and test generators. */
export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  'code',
  'markdown',
  'mermaid',
  'react',
  'svg',
  'csv',
  'html',
] as const;

/** Narrow runtime guard that a value is a supported {@link ArtifactType} (Req 12.2). */
export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/**
 * The editable content opened into the Artifact_Editor side panel (Req 12.1).
 *
 * Produced from a model response designated as an artifact (the Output_Renderer
 * emits an artifact render descriptor; this is the body the editor persists and
 * opens). The owning `conversationId` carries the tenant scope through the
 * parent conversation.
 */
export interface ArtifactContent {
  /** The conversation the artifact belongs to (its tenant scope). */
  conversationId: string;
  /** The artifact kind (Req 12.2). */
  type: ArtifactType;
  /** The artifact body to open for editing. */
  content: string;
}

/**
 * A persisted artifact in its domain shape (Req 12).
 *
 * `version` is the current head version; every content edit bumps it and
 * appends a retained {@link ArtifactVersion} (Req 12.4). `sharedWith` is the
 * list of team-member ids the artifact has been shared with (Req 12.6).
 */
export interface Artifact {
  id: string;
  conversationId: string;
  type: ArtifactType;
  content: string;
  /** The current head version number (starts at 1, bumped on every edit). */
  version: number;
  /** The team members the artifact is shared with (Req 12.6). */
  sharedWith: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A single retained version of an artifact's content (Req 12.4).
 *
 * Every edit appends one of these; prior versions are never mutated or removed,
 * so the full history is always retrievable (Property 25, task 9.6).
 */
export interface ArtifactVersion {
  /** The version row's id. */
  id: string;
  /** The artifact this version belongs to. */
  artifactId: string;
  /** The version number (1, 2, 3, …). */
  version: number;
  /** The artifact content captured at this version. */
  content: string;
  /** When this version was created. */
  createdAt: string;
}

/**
 * The result of opening an artifact into the editor side panel (Req 12.1).
 *
 * Carries the opened artifact and the client surface it routes into (always the
 * `artifact_editor` panel, matching the Output_Renderer's artifact descriptor).
 */
export interface ArtifactSession {
  /** The opened artifact. */
  artifact: Artifact;
  /** The client surface the artifact is opened into. */
  target: 'artifact_editor';
}

/**
 * A reference to the section of an artifact a modification targets (Req 12.3).
 *
 * A discriminated union on `kind` so a section can be addressed by a 1-indexed
 * inclusive line span, by a Markdown heading, or by the first literal
 * occurrence of a target string. The deterministic {@link SectionEditor}
 * resolves each kind to a concrete span and replaces it with the new section
 * content; an AI-driven editor can be injected behind the same port.
 */
export type SectionRef =
  | { kind: 'lines'; start: number; end: number }
  | { kind: 'heading'; heading: string }
  | { kind: 'replace'; target: string };

/**
 * Produces the new content for a section edit (Req 12.3).
 *
 * This is the injectable seam between the editor's lifecycle/versioning logic
 * and *how* a section's new content is computed. The default implementation
 * ({@link DeterministicSectionEditor}) performs a deterministic section
 * replacement — it treats `instruction` as the replacement text for the
 * resolved section — so the behavior is fully testable without a model. A
 * production deployment can inject an AI-backed editor that interprets
 * `instruction` as a natural-language change request and returns the rewritten
 * section/content, without changing the editor or its versioning.
 */
export interface SectionEditor {
  /**
   * Compute the artifact's new full content after applying `instruction` to the
   * section identified by `section`.
   *
   * @returns The new full artifact content.
   */
  edit(input: {
    content: string;
    type: ArtifactType;
    section: SectionRef;
    instruction: string;
  }): string;
}

/**
 * A downloadable file reference produced by an export (Req 12.5).
 *
 * The platform's `DownloadRef`: a suggested filename, the MIME content type,
 * the file body, and the text encoding. The body is held inline (UTF-8 text for
 * every supported artifact type) so the export is deterministic and testable;
 * a transport layer can stream or sign it without changing this shape.
 */
export interface DownloadRef {
  /** A suggested download filename including the type-appropriate extension. */
  filename: string;
  /** The MIME content type for the artifact type. */
  contentType: string;
  /** The exported file body. */
  content: string;
  /** The body encoding (always `utf-8` for the supported text artifact types). */
  encoding: 'utf-8';
}

/**
 * The result of exporting an artifact (Req 12.5): a downloadable file plus a
 * copy-to-clipboard string. `clipboard` is the exact artifact content a
 * copy-to-clipboard control places on the clipboard.
 */
export interface ArtifactExport {
  /** The downloadable file representation. */
  file: DownloadRef;
  /** The copy-to-clipboard string (the artifact content). */
  clipboard: string;
}

/** Fields a caller supplies to create an artifact version row. */
export interface CreateArtifactVersionInput {
  id: string;
  artifactId: string;
  version: number;
  content: string;
}

/**
 * The persistence port the Artifact_Editor composes (Req 12).
 *
 * `ArtifactRepository` satisfies this structurally; tests substitute an
 * in-memory fake ({@link InMemoryArtifactStore}). Every method requires a
 * {@link TenantContext} so an operation can never escape the caller's
 * Organization. The store owns the *version-on-every-write* invariant
 * (Req 12.4): `create` persists the artifact head **and** its version-1 row,
 * and `updateContent` appends the next version row **and** advances the head —
 * so callers cannot write content without retaining a version.
 */
export interface ArtifactStore {
  /**
   * Create an artifact (head at version 1) under a conversation in the caller's
   * Organization, and append its version-1 history row.
   */
  create(
    ctx: TenantContext,
    input: {
      id: string;
      versionId: string;
      conversationId: string;
      type: ArtifactType;
      content: string;
    },
  ): Promise<Artifact>;
  /** Fetch an artifact by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<Artifact | null>;
  /** List a conversation's artifacts within the caller's Organization. */
  listByConversation(ctx: TenantContext, conversationId: string): Promise<Artifact[]>;
  /**
   * Replace an artifact's content: append the next version-history row and
   * advance the head version (Req 12.4). Returns the updated artifact, or
   * `null` if no artifact matched within the caller's Organization.
   */
  updateContent(
    ctx: TenantContext,
    id: string,
    input: { versionId: string; content: string },
  ): Promise<Artifact | null>;
  /**
   * Replace an artifact's shared-with member list (Req 12.6). Returns the
   * updated artifact, or `null` if no artifact matched.
   */
  updateSharedWith(ctx: TenantContext, id: string, members: string[]): Promise<Artifact | null>;
  /** List every retained version of an artifact, oldest first (Req 12.4). */
  listVersions(ctx: TenantContext, id: string): Promise<ArtifactVersion[]>;
  /** Fetch a single retained version of an artifact, or `null`. */
  getVersion(ctx: TenantContext, id: string, version: number): Promise<ArtifactVersion | null>;
}

/** Generates unique ids for artifacts and version rows (injectable for tests). */
export interface ArtifactIdGenerator {
  /** A unique artifact id. */
  artifactId(): string;
  /** A unique artifact-version row id. */
  versionId(): string;
}
