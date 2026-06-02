/**
 * Property test for Prompt_Library visibility scoping.
 *
 * Feature: auxify-ai-platform, Property 26: Prompt template visibility scoping.
 * Validates: Requirements 10.2, 10.3.
 *
 * Design statement (Property 26): "For any prompt template, a template marked
 * public is accessible to exactly the members of its owning Organization, and a
 * template marked personal is accessible to exactly its owner."
 *
 * For ANY arbitrary population of prompt templates spread across several
 * Organizations and owners with arbitrary public/personal visibility, this
 * drives the *real* {@link PromptLibrary} (created through `create`, then
 * queried through `listVisibleTo` and `getForUser`) over the in-memory
 * {@link InMemoryPromptTemplateStore} and asserts, for every (Organization,
 * user) viewer, the exact visibility set:
 *
 *   - a PUBLIC template is visible to a viewer IFF the viewer is in the
 *     template's owning Organization — to every member of that Org, and never
 *     across an Organization boundary (Req 10.2); and
 *   - a PERSONAL template is visible to a viewer IFF the viewer IS its owner
 *     (same Organization AND same user id) — never to any other user, whether
 *     in the same Organization or another one (Req 10.3).
 *
 * Both access paths are checked: membership of `listVisibleTo` (the listing
 * path) and the result of `getForUser` (the single-template get path) must each
 * agree with the same independent oracle. Comparing against an oracle
 * re-derived here (not imported from the module) means the test does not assert
 * the implementation against itself. The viewer set is the full cartesian
 * product of the Organization pool and the user pool, so cross-Org and
 * cross-user denials are always exercised.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import {
  CapturingAuditRecorder,
  InMemoryPromptTemplateStore,
  InMemoryPromptVersionStore,
} from './fakes.js';
import { PromptLibrary } from './prompt-library.js';
import type { PromptVisibility } from './types.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

/** The Organization pool the generated templates and viewers are drawn from. */
const ORGS = ['org-A', 'org-B', 'org-C'] as const;
/** The user pool the owners and viewers are drawn from. */
const USERS = ['user-1', 'user-2', 'user-3', 'user-4'] as const;

/** The per-template generated spec; ids are assigned per index. */
interface TemplateSpec {
  ownerId: string;
  organizationId: string;
  visibility: PromptVisibility;
}

const templateSpecArb: fc.Arbitrary<TemplateSpec> = fc.record({
  ownerId: fc.constantFrom(...USERS),
  organizationId: fc.constantFrom(...ORGS),
  visibility: fc.constantFrom<PromptVisibility>('public', 'personal'),
});

/** A population of up to 24 templates with arbitrary owners/orgs/visibility. */
const populationArb = fc.array(templateSpecArb, { maxLength: 24 });

/** A fully-materialized template: its spec plus the id assigned to it. */
interface SeededTemplate extends TemplateSpec {
  id: string;
}

/**
 * The independent visibility oracle: is template `t` accessible to the viewer
 * `(viewerOrg, viewerUser)`? Public templates are visible to exactly the
 * members (same-Org users) of the owning Organization; personal templates are
 * visible to exactly their owner. Re-derived here, not imported.
 */
function oracleVisible(t: SeededTemplate, viewerOrg: string, viewerUser: string): boolean {
  if (t.organizationId !== viewerOrg) return false;
  if (t.visibility === 'public') return true;
  return t.ownerId === viewerUser;
}

describe('Feature: auxify-ai-platform, Property 26: Prompt template visibility scoping', () => {
  it('exposes a public template to exactly its Organization and a personal template to exactly its owner, via both list and get (Validates: Requirements 10.2, 10.3)', async () => {
    await fc.assert(
      fc.asyncProperty(populationArb, async (specs) => {
        // Assign a unique id per generated template.
        const templates: SeededTemplate[] = specs.map((spec, i) => ({
          ...spec,
          id: `tmpl-${i}`,
        }));

        // Resolver mirroring the parent-tenant scope the version store enforces
        // when create() seeds version 1: a template id maps to its owning Org.
        const orgById = new Map(templates.map((t) => [t.id, t.organizationId]));

        const store = new InMemoryPromptTemplateStore();
        const versions = new InMemoryPromptVersionStore((id) => orgById.get(id));
        const audit = new CapturingAuditRecorder();
        const library = new PromptLibrary({ templates: store, versions, audit });

        // Create every template through the real service, scoped to its Org and
        // owner, with the generated visibility.
        for (const t of templates) {
          const ctx: TenantContext = { organizationId: t.organizationId, userId: t.ownerId };
          await library.create(
            ctx,
            { id: t.id, title: `Title ${t.id}`, content: `Body ${t.id}`, visibility: t.visibility },
            t.ownerId,
          );
        }

        // Check every (Organization, user) viewer — the full cartesian product,
        // so cross-Org and cross-user cases are always covered.
        for (const viewerOrg of ORGS) {
          for (const viewerUser of USERS) {
            const ctx: TenantContext = { organizationId: viewerOrg, userId: viewerUser };

            // Oracle: exactly the ids this viewer should see.
            const expectedIds = new Set(
              templates.filter((t) => oracleVisible(t, viewerOrg, viewerUser)).map((t) => t.id),
            );

            // (1) Listing path: listVisibleTo returns EXACTLY the expected ids —
            // none missing (completeness) and none extra (soundness, including
            // no cross-Org or other-owner leakage).
            const listed = await library.listVisibleTo(ctx, viewerUser);
            const listedIds = new Set(listed.map((p) => p.id));
            expect(listedIds).toEqual(expectedIds);

            // Every listed row genuinely belongs to the viewer's Organization
            // and is either public or owned by the viewer.
            for (const p of listed) {
              expect(p.organizationId).toBe(viewerOrg);
              expect(p.visibility === 'public' || p.ownerId === viewerUser).toBe(true);
            }

            // (2) Get path: getForUser agrees with the oracle for EVERY template,
            // returning it when visible and null otherwise.
            for (const t of templates) {
              const got = await library.getForUser(ctx, t.id, viewerUser);
              if (oracleVisible(t, viewerOrg, viewerUser)) {
                expect(got).not.toBeNull();
                expect(got?.id).toBe(t.id);
              } else {
                expect(got).toBeNull();
              }
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
