/**
 * Artifact_Editor (Req 12): the backend lifecycle service for the "Canvas and
 * Artifacts" feature.
 *
 * AI-generated long-form content is opened as an editable artifact, refined a
 * section at a time, versioned on *every* change with a fully-retained history,
 * exported as a downloadable file plus a copy-to-clipboard string, and shared
 * with team members. The service composes the tenant-scoped
 * {@link ArtifactRepository} (artifacts are scoped through their parent
 * conversation, so every operation is confined to the caller's Organization,
 * Req 1.2, 1.4), a {@link SectionEditor} port (the model-free
 * {@link DeterministicSectionEditor} by default), and the
 * {@link import('../audit/index.js').AuditRecorder} port (every mutation is
 * audited, Req 37.1).
 *
 * Surface:
 *   - {@link ArtifactEditor} — the service; one method per acceptance criterion
 *     (open/applySectionEdit/listVersions/getVersion/export/share, Req 12.1-12.6).
 *   - {@link ArtifactRepository} — the tenant-scoped repository over
 *     `artifacts` + `artifact_versions` (migration 0004), owning the
 *     version-on-every-write invariant (Req 12.4).
 *   - {@link ArtifactStore} — the narrow persistence port the editor composes
 *     (satisfied structurally by the repository).
 *   - {@link DeterministicSectionEditor} / {@link applySectionReplacement} /
 *     {@link resolveSectionSpan} — the pure, model-free section-edit core (Req 12.3).
 *   - {@link exportArtifact} — the pure file + clipboard serializer (Req 12.5).
 *   - Domain types ({@link Artifact}, {@link ArtifactVersion},
 *     {@link ArtifactContent}, {@link ArtifactSession}, {@link SectionRef},
 *     {@link ArtifactExport}, {@link DownloadRef}, …) and the typed errors
 *     ({@link ArtifactNotFoundError}, {@link UnknownArtifactTypeError},
 *     {@link SectionNotFoundError}).
 *
 * The in-memory test fakes (an artifact store, a capturing audit recorder, and
 * the builders) live in `./fakes.js` and are intentionally NOT re-exported from
 * this barrel — they would collide with the equally-named audit-recorder fakes
 * of sibling modules at the package barrel. Following the established
 * convention (prompts/conversations), the unit tests here and the companion
 * versioned-edits property test (task 9.6) import them directly from
 * `./fakes.js`.
 */

export { ArtifactEditor, type ArtifactEditorOptions } from './artifact-editor.js';

export { ArtifactRepository } from './artifact-repository.js';

export {
  DeterministicSectionEditor,
  applySectionReplacement,
  resolveSectionSpan,
  describeSection,
} from './section-edit.js';

export { exportArtifact, contentTypeFor, extensionFor } from './export.js';

export {
  ArtifactNotFoundError,
  UnknownArtifactTypeError,
  SectionNotFoundError,
  ARTIFACT_NOT_FOUND_CODE,
  UNKNOWN_ARTIFACT_TYPE_CODE,
  SECTION_NOT_FOUND_CODE,
} from './errors.js';

export {
  ARTIFACT_TYPES,
  isArtifactType,
  type Artifact,
  type ArtifactContent,
  type ArtifactExport,
  type ArtifactIdGenerator,
  type ArtifactSession,
  type ArtifactStore,
  type ArtifactType,
  type ArtifactVersion,
  type CreateArtifactVersionInput,
  type DownloadRef,
  type SectionEditor,
  type SectionRef,
} from './types.js';

// NOTE: the in-memory test fakes (InMemoryArtifactStore, CapturingAuditRecorder,
// makeArtifact, sequentialArtifactIdGenerator, CapturedAudit) are intentionally
// NOT re-exported from the package barrel — they would collide with the
// equally-named audit-recorder fakes of sibling modules (prompts/conversations).
// Following the established convention, the unit tests here and the companion
// versioned-edits property test (task 9.6) import them directly from
// `./artifacts/fakes.js`.
