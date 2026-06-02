/**
 * Unit tests for the pure MFA requirement resolution (Req 33.5, 33.6, 33.7).
 *
 * These pin the if-and-only-if behaviour of {@link resolveMfaRequirement} and
 * the {@link hasPrivilegedRole} helper across the individual conditions and
 * their combinations — the exact core Property 51 (task 20.2) generalizes.
 */

import { describe, expect, it } from 'vitest';

import { hasPrivilegedRole, resolveMfaRequirement } from './mfa.js';

describe('resolveMfaRequirement (Req 33.5-33.7)', () => {
  it('does not require MFA when no condition holds', () => {
    const r = resolveMfaRequirement({
      roles: ['standard_user', 'viewer'],
      userMfaEnabled: false,
      orgMfaRequired: false,
    });
    expect(r.required).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('requires MFA when enabled per user (Req 33.5)', () => {
    const r = resolveMfaRequirement({
      roles: ['standard_user'],
      userMfaEnabled: true,
      orgMfaRequired: false,
    });
    expect(r.required).toBe(true);
    expect(r.reasons).toContain('user_enabled');
  });

  it('requires MFA for super_admin and admin (Req 33.6)', () => {
    for (const role of ['super_admin', 'admin'] as const) {
      const r = resolveMfaRequirement({
        roles: [role],
        userMfaEnabled: false,
        orgMfaRequired: false,
      });
      expect(r.required).toBe(true);
      expect(r.reasons).toContain('privileged_role');
    }
  });

  it('requires MFA when the Organization mandates it (Req 33.7)', () => {
    const r = resolveMfaRequirement({
      roles: ['power_user'],
      userMfaEnabled: false,
      orgMfaRequired: true,
    });
    expect(r.required).toBe(true);
    expect(r.reasons).toContain('org_policy');
  });

  it('lists every triggering condition when several hold', () => {
    const r = resolveMfaRequirement({
      roles: ['admin'],
      userMfaEnabled: true,
      orgMfaRequired: true,
    });
    expect(r.required).toBe(true);
    expect(r.reasons).toEqual(['user_enabled', 'privileged_role', 'org_policy']);
  });

  it('hasPrivilegedRole detects only super_admin/admin', () => {
    expect(hasPrivilegedRole(['admin'])).toBe(true);
    expect(hasPrivilegedRole(['super_admin'])).toBe(true);
    expect(hasPrivilegedRole(['power_user', 'standard_user', 'viewer'])).toBe(false);
  });
});
