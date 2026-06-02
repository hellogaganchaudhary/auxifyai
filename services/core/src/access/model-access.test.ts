/**
 * Unit tests for the reusable model-access gates (Req 19.5, 19.6, 20.6).
 *
 * These exercise {@link checkModelAccess} directly — the pure helper that
 * Access_Control and the Model_Router (task 6.1) both compose — covering the
 * viewer→Economy restriction, the Premium-authorization requirement, the
 * per-user allowed-model Allow_List, and the order in which the gates apply.
 */

import { describe, expect, it } from 'vitest';

import { makeModel, makePrincipal } from './fakes.js';
import { checkModelAccess, isViewer } from './model-access.js';

describe('isViewer', () => {
  it('detects the viewer role among a principal\u2019s roles (Req 19.1)', () => {
    expect(isViewer(makePrincipal({ roles: ['viewer'] }))).toBe(true);
    expect(isViewer(makePrincipal({ roles: ['standard_user'] }))).toBe(false);
    // A user holding viewer alongside another role is still gated as a viewer.
    expect(isViewer(makePrincipal({ roles: ['standard_user', 'viewer'] }))).toBe(true);
  });
});

describe('checkModelAccess', () => {
  it('permits an Economy model for a standard user with no allowed-model list', () => {
    const result = checkModelAccess(makePrincipal(), makeModel('economy'));
    expect(result.allowed).toBe(true);
    expect(result.denialCode).toBeUndefined();
  });

  it('permits a Standard model for a standard user (Premium gate does not apply)', () => {
    const result = checkModelAccess(makePrincipal(), makeModel('standard'));
    expect(result.allowed).toBe(true);
  });

  // --- Viewer restriction (Req 19.6) ---

  it('restricts a viewer to Economy models', () => {
    const viewer = makePrincipal({ roles: ['viewer'] });
    expect(checkModelAccess(viewer, makeModel('economy')).allowed).toBe(true);

    const standard = checkModelAccess(viewer, makeModel('standard'));
    expect(standard.allowed).toBe(false);
    expect(standard.denialCode).toBe('viewer_model_restricted');

    const premium = checkModelAccess(viewer, makeModel('premium'));
    expect(premium.allowed).toBe(false);
    expect(premium.denialCode).toBe('viewer_model_restricted');
  });

  it('applies the viewer restriction before the Premium gate', () => {
    // A viewer with Premium authorization is still restricted to Economy.
    const viewer = makePrincipal({ roles: ['viewer'], premiumAuthorized: true });
    const result = checkModelAccess(viewer, makeModel('premium'));
    expect(result.allowed).toBe(false);
    expect(result.denialCode).toBe('viewer_model_restricted');
  });

  // --- Premium authorization (Req 19.5) ---

  it('denies a Premium model when the principal lacks Premium authorization', () => {
    const result = checkModelAccess(
      makePrincipal({ premiumAuthorized: false }),
      makeModel('premium'),
    );
    expect(result.allowed).toBe(false);
    expect(result.denialCode).toBe('premium_unauthorized');
  });

  it('permits a Premium model when the principal has Premium authorization', () => {
    const result = checkModelAccess(
      makePrincipal({ premiumAuthorized: true }),
      makeModel('premium'),
    );
    expect(result.allowed).toBe(true);
  });

  // --- Per-user allowed-model Allow_List (Req 20.6) ---

  it('restricts access to the principal\u2019s allowed-model list when one is assigned', () => {
    const principal = makePrincipal({ allowedModels: ['model-economy'] });
    expect(checkModelAccess(principal, makeModel('economy')).allowed).toBe(true);

    const other = checkModelAccess(principal, makeModel('standard'));
    expect(other.allowed).toBe(false);
    expect(other.denialCode).toBe('model_not_allowed');
  });

  it('treats an empty allowed-model list as "no per-user restriction"', () => {
    const principal = makePrincipal({ allowedModels: [] });
    expect(checkModelAccess(principal, makeModel('standard')).allowed).toBe(true);
  });

  it('applies the Premium gate before the allowed-model list', () => {
    // Premium model present on the allowed list but no Premium authorization →
    // Premium gate denies first.
    const principal = makePrincipal({
      premiumAuthorized: false,
      allowedModels: ['model-premium'],
    });
    const result = checkModelAccess(principal, makeModel('premium'));
    expect(result.allowed).toBe(false);
    expect(result.denialCode).toBe('premium_unauthorized');
  });
});
