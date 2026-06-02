/**
 * Unit tests for the deterministic section-edit core (Req 12.3).
 *
 * The Artifact_Editor applies a modification to a specific section of an
 * artifact and leaves the rest intact. These cover the three ways to address a
 * section ({@link SectionRef}) and the fail-closed behaviour for unresolved
 * references:
 *   - line spans (1-indexed, inclusive) splice only the targeted lines;
 *   - Markdown headings cover the heading up to the next same-or-higher-level
 *     heading;
 *   - a literal replace-target swaps the first occurrence;
 *   - an out-of-range span / absent heading / missing target raises
 *     SectionNotFoundError rather than corrupting the content.
 */

import { describe, expect, it } from 'vitest';

import { SectionNotFoundError } from './errors.js';
import {
  DeterministicSectionEditor,
  applySectionReplacement,
  describeSection,
  resolveSectionSpan,
} from './section-edit.js';
import type { SectionRef } from './types.js';

const ID = 'art-1';

describe('applySectionReplacement — line spans', () => {
  it('replaces a single 1-indexed line, preserving the others', () => {
    expect(applySectionReplacement(ID, 'a\nb\nc', { kind: 'lines', start: 2, end: 2 }, 'B')).toBe(
      'a\nB\nc',
    );
  });

  it('replaces a multi-line inclusive span', () => {
    expect(
      applySectionReplacement(ID, 'a\nb\nc\nd', { kind: 'lines', start: 2, end: 3 }, 'X'),
    ).toBe('a\nX\nd');
  });

  it('replaces the first line', () => {
    expect(applySectionReplacement(ID, 'a\nb', { kind: 'lines', start: 1, end: 1 }, 'A')).toBe(
      'A\nb',
    );
  });

  it('replaces the last line (no trailing newline)', () => {
    expect(applySectionReplacement(ID, 'a\nb\nc', { kind: 'lines', start: 3, end: 3 }, 'C')).toBe(
      'a\nb\nC',
    );
  });

  it('handles single-line content', () => {
    expect(applySectionReplacement(ID, 'only', { kind: 'lines', start: 1, end: 1 }, 'new')).toBe(
      'new',
    );
  });

  it('raises for an out-of-range span', () => {
    expect(() =>
      applySectionReplacement(ID, 'a\nb', { kind: 'lines', start: 3, end: 3 }, 'x'),
    ).toThrow(SectionNotFoundError);
  });

  it('raises for an inverted or non-positive span', () => {
    expect(() =>
      applySectionReplacement(ID, 'a\nb', { kind: 'lines', start: 2, end: 1 }, 'x'),
    ).toThrow(SectionNotFoundError);
    expect(() =>
      applySectionReplacement(ID, 'a\nb', { kind: 'lines', start: 0, end: 1 }, 'x'),
    ).toThrow(SectionNotFoundError);
  });
});

describe('applySectionReplacement — Markdown headings', () => {
  const doc = '# A\nintro\n\n## B\nbody b\n\n## C\nbody c\n';

  it('replaces a subsection up to the next same-level heading', () => {
    const out = applySectionReplacement(ID, doc, { kind: 'heading', heading: 'B' }, '## B\nNEW\n');
    expect(out).toContain('## B\nNEW');
    expect(out).not.toContain('body b');
    // Sibling section C and the intro are untouched.
    expect(out).toContain('## C\nbody c');
    expect(out).toContain('# A\nintro');
  });

  it('a top-level heading covers its nested subsections', () => {
    const out = applySectionReplacement(ID, doc, { kind: 'heading', heading: 'A' }, '# A\nONLY\n');
    expect(out).toBe('# A\nONLY\n');
  });

  it('the final section runs to end-of-content', () => {
    const out = applySectionReplacement(ID, doc, { kind: 'heading', heading: 'C' }, '## C\nZ');
    expect(out).toBe('# A\nintro\n\n## B\nbody b\n\n## C\nZ');
  });

  it('raises for an absent heading', () => {
    expect(() =>
      applySectionReplacement(ID, doc, { kind: 'heading', heading: 'Missing' }, 'x'),
    ).toThrow(SectionNotFoundError);
  });
});

describe('applySectionReplacement — literal replace target', () => {
  it('replaces the first occurrence only', () => {
    expect(
      applySectionReplacement(ID, 'foo bar foo', { kind: 'replace', target: 'foo' }, 'X'),
    ).toBe('X bar foo');
  });

  it('raises for a missing target', () => {
    expect(() =>
      applySectionReplacement(ID, 'abc', { kind: 'replace', target: 'zzz' }, 'x'),
    ).toThrow(SectionNotFoundError);
  });

  it('raises for an empty target', () => {
    expect(() => applySectionReplacement(ID, 'abc', { kind: 'replace', target: '' }, 'x')).toThrow(
      SectionNotFoundError,
    );
  });
});

describe('resolveSectionSpan', () => {
  it('returns null instead of throwing for an unresolved reference', () => {
    expect(resolveSectionSpan('a', { kind: 'replace', target: 'z' })).toBeNull();
  });

  it('resolves a heading span to character offsets', () => {
    // The heading "H" runs to end-of-content (no following heading): the full
    // string '# H\nbody' is 8 characters.
    const span = resolveSectionSpan('# H\nbody', { kind: 'heading', heading: 'H' });
    expect(span).toEqual({ start: 0, end: 8 });
  });

  it('ends a heading span before the next same-level heading', () => {
    // '## A\nx\n## B' — section A is '## A\nx' (offsets 0..6, excluding the
    // newline before '## B').
    const span = resolveSectionSpan('## A\nx\n## B', { kind: 'heading', heading: 'A' });
    expect(span).toEqual({ start: 0, end: 6 });
  });
});

describe('describeSection', () => {
  it.each<[SectionRef, string]>([
    [{ kind: 'lines', start: 2, end: 4 }, 'lines 2-4'],
    [{ kind: 'heading', heading: 'Intro' }, 'heading "Intro"'],
    [{ kind: 'replace', target: 'foo' }, 'target "foo"'],
  ])('describes %j as %s', (section, expected) => {
    expect(describeSection(section)).toBe(expected);
  });
});

describe('DeterministicSectionEditor', () => {
  it('treats the instruction as the replacement text for the resolved section', () => {
    const editor = new DeterministicSectionEditor();
    const out = editor.edit({
      content: 'a\nb\nc',
      type: 'markdown',
      section: { kind: 'lines', start: 2, end: 2 },
      instruction: 'B',
    });
    expect(out).toBe('a\nB\nc');
  });

  it('raises SectionNotFoundError for an unresolved section', () => {
    const editor = new DeterministicSectionEditor();
    expect(() =>
      editor.edit({
        content: 'a',
        type: 'markdown',
        section: { kind: 'replace', target: 'missing' },
        instruction: 'x',
      }),
    ).toThrow(SectionNotFoundError);
  });
});
