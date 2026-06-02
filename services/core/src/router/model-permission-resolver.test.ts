/**
 * Unit tests for model permission resolution (Req 3.1, 3.2, 19.5, 19.6, 20.6).
 *
 * These exercise {@link ModelPermissionResolver} against an in-memory
 * {@link FakeModelCatalog}, covering:
 *   - permitted-set computation under viewer / Premium / allowed-list
 *     combinations (Req 19.5, 19.6, 20.6),
 *   - the routable subset excluding unavailable-but-permitted models (Req 2.10),
 *   - routing an explicitly-requested permitted model (Req 3.1),
 *   - rejecting a non-permitted model with an authorization error that names it
 *     (Req 3.2), including the deciding `denialCode` and its PlatformError
 *     projection,
 *   - an unknown model id propagating ModelNotFoundError (distinct from "not
 *     permitted").
 */

import { describe, expect, it } from 'vitest';

import { ModelNotFoundError } from '../providers/index.js';

import { ModelNotAuthorizedError, MODEL_NOT_AUTHORIZED_CODE } from './errors.js';
import { FakeModelCatalog, makeModel, makePrincipal } from './fakes.js';
import { ModelPermissionResolver } from './model-permission-resolver.js';

/** A catalog spanning all three tiers, each model id distinct by tier. */
function tierCatalog(): FakeModelCatalog {
  return new FakeModelCatalog([
    makeModel('economy', { id: 'economy-1' }),
    makeModel('standard', { id: 'standard-1' }),
    makeModel('premium', { id: 'premium-1' }),
  ]);
}

describe('ModelPermissionResolver.permittedModels', () => {
  it('permits all tiers for a Premium-authorized standard user with no allow-list', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const { permitted, routable } = resolver.permittedModels(
      makePrincipal({ premiumAuthorized: true }),
    );

    expect(permitted.map((m) => m.id)).toEqual(['economy-1', 'standard-1', 'premium-1']);
    // All available by default, so routable mirrors permitted.
    expect(routable.map((m) => m.id)).toEqual(['economy-1', 'standard-1', 'premium-1']);
  });

  it('excludes Premium models when the principal lacks Premium authorization (Req 19.5)', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const { permitted } = resolver.permittedModels(makePrincipal({ premiumAuthorized: false }));

    expect(permitted.map((m) => m.id)).toEqual(['economy-1', 'standard-1']);
  });

  it('restricts a viewer to Economy models regardless of Premium authorization (Req 19.6)', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const { permitted } = resolver.permittedModels(
      makePrincipal({ roles: ['viewer'], premiumAuthorized: true }),
    );

    expect(permitted.map((m) => m.id)).toEqual(['economy-1']);
  });

  it('restricts to the per-user allowed-model list when one is assigned (Req 20.6)', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const { permitted } = resolver.permittedModels(
      makePrincipal({ premiumAuthorized: true, allowedModels: ['standard-1'] }),
    );

    expect(permitted.map((m) => m.id)).toEqual(['standard-1']);
  });

  it('combines the allow-list with tier gating (allow-listed Premium still needs authorization)', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    // Premium on the allow-list, but no Premium authorization → still excluded.
    const { permitted } = resolver.permittedModels(
      makePrincipal({ premiumAuthorized: false, allowedModels: ['standard-1', 'premium-1'] }),
    );

    expect(permitted.map((m) => m.id)).toEqual(['standard-1']);
  });

  it('treats an empty allowed-model list as no per-user restriction', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const { permitted } = resolver.permittedModels(
      makePrincipal({ premiumAuthorized: true, allowedModels: [] }),
    );

    expect(permitted.map((m) => m.id)).toEqual(['economy-1', 'standard-1', 'premium-1']);
  });

  it('keeps unavailable-but-permitted models in permitted but out of routable (Req 2.10)', () => {
    const catalog = new FakeModelCatalog([
      makeModel('economy', { id: 'economy-1', available: true }),
      makeModel('standard', { id: 'standard-1', available: false }),
    ]);
    const resolver = new ModelPermissionResolver(catalog);
    const { permitted, routable } = resolver.permittedModels(makePrincipal());

    expect(permitted.map((m) => m.id)).toEqual(['economy-1', 'standard-1']);
    expect(routable.map((m) => m.id)).toEqual(['economy-1']);
  });

  it('preserves catalog listing order in the permitted set', () => {
    const catalog = new FakeModelCatalog([
      makeModel('economy', { id: 'c' }),
      makeModel('economy', { id: 'a' }),
      makeModel('economy', { id: 'b' }),
    ]);
    const resolver = new ModelPermissionResolver(catalog);
    expect(resolver.permittedModels(makePrincipal()).permitted.map((m) => m.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

describe('ModelPermissionResolver.routeExplicit', () => {
  it('routes to an explicitly-requested permitted model (Req 3.1)', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const decision = resolver.routeExplicit(makePrincipal(), 'economy-1');

    expect(decision.mode).toBe('explicit');
    expect(decision.model.id).toBe('economy-1');
    expect(typeof decision.reason).toBe('string');
  });

  it('rejects a non-permitted Premium model with an error that names it (Req 3.2)', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const principal = makePrincipal({ premiumAuthorized: false });

    expect(() => resolver.routeExplicit(principal, 'premium-1')).toThrow(ModelNotAuthorizedError);

    try {
      resolver.routeExplicit(principal, 'premium-1');
      expect.unreachable('expected ModelNotAuthorizedError');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelNotAuthorizedError);
      const e = error as ModelNotAuthorizedError;
      expect(e.modelId).toBe('premium-1');
      expect(e.message).toContain('premium-1');
      expect(e.denialCode).toBe('premium_unauthorized');
    }
  });

  it('rejects a non-Economy model for a viewer, naming the model (Req 3.2, 19.6)', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const viewer = makePrincipal({ roles: ['viewer'] });

    try {
      resolver.routeExplicit(viewer, 'standard-1');
      expect.unreachable('expected ModelNotAuthorizedError');
    } catch (error) {
      const e = error as ModelNotAuthorizedError;
      expect(e.modelId).toBe('standard-1');
      expect(e.denialCode).toBe('viewer_model_restricted');
    }
  });

  it('rejects a model outside the per-user allow-list, naming the model (Req 3.2, 20.6)', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const principal = makePrincipal({ allowedModels: ['economy-1'] });

    try {
      resolver.routeExplicit(principal, 'standard-1');
      expect.unreachable('expected ModelNotAuthorizedError');
    } catch (error) {
      const e = error as ModelNotAuthorizedError;
      expect(e.modelId).toBe('standard-1');
      expect(e.denialCode).toBe('model_not_allowed');
    }
  });

  it('routes to a permitted model even when it is currently unavailable (permission != health)', () => {
    const catalog = new FakeModelCatalog([makeModel('economy', { id: 'economy-1', available: false })]);
    const resolver = new ModelPermissionResolver(catalog);

    const decision = resolver.routeExplicit(makePrincipal(), 'economy-1');
    expect(decision.model.id).toBe('economy-1');
  });

  it('propagates ModelNotFoundError for an unknown model id (distinct from not-permitted)', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    expect(() => resolver.routeExplicit(makePrincipal(), 'does-not-exist')).toThrow(
      ModelNotFoundError,
    );
  });
});

describe('ModelPermissionResolver.isPermitted', () => {
  it('agrees with the permitted set membership', () => {
    const resolver = new ModelPermissionResolver(tierCatalog());
    const principal = makePrincipal({ premiumAuthorized: false });

    expect(resolver.isPermitted(principal, makeModel('economy', { id: 'economy-1' }))).toBe(true);
    expect(resolver.isPermitted(principal, makeModel('premium', { id: 'premium-1' }))).toBe(false);
  });
});

describe('ModelNotAuthorizedError.toPlatformError', () => {
  it('projects to an authorization PlatformError naming the model (Req 3.2, 46.8)', () => {
    const error = new ModelNotAuthorizedError(
      'premium-1',
      'Premium model "premium-1" requires explicit Premium authorization',
      'premium_unauthorized',
    );
    const platformError = error.toPlatformError('corr-123');

    expect(platformError.category).toBe('authorization');
    expect(platformError.code).toBe(MODEL_NOT_AUTHORIZED_CODE);
    expect(platformError.correlationId).toBe('corr-123');
    expect(platformError.retriable).toBe(false);
    expect(platformError.message).toContain('premium-1');
    expect(platformError.details).toEqual({
      modelId: 'premium-1',
      denialCode: 'premium_unauthorized',
    });
  });
});
