/**
 * Feature: auxify-ai-platform, Property 11: Model access is permitted exactly
 * within the user's tier-gated permitted set.
 *
 * Validates: Requirements 3.1, 3.2, 19.5, 19.6, 20.6
 *
 * A user may use a model *if and only if* that model survives every tier/role
 * gate the platform composes:
 *   - a `viewer` is restricted to Economy models (Req 19.6),
 *   - a Premium-tier model requires explicit Premium authorization (Req 19.5),
 *   - and, when an administrator has assigned a per-user allowed-model
 *     Allow_List, the model must be on it — an empty list does not restrict
 *     (Req 20.6).
 *
 * This pins down the biconditional for the {@link ModelPermissionResolver}
 * (task 6.1) against an INDEPENDENT oracle that restates Req 19.5/19.6/20.6
 * directly, over arbitrary principals (arbitrary roles, Premium authorization,
 * allow-lists) and arbitrary catalogs (arbitrary tiers). It asserts three faces
 * of the same property:
 *   1. `isPermitted` agrees with the oracle on every model (the gate itself),
 *   2. `permittedModels(...).permitted` is EXACTLY the oracle-permitted models,
 *      in catalog order (soundness + completeness — no extra, none missing),
 *   3. `routeExplicit` routes a permitted model to itself (Req 3.1) and rejects
 *      a non-permitted one with a {@link ModelNotAuthorizedError} that NAMES it
 *      (Req 3.2) — the thrown error's `modelId` and message both carry the id.
 *
 * The fakes ({@link FakeModelCatalog}, {@link makeModel}, {@link makePrincipal})
 * are the same doubles the resolver's unit suite and the shared
 * `checkModelAccess` gate were tested against, so the property is checked
 * against the real production composition, not a re-implementation.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MODEL_TIERS, ROLES, type ModelInfo, type Principal } from '@auxify/types';

import { ModelNotAuthorizedError } from './errors.js';
import { FakeModelCatalog, makeModel, makePrincipal } from './fakes.js';
import { ModelPermissionResolver } from './model-permission-resolver.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Independent oracle: a from-scratch restatement of Req 19.5/19.6/20.6.
//
// This deliberately does NOT call checkModelAccess — it re-derives permission
// straight from the requirements so the test can detect drift in the gate.
// ---------------------------------------------------------------------------

/**
 * Whether `principal` may use `model` per the three tier/role gates, computed
 * independently of the production code under test.
 */
function oraclePermitted(principal: Principal, model: ModelInfo): boolean {
  const isViewer = principal.roles.includes('viewer');

  // Req 19.6: a viewer is restricted to Economy models.
  if (isViewer && model.tier !== 'economy') {
    return false;
  }
  // Req 19.5: Premium-tier models require explicit Premium authorization.
  if (model.tier === 'premium' && !principal.premiumAuthorized) {
    return false;
  }
  // Req 20.6: a non-empty per-user allow-list restricts to exactly its members;
  // an empty list imposes no per-user restriction.
  if (principal.allowedModels.length > 0 && !principal.allowedModels.includes(model.id)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/**
 * An arbitrary scenario: a principal (arbitrary role subset that may or may not
 * include `viewer`, arbitrary Premium authorization, an allow-list drawn from
 * the catalog's ids or empty) paired with a catalog of distinctly-identified
 * models spanning arbitrary tiers and availability.
 */
const scenarioArb = fc
  .record({
    roles: fc.subarray([...ROLES]),
    premiumAuthorized: fc.boolean(),
    // Each spec becomes one catalog model; index gives it a unique id.
    modelSpecs: fc.array(
      fc.record({
        tier: fc.constantFrom(...MODEL_TIERS),
        available: fc.boolean(),
      }),
      { minLength: 1, maxLength: 8 },
    ),
  })
  .chain((base) => {
    const ids = base.modelSpecs.map((_, i) => `model-${i}`);
    return fc.record({
      roles: fc.constant(base.roles),
      premiumAuthorized: fc.constant(base.premiumAuthorized),
      models: fc.constant(
        base.modelSpecs.map((spec, i) =>
          makeModel(spec.tier, { id: ids[i], available: spec.available }),
        ),
      ),
      // allowedModels: a subset of the catalog ids (subarray includes the empty list).
      allowedModels: fc.subarray(ids),
    });
  });

// ---------------------------------------------------------------------------
// Property 11.
// ---------------------------------------------------------------------------

describe("Feature: auxify-ai-platform, Property 11: Model access is permitted exactly within the user's tier-gated permitted set", () => {
  it('permits a model IFF it passes every tier/role gate, and routes/rejects accordingly (Validates: Requirements 3.1, 3.2, 19.5, 19.6, 20.6)', () => {
    fc.assert(
      fc.property(scenarioArb, ({ roles, premiumAuthorized, models, allowedModels }) => {
        const principal = makePrincipal({ roles, premiumAuthorized, allowedModels });
        const resolver = new ModelPermissionResolver(new FakeModelCatalog(models));

        // (1) The gate: isPermitted matches the independent oracle on every model.
        for (const model of models) {
          expect(resolver.isPermitted(principal, model)).toBe(oraclePermitted(principal, model));
        }

        // (2) The set: permitted is EXACTLY the oracle-permitted models, in
        //     catalog order (soundness + completeness), and routable is exactly
        //     the available subset of permitted.
        const expectedPermittedIds = models
          .filter((m) => oraclePermitted(principal, m))
          .map((m) => m.id);
        const expectedRoutableIds = models
          .filter((m) => oraclePermitted(principal, m) && m.available)
          .map((m) => m.id);

        const { permitted, routable } = resolver.permittedModels(principal);
        expect(permitted.map((m) => m.id)).toEqual(expectedPermittedIds);
        expect(routable.map((m) => m.id)).toEqual(expectedRoutableIds);

        // (3) routeExplicit: route IFF permitted.
        for (const model of models) {
          if (oraclePermitted(principal, model)) {
            // Req 3.1: a permitted, explicitly-named model routes to itself.
            const decision = resolver.routeExplicit(principal, model.id);
            expect(decision.mode).toBe('explicit');
            expect(decision.model.id).toBe(model.id);
          } else {
            // Req 3.2: a non-permitted model is rejected with an error that NAMES it.
            let thrown: unknown;
            try {
              resolver.routeExplicit(principal, model.id);
            } catch (error) {
              thrown = error;
            }
            expect(thrown).toBeInstanceOf(ModelNotAuthorizedError);
            const e = thrown as ModelNotAuthorizedError;
            expect(e.modelId).toBe(model.id);
            expect(e.message).toContain(model.id);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
