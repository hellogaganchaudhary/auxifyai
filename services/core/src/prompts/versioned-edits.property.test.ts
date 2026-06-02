/**
 * Property test for versioned edits.
 *
 * Feature: auxify-ai-platform, Property 25: Versioned edits increment version
 * and retain all prior versions.
 * Validates: Requirements 10.5, 12.4.
 *
 * Versioned editing is a behaviour shared by two implemented services:
 *   - the {@link PromptLibrary} (task 9.3, Req 10.5) — `edit()` increments a
 *     template's version and retains the prior version snapshot; and
 *   - the {@link ArtifactEditor} (task 9.5, Req 12.4) — `applySectionEdit()`
 *     creates a new version and retains prior versions in version history.
 *
 * For ANY initial content followed by ANY sequence of N edits, this drives the
 * *real* services over their in-memory stores (imported directly from each
 * module's `./fakes.js`, never the barrel) and asserts the same invariant for
 * both:
 *
 *   1. MONOTONIC VERSIONS — creation/open establishes version 1, and every edit
 *      advances the head version by exactly 1, so after N edits the head is
 *      version N+1.
 *   2. HISTORY IS A CONTIGUOUS, GAP-FREE PREFIX — the retained history holds
 *      exactly N+1 versions numbered 1, 2, …, N+1 with no gaps or duplicates.
 *   3. EVERY PRIOR VERSION IS RETAINED, UNCHANGED, AND RETRIEVABLE — the content
 *      of version k is the content that was current at version k, and it never
 *      changes (and is never dropped) as later edits are applied.
 *
 * The invariant is checked against an INDEPENDENT oracle built in the test: the
 * expected per-version content list `[initial, edit_1, …, edit_N]`. After every
 * edit the full retained history is re-read and compared to the growing oracle,
 * so any mutation or loss of a prior version is caught immediately.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import {
  CapturingAuditRecorder,
  InMemoryPromptTemplateStore,
  InMemoryPromptVersionStore,
  sequentialPromptIdGenerator,
} from './fakes.js';
import { PromptLibrary } from './prompt-library.js';
import { ArtifactEditor } from '../artifacts/artifact-editor.js';
import {
  CapturingAuditRecorder as ArtifactAuditRecorder,
  InMemoryArtifactStore,
  sequentialArtifactIdGenerator,
} from '../artifacts/fakes.js';
import type { SectionEditor, SectionRef } from '../artifacts/types.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

/**
 * A scenario: the content present at creation/open, followed by the content of
 * each subsequent edit. An empty `edits` array exercises the base case (a freshly
 * created/opened item is already at version 1 with a one-entry history). Content
 * strings are unconstrained (including empty) — versioning must not depend on the
 * shape of the content.
 */
const scenarioArb = fc.record({
  initial: fc.string(),
  edits: fc.array(fc.string(), { maxLength: 10 }),
});

/**
 * Assert the monotonic-version / contiguous-history / prior-versions-retained
 * invariant for a retained history against the oracle `expected` content list.
 * `expected[k]` is the content that must be recorded at version `k + 1`.
 */
function assertHistoryMatches(
  history: { version: number; content: string }[],
  expected: string[],
): void {
  // (2) Exactly one retained version per state (initial + each edit).
  expect(history).toHaveLength(expected.length);
  // (1)+(2) Versions are 1, 2, …, N+1 — contiguous, gap-free, strictly +1.
  expect(history.map((v) => v.version)).toEqual(expected.map((_, idx) => idx + 1));
  // (3) Every prior version's content is retained exactly, in order.
  expect(history.map((v) => v.content)).toEqual(expected);
}

describe('Feature: auxify-ai-platform, Property 25: Versioned edits increment version and retain all prior versions', () => {
  it('Prompt_Library.edit increments the version and retains every prior version (Validates: Requirements 10.5)', async () => {
    const ORG = 'org-prompt';
    const ctx: TenantContext = { organizationId: ORG, userId: 'user-1' };

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ initial, edits }) => {
        const templates = new InMemoryPromptTemplateStore();
        // Every template created in this scenario belongs to ORG, so the parent
        // tenant scope resolves uniformly.
        const versions = new InMemoryPromptVersionStore(() => ORG);
        const audit = new CapturingAuditRecorder();
        const library = new PromptLibrary({
          templates,
          versions,
          audit,
          idGenerator: sequentialPromptIdGenerator(),
        });

        // create() establishes version 1 and seeds its history snapshot.
        const tmpl = await library.create(ctx, { title: 'T', content: initial });
        expect(tmpl.version).toBe(1);

        // Oracle: the content present at each version.
        const expected: string[] = [initial];
        assertHistoryMatches(await library.listVersions(ctx, tmpl.id), expected);

        for (let i = 0; i < edits.length; i += 1) {
          const result = await library.edit(ctx, tmpl.id, edits[i]!);
          expected.push(edits[i]!);

          // (1) The head version advanced by exactly 1.
          expect(result.version).toBe(i + 2);
          expect(result.content).toBe(edits[i]!);

          // (2)+(3) After every edit the full retained history matches the oracle,
          // proving no prior version was mutated, lost, or renumbered.
          assertHistoryMatches(await library.listVersions(ctx, tmpl.id), expected);
        }

        // Final cross-checks: head version equals the retained count, and the
        // history is strictly increasing by 1 with no gaps.
        const finalHistory = await library.listVersions(ctx, tmpl.id);
        expect(finalHistory).toHaveLength(edits.length + 1);
        for (let i = 1; i < finalHistory.length; i += 1) {
          expect(finalHistory[i]!.version - finalHistory[i - 1]!.version).toBe(1);
        }
        const head = await library.get(ctx, tmpl.id);
        expect(head?.version).toBe(edits.length + 1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('Artifact_Editor.applySectionEdit creates a new version and retains every prior version (Validates: Requirements 12.4)', async () => {
    const ORG = 'org-artifact';
    const ctx: TenantContext = { organizationId: ORG, userId: 'user-1' };
    const CONVERSATION = 'conv-1';

    // A passthrough section editor: it sets the artifact's new full content to the
    // edit instruction directly, so the versioning invariant is exercised
    // independently of section-resolution mechanics (covered by the unit tests).
    const sectionEditor: SectionEditor = { edit: ({ instruction }) => instruction };
    // The section reference is irrelevant to the passthrough editor.
    const section: SectionRef = { kind: 'replace', target: 'unused' };

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ initial, edits }) => {
        // Every conversation maps to ORG, so the parent tenant scope resolves.
        const store = new InMemoryArtifactStore(() => ORG);
        const audit = new ArtifactAuditRecorder();
        const editor = new ArtifactEditor({
          artifacts: store,
          audit,
          sectionEditor,
          idGenerator: sequentialArtifactIdGenerator(),
        });

        // open() establishes version 1 and seeds its history snapshot.
        const { artifact } = await editor.open(ctx, {
          conversationId: CONVERSATION,
          type: 'markdown',
          content: initial,
        });
        expect(artifact.version).toBe(1);

        const expected: string[] = [initial];
        assertHistoryMatches(await editor.listVersions(ctx, artifact.id), expected);

        for (let i = 0; i < edits.length; i += 1) {
          const updated = await editor.applySectionEdit(ctx, artifact.id, section, edits[i]!);
          expected.push(edits[i]!);

          // (1) The head version advanced by exactly 1.
          expect(updated.version).toBe(i + 2);
          expect(updated.content).toBe(edits[i]!);

          // (2)+(3) Full retained history matches the oracle after every edit.
          assertHistoryMatches(await editor.listVersions(ctx, artifact.id), expected);

          // (3) Each prior version is individually retrievable and unchanged.
          for (let v = 1; v <= expected.length; v += 1) {
            const got = await editor.getVersion(ctx, artifact.id, v);
            expect(got?.version).toBe(v);
            expect(got?.content).toBe(expected[v - 1]!);
          }
        }

        const finalHistory = await editor.listVersions(ctx, artifact.id);
        expect(finalHistory).toHaveLength(edits.length + 1);
        for (let i = 1; i < finalHistory.length; i += 1) {
          expect(finalHistory[i]!.version - finalHistory[i - 1]!.version).toBe(1);
        }
        const head = await editor.get(ctx, artifact.id);
        expect(head?.version).toBe(edits.length + 1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
