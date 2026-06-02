/**
 * Artifact_Editor domain errors (Req 12).
 *
 * These make the editor's not-found, validation, and section-resolution
 * conditions explicit and testable. Tenant scoping already prevents
 * cross-tenant reads, so "not in my tenant" surfaces as
 * {@link ArtifactNotFoundError}; {@link UnknownArtifactTypeError} guards the
 * supported-type set (Req 12.2); and {@link SectionNotFoundError} guards the
 * section reference a modification targets (Req 12.3). Each projects into the
 * platform-wide serializable {@link PlatformError} (Req 46.8).
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** Stable machine-readable code for a missing artifact. */
export const ARTIFACT_NOT_FOUND_CODE = 'ARTIFACT_NOT_FOUND' as const;

/** Stable machine-readable code for an unsupported artifact type. */
export const UNKNOWN_ARTIFACT_TYPE_CODE = 'UNKNOWN_ARTIFACT_TYPE' as const;

/** Stable machine-readable code for a section that cannot be located. */
export const SECTION_NOT_FOUND_CODE = 'ARTIFACT_SECTION_NOT_FOUND' as const;

/**
 * Thrown when an artifact referenced by an operation does not exist within the
 * caller's Organization.
 */
export class ArtifactNotFoundError extends Error {
  /** The artifact id that was looked up. */
  readonly artifactId: string;

  constructor(artifactId: string) {
    super(`Artifact "${artifactId}" was not found in the current organization`);
    this.name = 'ArtifactNotFoundError';
    this.artifactId = artifactId;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'not_found',
      code: ARTIFACT_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { artifactId: this.artifactId },
    });
  }
}

/**
 * Thrown when an artifact is opened with a type outside the supported set
 * (`code`/`markdown`/`mermaid`/`react`/`svg`/`csv`/`html`, Req 12.2).
 */
export class UnknownArtifactTypeError extends Error {
  /** The unsupported type that was requested. */
  readonly type: string;

  constructor(type: string) {
    super(
      `Unsupported artifact type "${type}"; expected one of code, markdown, mermaid, react, svg, csv, html`,
    );
    this.name = 'UnknownArtifactTypeError';
    this.type = type;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: UNKNOWN_ARTIFACT_TYPE_CODE,
      message: this.message,
      correlationId,
      details: { type: this.type },
    });
  }
}

/**
 * Thrown when a section reference in {@link applySectionEdit} cannot be resolved
 * against the artifact's content — an out-of-range line span, a heading that is
 * not present, or a replace target that does not occur (Req 12.3).
 */
export class SectionNotFoundError extends Error {
  /** The artifact whose section could not be located. */
  readonly artifactId: string;
  /** A human-readable description of the unresolved section reference. */
  readonly section: string;

  constructor(artifactId: string, section: string) {
    super(`Section ${section} was not found in artifact "${artifactId}"`);
    this.name = 'SectionNotFoundError';
    this.artifactId = artifactId;
    this.section = section;
  }

  /** Project into the platform-wide serializable error shape (Req 46.8). */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: SECTION_NOT_FOUND_CODE,
      message: this.message,
      correlationId,
      details: { artifactId: this.artifactId, section: this.section },
    });
  }
}
