/**
 * Deterministic section editing for the Artifact_Editor (Req 12.3).
 *
 * When a user requests a modification to a specific section of an artifact, the
 * editor applies the change to *that section only* and leaves the rest intact.
 * Computing the new section content is the one place an AI model could be
 * involved, so it lives behind the injectable {@link SectionEditor} port
 * (declared in `./types`). This module provides the default, model-free
 * implementation used in tests and as a safe fallback:
 * {@link DeterministicSectionEditor} treats the `instruction` as the
 * replacement text for the resolved section and splices it into the content.
 *
 * Three ways to address a section are supported ({@link SectionRef}):
 *   - `lines` — a 1-indexed inclusive line span;
 *   - `heading` — a Markdown ATX heading (`#`…`######`); the section runs from
 *     the heading line up to (but not including) the next heading of the same
 *     or higher level, or end-of-content;
 *   - `replace` — the first literal occurrence of a target string.
 *
 * An unresolved reference (out-of-range span, absent heading, missing target)
 * raises {@link SectionNotFoundError} so the edit fails closed rather than
 * silently corrupting the artifact.
 */

import { SectionNotFoundError } from './errors.js';
import type { ArtifactType, SectionEditor, SectionRef } from './types.js';

/** A resolved, 0-indexed character span `[start, end)` within the content. */
interface CharSpan {
  start: number;
  end: number;
}

/** Render a {@link SectionRef} as a short human-readable description for errors. */
export function describeSection(section: SectionRef): string {
  switch (section.kind) {
    case 'lines':
      return `lines ${section.start}-${section.end}`;
    case 'heading':
      return `heading "${section.heading}"`;
    case 'replace':
      return `target "${section.target}"`;
  }
}

/** The 0-indexed character offset at which each line starts, plus content end. */
function lineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** Resolve a 1-indexed inclusive line span to a character span. */
function resolveLineSpan(content: string, start: number, end: number): CharSpan | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return null;
  }
  const offsets = lineOffsets(content);
  const lineCount = offsets.length;
  if (start > lineCount || end > lineCount) return null;
  const spanStart = offsets[start - 1]!;
  // End offset is the start of the line *after* `end`, or end-of-content for the
  // last line. We exclude the trailing newline so the line break is preserved.
  const afterEnd = end < lineCount ? offsets[end]! - 1 : content.length;
  return { start: spanStart, end: afterEnd };
}

/** The ATX heading level (`#` count) of a line, or 0 if it is not a heading. */
function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+/.exec(line);
  return match === null ? 0 : match[1]!.length;
}

/**
 * Resolve a Markdown heading to the character span covering its section: from
 * the heading line to just before the next heading of the same or higher level
 * (or end-of-content).
 */
function resolveHeadingSpan(content: string, heading: string): CharSpan | null {
  const target = heading.trim();
  const lines = content.split('\n');
  const offsets = lineOffsets(content);

  let headingLineIndex = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lvl = headingLevel(line);
    if (lvl > 0) {
      const text = line.replace(/^#{1,6}\s+/, '').trim();
      if (text === target) {
        headingLineIndex = i;
        level = lvl;
        break;
      }
    }
  }
  if (headingLineIndex === -1) return null;

  let endLineIndex = lines.length; // exclusive line index where the section ends
  for (let i = headingLineIndex + 1; i < lines.length; i += 1) {
    const lvl = headingLevel(lines[i]!);
    if (lvl > 0 && lvl <= level) {
      endLineIndex = i;
      break;
    }
  }

  const start = offsets[headingLineIndex]!;
  // End at the start of the next-section line, minus its preceding newline, or
  // end-of-content when the section runs to the end.
  const end = endLineIndex < lines.length ? offsets[endLineIndex]! - 1 : content.length;
  return { start, end };
}

/** Resolve the first literal occurrence of a target string to a character span. */
function resolveReplaceSpan(content: string, target: string): CharSpan | null {
  if (target.length === 0) return null;
  const index = content.indexOf(target);
  if (index === -1) return null;
  return { start: index, end: index + target.length };
}

/**
 * Resolve a {@link SectionRef} against `content` to a character span, or `null`
 * when it cannot be located.
 */
export function resolveSectionSpan(content: string, section: SectionRef): CharSpan | null {
  switch (section.kind) {
    case 'lines':
      return resolveLineSpan(content, section.start, section.end);
    case 'heading':
      return resolveHeadingSpan(content, section.heading);
    case 'replace':
      return resolveReplaceSpan(content, section.target);
  }
}

/**
 * Apply a deterministic section replacement: splice `replacement` into the
 * resolved span of `content`, leaving every other character untouched.
 *
 * @throws SectionNotFoundError if `section` cannot be resolved against `content`.
 */
export function applySectionReplacement(
  artifactId: string,
  content: string,
  section: SectionRef,
  replacement: string,
): string {
  const span = resolveSectionSpan(content, section);
  if (span === null) {
    throw new SectionNotFoundError(artifactId, describeSection(section));
  }
  return content.slice(0, span.start) + replacement + content.slice(span.end);
}

/**
 * The default, model-free {@link SectionEditor}.
 *
 * It treats the edit `instruction` as the literal replacement text for the
 * resolved section, so an edit is a deterministic, fully-testable splice. A
 * production deployment can inject an AI-backed editor that interprets the
 * instruction as a natural-language change and returns rewritten content,
 * without touching the editor's lifecycle or versioning.
 */
export class DeterministicSectionEditor implements SectionEditor {
  edit(input: {
    content: string;
    type: ArtifactType;
    section: SectionRef;
    instruction: string;
  }): string {
    // The artifact id is not needed to compute the new content; the service
    // passes its own id through when it calls the port, and resolution errors
    // are raised with the real id there. Use a stable placeholder here.
    return applySectionReplacement('<artifact>', input.content, input.section, input.instruction);
  }
}
